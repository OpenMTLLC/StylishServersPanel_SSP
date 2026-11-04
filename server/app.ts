import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase, digest, passwordHash, verifyPassword } from './db.js';
import { ApiError, requireValue, text, makeDemo, loadServer, saveServer, audit, pruneActivities, activityList, iso } from './domain.js';
import { adapterRequest, probeSsh, inspectExistingServer, createInstallPlan, runInstallation, bootstrapBridge } from './adapters.js';
import { catalogProviders, searchCatalog, type CatalogProvider } from './catalog.js';
import { installExistingMods, removeExistingMod } from './existing-mods.js';

type Handler = (req: Request, res: Response) => unknown;
const asyncRoute = (fn: Handler) => (req: Request,res: Response,next: NextFunction) => Promise.resolve().then(()=>fn(req,res)).catch(next);
const param = (req: Request,name='id') => String(req.params[name]);
const secretText = (value:unknown,name:string,min=1,max=1024) => {requireValue(typeof value==='string'&&value.length>=min&&value.length<=max,`${name} geçerli olmalı (${min}–${max} karakter).`);return value;};
const normalizedSlots=(slots:any[])=>slots.map(s=>({slot:s.slot,item:s.item,count:s.count,data:s.data??null})).sort((a,b)=>a.slot-b.slot);
function adapterFailure(error:unknown,secrets:any={}):never {let message=error instanceof Error?error.message:'Uzak sunucu işlemi tamamlanamadı.';for(const value of [secrets.bridgeToken,secrets.password,secrets.privateKey,secrets.curseforgeApiKey,secrets.apiKey,secrets.connection?.password,secrets.connection?.privateKey,process.env.SSP_CURSEFORGE_API_KEY])if(typeof value==='string'&&value)message=message.split(value).join('[gizlendi]');throw new ApiError(502,message.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300));}
type AppServices={inspectExistingServer?:(connection:any,options:any)=>Promise<any>;probeSsh?:(connection:any)=>Promise<any>;createInstallPlan?:(options:any)=>Promise<any>};
export function createApp(options: {dataDir?: string;services?:AppServices} = {}) {
  const store = openDatabase(options.dataDir ?? process.env.SSP_DATA_DIR ?? resolve('data'));
  const app = express();
  const inspect=options.services?.inspectExistingServer??inspectExistingServer;
  const probe=options.services?.probeSsh??probeSsh;
  const preparePlan=options.services?.createInstallPlan??createInstallPlan;
  app.disable('x-powered-by');
  app.locals.store = store;
  const sweep=()=>{const rows:any[]=store.db.prepare('SELECT id,data FROM servers').all() as any[];for(const row of rows){try{const days=JSON.parse(row.data).server.retentionDays;pruneActivities(store,row.id,Number.isInteger(days)&&days>=7&&days<=365?days:90);}catch{}}store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());};
  sweep();const retentionTimer=setInterval(sweep,60*60*1000);retentionTimer.unref();app.locals.close=()=>{clearInterval(retentionTimer);store.close();};
  app.use((_req,res,next)=> { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','same-origin'); res.setHeader('Cache-Control','no-store'); next(); });
  app.use(express.json({limit:'1mb'}));
  const buckets = new Map<string,{count:number,until:number}>();
  app.use('/api',(req,res,next)=> {
    const key=`${req.ip}:${req.path.startsWith('/auth')||req.path==='/demo'?'auth':'api'}`;
    const now=Date.now(); const bucket=buckets.get(key);
    if (!bucket || bucket.until<now) buckets.set(key,{count:1,until:now+60000});
    else { bucket.count++; if(bucket.count>(key.endsWith(':auth')?30:600)) return res.status(429).json({error:'Çok fazla istek. Bir dakika sonra yeniden deneyin.'}); }
    if(buckets.size>10000) for(const [id,b] of buckets) if(b.until<now) buckets.delete(id);
    if(!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const origin=req.get('origin');
      if(origin) { let allowed=false; try { const parsed=new URL(origin); allowed=parsed.host===req.get('host') || parsed.origin===process.env.SSP_ORIGIN; } catch {} if(!allowed)return res.status(403).json({error:'İstek kaynağına izin verilmiyor.'}); }
      if(req.get('content-type') && !/^application\/json(?:\s*;|$)/i.test(req.get('content-type')!))return res.status(415).json({error:'JSON içerik gerekli.'});
    }
    next();
  });
  function current(req: Request) {
    const raw=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('ssp_session='))?.slice(12);
    if(!raw || !/^[a-f0-9]{64}$/.test(raw))return null;
    const session:any=store.db.prepare('SELECT s.*,u.id,u.username,u.demo FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?').get(digest(raw),Date.now());
    return session ? {user:{id:session.id,username:session.username,demo:!!session.demo},csrfToken:session.csrf,tokenHash:session.token_hash}:null;
  }
  function newSession(res: Response,user: any) {
    const token=randomBytes(32).toString('hex'); const csrfToken=randomBytes(32).toString('hex');
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    store.db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)').run(digest(token),user.id,csrfToken,Date.now()+86400000);
    res.cookie('ssp_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.SSP_SECURE_COOKIE==='true',maxAge:86400000,path:'/'});
    return {user:{id:user.id,username:user.username,demo:!!user.demo},csrfToken};
  }
  function redeem(userId: string,code: unknown) {
    requireValue(typeof code==='string'&&/^[a-f0-9]{48}$/.test(code),'Davet kodu 48 karakter olmalı.');
    const invite:any=store.db.prepare('SELECT * FROM invites WHERE code_hash=? AND expires>? AND revoked=0 AND redeemed_by IS NULL').get(digest(code),Date.now());
    requireValue(invite,'Davet kodu geçersiz, kullanılmış veya süresi dolmuş.',404);
    const existing:any=store.db.prepare('SELECT role FROM members WHERE server_id=? AND user_id=?').get(invite.server_id,userId);
    requireValue(!existing,'Bu sunucuya zaten erişiminiz var.',409);
    store.db.exec('BEGIN IMMEDIATE');
    try { store.db.prepare('INSERT INTO members(server_id,user_id,role) VALUES(?,?,?)').run(invite.server_id,userId,invite.role); const result=store.db.prepare('UPDATE invites SET redeemed_by=? WHERE id=? AND redeemed_by IS NULL').run(userId,invite.id); requireValue(result.changes===1,'Davet kodu kullanılmış.',409); store.db.exec('COMMIT'); } catch(error) { store.db.exec('ROLLBACK'); throw error; }
    return invite.server_id;
  }
  app.get('/api/health',(_req,res)=>res.json({ok:true,application:'SSP'}));
  app.get('/api/session',(req,res)=> { const session=current(req); if(session)res.json({user:session.user,csrfToken:session.csrfToken}); else res.status(401).json({needsSetup:!(store.db.prepare('SELECT id FROM users WHERE demo=0 LIMIT 1').get())}); });
  app.post('/api/auth/register',asyncRoute((req,res)=> {
    const username=text(req.body?.username,'Kullanıcı adı',32,3); requireValue(/^[\p{L}\p{N}_ .-]+$/u.test(username),'Kullanıcı adı geçersiz.');
    const password=secretText(req.body?.password,'Parola',10,128);
    const first=!store.db.prepare('SELECT id FROM users WHERE demo=0 LIMIT 1').get();
    if(!first)requireValue(typeof req.body.code==='string'&&/^[a-f0-9]{48}$/.test(req.body.code),'Yeni hesap için bir sunucu davet kodu gerekli.',403);
    requireValue(!store.db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username),'Bu kullanıcı adı kullanılıyor.',409);
    if(!first)requireValue(store.db.prepare('SELECT i.id FROM invites i JOIN servers s ON s.id=i.server_id WHERE i.code_hash=? AND i.expires>? AND i.revoked=0 AND i.redeemed_by IS NULL AND json_extract(s.data,\'$.server.demo\')=0').get(digest(req.body.code),Date.now()),'Davet kodu geçersiz. Gerçek hesap için gerçek bir sunucu daveti gerekli.',400);
    const user={id:randomUUID(),username,demo:false}; store.db.prepare('INSERT INTO users(id,username,password) VALUES(?,?,?)').run(user.id,username,passwordHash(password));
    if(!first) { try{redeem(user.id,req.body.code);}catch(error){store.db.prepare('DELETE FROM users WHERE id=?').run(user.id);throw error;} }
    res.status(201).json(newSession(res,user));
  }));
  app.post('/api/auth/login',asyncRoute((req,res)=> {
    const username=text(req.body?.username,'Kullanıcı adı',32); const password=secretText(req.body?.password,'Parola',1,128);
    const user:any=store.db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE AND demo=0').get(username);
    const valid=verifyPassword(password,user?.password??'00000000000000000000000000000000:'+ '00'.repeat(64));
    requireValue(user&&valid,'Kullanıcı adı veya parola hatalı.',401); res.json(newSession(res,user));
  }));
  app.post('/api/demo',asyncRoute((req,res)=> {
    let session=current(req);
    if(session)requireValue(req.get('x-csrf-token')===session.csrfToken,'Oturum doğrulaması başarısız.',403);
    if(!session) { const user={id:randomUUID(),username:`Demo_${randomBytes(4).toString('hex')}`,demo:true}; store.db.prepare('INSERT INTO users(id,username,password,demo) VALUES(?,?,?,1)').run(user.id,user.username,passwordHash(randomBytes(32).toString('hex'))); const auth=newSession(res,user); session={...auth,tokenHash:''}; }
    const existing:any=store.db.prepare('SELECT s.id FROM servers s JOIN members m ON m.server_id=s.id WHERE m.user_id=? AND s.data LIKE ? LIMIT 1').get(session.user.id,'%"demo":true%');
    let serverId=existing?.id;
    if(!serverId) { for(const [index,name] of ['Survival • Ana Dünya','Creative • Yapı Atölyesi'].entries()) { const data=makeDemo(name); if(index){data.server.status='stopped'; data.players=data.players.map(p=>({...p,online:false}));data.metrics.cpu=0;data.metrics.memory=0;data.metrics.tps=0;} store.db.prepare('INSERT INTO servers(id,owner_id,data,secrets) VALUES(?,?,?,?)').run(data.server.id,session.user.id,JSON.stringify(data),store.encrypt({})); store.db.prepare('INSERT INTO members(server_id,user_id,role) VALUES(?,?,?)').run(data.server.id,session.user.id,'owner'); audit(store,data.server.id,session.user,'demo.created','Örnek sunucu oluşturuldu.'); if(!serverId)serverId=data.server.id; } }
    res.json({user:session.user,csrfToken:session.csrfToken,serverId});
  }));
  app.use('/api',(req,res,next)=> { const session=current(req); if(!session)return res.status(401).json({error:'Devam etmek için giriş yapın.'}); if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.get('x-csrf-token')!==session.csrfToken)return res.status(403).json({error:'Oturum doğrulaması başarısız. Sayfayı yenileyin.'}); res.locals.auth=session;next(); });
  app.post('/api/auth/logout',(req,res)=> {store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(res.locals.auth.tokenHash);res.clearCookie('ssp_session',{path:'/'});res.json({ok:true});});
  function serverContext(req:Request,res:Response,role='viewer') {return loadServer(store,param(req),res.locals.auth.user.id,role);}
  function publicServer(data:any,role:string) { const {server}=data; return {...server,permissions:role,curseforgeConfigured:!!(server.curseforgeConfigured||process.env.SSP_CURSEFORGE_API_KEY)}; }
  function remote(context:any,path:string,method='GET',body?:any) {requireValue(context.secrets.bridgeToken,'Bu işlem için mevcut sunucunuzu yeniden kurmadan SSP oyun köprüsünü bağlayın. Bağlantıyı Ayarlar bölümünden ekleyebilirsiniz.',409);return adapterRequest({...context.data.server,secrets:context.secrets},path,method,body).catch(error=>adapterFailure(error,context.secrets));}
  function connectionInput(input:any,bridgePort=8765) {
    requireValue(input&&typeof input==='object','SSH bağlantısı gerekli.');
    const connection={host:text(input.host,'SSH adresi',253),port:Number(input.port??22),username:text(input.username,'SSH kullanıcı adı',64),password:input.password?secretText(input.password,'SSH parolası',1,1024):undefined,privateKey:input.privateKey?secretText(input.privateKey,'SSH özel anahtarı',1,32768):undefined,hostFingerprint:text(input.hostFingerprint,'SSH parmak izi',128),bridgePort:Number(input.bridgePort??bridgePort)};
    requireValue(Number.isInteger(connection.port)&&connection.port>0&&connection.port<=65535,'SSH portu geçersiz.');
    requireValue(Number.isInteger(connection.bridgePort)&&connection.bridgePort>0&&connection.bridgePort<=65535,'Köprü portu geçersiz.');
    requireValue(connection.password||connection.privateKey,'SSH parolası veya özel anahtar gerekli.');return connection;
  }
  const gameAddress=(host:string,port:unknown)=>`${host.includes(':')&&!host.startsWith('[')?`[${host}]`:host}${Number.isInteger(port)&&Number(port)>0&&Number(port)<=65535?`:${port}`:''}`;
  function selectedDiscovery(scan:any,host:string) {
    const candidate=scan?.directory?scan:scan?.candidates?.length===1?scan.candidates[0]:null;
    requireValue(candidate?.directory,'Sunucu dizini tekil olarak belirlenemedi. Bulunan dizinlerden birini seçin veya oyun sunucusunun dizinini yazın.',409);
    requireValue(['minecraft','valheim','terraria','rust'].includes(candidate.game),'Seçilen dizinde desteklenen bir oyun sunucusu belirlenemedi.',422);
    return {...candidate,address:gameAddress(host,candidate.port),source:'ssh-discovery',observedAt:scan.observedAt??iso(),machine:scan.machine??{},warnings:[...(scan.warnings??[]),...(candidate===scan?[]:candidate.warnings??[])],status:['running','stopped','unknown'].includes(candidate.status)?candidate.status:'unknown'};
  }
  async function refreshDiscovery(context:any,user:any,auditAction=true) {
    const directory=context.secrets.directory??context.data.server.directory??context.data.install?.plan?.directory;
    requireValue(directory,'Bu sunucunun uzak dizini kayıtlı değil. Mevcut sunucuyu SSH taramasıyla ekleyin.',409);
    const discovery=selectedDiscovery(await inspect(context.secrets.connection,{directory}).catch(error=>adapterFailure(error,context.secrets)),context.secrets.connection.host);
    const latest=loadServer(store,context.data.server.id,user.id,'operator');latest.data.discovery=discovery;latest.data.mods=discovery.mods??[];latest.data.server.status=discovery.status;latest.data.server.address=discovery.address;latest.data.server.edition=discovery.edition??'unknown';latest.data.server.version=discovery.version??'unknown';latest.data.server.maxPlayers=discovery.maxPlayers??null;saveServer(store,latest.data.server.id,latest.data);
    if(auditAction)audit(store,latest.data.server.id,user,'server.inspect','Mevcut sunucu SSH üzerinden salt okunur olarak tarandı.');return discovery;
  }
  const mutationLocks=new Set<string>();
  app.use('/api/servers/:id',(req,res,next)=>{if(['GET','HEAD','OPTIONS'].includes(req.method))return next();const id=param(req);if(mutationLocks.has(id))return res.status(409).json({error:'Bu sunucuda başka bir işlem sürüyor. Yeniden deneyin.'});mutationLocks.add(id);let released=false;const release=()=>{if(!released){released=true;mutationLocks.delete(id);}};res.once('finish',release);res.once('close',release);next();});
  app.get('/api/servers',(_req,res)=> { const rows:any[]=store.db.prepare('SELECT s.data,m.role FROM servers s JOIN members m ON m.server_id=s.id WHERE m.user_id=? ORDER BY s.rowid').all(res.locals.auth.user.id) as any[];res.json(rows.map(row=>publicServer(JSON.parse(row.data),row.role))); });
  app.post('/api/connections/probe',asyncRoute(async(req,res)=> {requireValue(!res.locals.auth.user.demo,'Gerçek SSH bağlantısı için kalıcı hesabınızla giriş yapın.',403);const config=req.body?.connection??req.body;res.json(await probe(config).catch(error=>adapterFailure(error,config)));}));
  app.post('/api/connections/inspect',asyncRoute(async(req,res)=> {
    requireValue(!res.locals.auth.user.demo,'Gerçek SSH taraması için kalıcı hesabınızla giriş yapın.',403);
    const connection=connectionInput(req.body?.connection);const directory=req.body?.directory?text(req.body.directory,'Sunucu dizini',1024):undefined;
    const scan=await inspect(connection,{directory}).catch(error=>adapterFailure(error,connection));res.json({...scan,candidates:(scan.candidates??[]).map((candidate:any)=>({...candidate,address:gameAddress(connection.host,candidate.port)})),...(scan.directory?{address:gameAddress(connection.host,scan.port)}:{})});
  }));
  app.post('/api/servers',asyncRoute(async(req,res)=> {
    requireValue(!res.locals.auth.user.demo,'Gerçek sunucu eklemek için kalıcı hesabınızla giriş yapın.',403);
    const name=text(req.body?.name,'Sunucu adı',80);const installed=req.body.installed===true||req.body.existing===true;
    const mode=req.body.installMode==='auto'?'auto':'manual';
    const connection=connectionInput(req.body?.connection,Number(req.body.bridgePort??(!installed&&mode==='auto'?20000+(randomBytes(4).readUInt32BE()%20000)*2:8765)));
    const bridgeUrl=req.body.bridgeUrl?text(req.body.bridgeUrl,'Köprü adresi',512):undefined;
    const bridgeToken=req.body.bridgeToken?text(req.body.bridgeToken,'Köprü anahtarı',1024):(!installed&&mode==='auto'?randomBytes(32).toString('hex'):undefined);
    if(bridgeToken)requireValue(/^[a-zA-Z0-9_-]{32,256}$/.test(bridgeToken),'Köprü anahtarı 32–256 harf, rakam, tire veya alt çizgiden oluşmalı.');
    if(bridgeUrl){let parsed;try{parsed=new URL(bridgeUrl);}catch{}requireValue(parsed&&!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash&&(parsed.protocol==='https:'||(parsed.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))),'Doğrudan köprü HTTPS kullanmalı; HTTP yalnızca localhost için kullanılabilir.');requireValue(bridgeToken,'Köprü anahtarı gerekli.');}
    const id=randomUUID();let discovery:any=null;let game:string;let edition:string;let version:string;let plan:any=null;
    if(installed){
      const directory=req.body.directory?text(req.body.directory,'Sunucu dizini',1024):undefined;
      discovery=selectedDiscovery(await inspect(connection,{directory}).catch(error=>adapterFailure(error,connection)),connection.host);
      game=discovery.game;edition=discovery.edition??'unknown';version=discovery.version??'unknown';
    }else{
      game=text(req.body?.game,'Oyun',20);requireValue(['minecraft','valheim','terraria','rust'].includes(game),'Oyun türü desteklenmiyor.');
      edition=text(req.body?.edition??'vanilla','Sunucu yazılımı',32);version=text(req.body?.version??'latest','Sürüm',32);
      const result:any=await probe(connection).catch(error=>adapterFailure(error,connection));requireValue(result.verified,'SSH parmak izi doğrulanamadı.',409);
      plan=await preparePlan({id,name,game,edition,version,eulaAccepted:req.body.eulaAccepted===true,installMode:mode}).catch(error=>adapterFailure(error));
      if(mode==='auto')requireValue(plan?.supported!==false,'Bu oyun için otomatik kurulum henüz desteklenmiyor; manuel kurulumu seçin.',422);
    }
    const data={server:{id,name,game,edition,version,status:installed?discovery.status:mode==='manual'?'stopped':'installing',address:discovery?.address??`${connection.host}:${game==='minecraft'?25565:game==='valheim'?2456:game==='terraria'?7777:28015}`,maxPlayers:discovery?.maxPlayers??null,demo:false,imported:installed,directory:discovery?.directory,retentionDays:90,undoEnabled:true,bridgeConfigured:!!bridgeToken,bridgePort:connection.bridgePort,curseforgeConfigured:false,connection:{host:connection.host,port:connection.port,username:connection.username},createdAt:iso()},discovery,install:{status:installed?'installed':'planned',plan,logs:[]},players:[],chat:[],mods:discovery?.mods??[],metrics:discovery?.metrics??null,console:[],inventoryProviders:[]};
    store.db.prepare('INSERT INTO servers(id,owner_id,data,secrets) VALUES(?,?,?,?)').run(id,res.locals.auth.user.id,JSON.stringify(data),store.encrypt({connection,bridgeUrl,bridgeToken,directory:discovery?.directory}));store.db.prepare('INSERT INTO members(server_id,user_id,role) VALUES(?,?,?)').run(id,res.locals.auth.user.id,'owner');audit(store,id,res.locals.auth.user,installed?'server.import':'server.add',installed?'Mevcut sunucu salt okunur SSH taramasıyla bağlandı; oyun dosyaları değiştirilmedi.':'SSH bağlantısı doğrulanarak sunucu eklendi.');
    if(!installed&&mode==='auto')void install(id,res.locals.auth.user).catch(()=>{});
    res.status(201).json(publicServer(data,'owner'));
  }));
  app.post('/api/servers/:id/inspect',asyncRoute(async(req,res)=>{const context=serverContext(req,res,'operator');requireValue(!context.data.server.demo,'Örnek sunucuda gerçek SSH taraması yapılmaz.',409);res.json(await refreshDiscovery(context,res.locals.auth.user));}));
  app.get('/api/servers/:id',asyncRoute(async(req,res)=> {
    const ctx=serverContext(req,res);pruneActivities(store,param(req),ctx.data.server.retentionDays);
    const discovery=ctx.data.discovery;let bridgeError:string|undefined;
    let state:any=ctx.data;
    if(!ctx.data.server.demo){
      const fallback=()=>({players:[],chat:[],mods:discovery?.mods??[],metrics:discovery?.metrics??null,console:[{timestamp:iso(),level:'WARN',message:bridgeError??(discovery?'SSH taraması salt okunur anlık görüntüdür. Canlı oyuncu, sohbet ve envanter için oyun köprüsünü bağlayın.':'Canlı oyuncu ve oyun verileri için mevcut sunucunuzu yeniden kurmadan SSP oyun köprüsünü bağlayın.')}],inventoryProviders:[],bridgeConnected:false,source:discovery?'ssh-discovery':'unavailable',observedAt:discovery?.observedAt??null,playerCounts:{online:discovery?.playersOnline??null,total:discovery?.playersTotal??null},status:discovery?.status??(ctx.data.server.imported?'unknown':ctx.data.server.status)});
      if(ctx.secrets.bridgeToken){try{state=await remote(ctx,'/state');}catch(error){bridgeError=error instanceof Error?error.message:'Oyun köprüsüne ulaşılamadı.';state=fallback();}}else state=fallback();
    }
    const liveStatus=state.server?.status??state.status;const server=publicServer(ctx.data,ctx.role);if(['running','stopped','installing','error','unknown'].includes(liveStatus))server.status=liveStatus;
    res.json({server,players:state.players??[],playerCounts:state.playerCounts??{online:(state.players??[]).filter((player:any)=>player.online).length,total:(state.players??[]).length},chat:state.chat??[],mods:state.mods??[],metrics:state.metrics??null,console:state.console??[],inventoryProviders:state.inventoryProviders??[],discovery:discovery??null,source:state.source??(ctx.data.server.demo?'demo':'game-bridge'),observedAt:state.observedAt??null,bridgeConnected:ctx.data.server.demo?true:state.bridgeConnected!==false,bridgeError,activity:activityList(store,param(req),res.locals.auth.user.id,ctx.data.server.undoEnabled)});
  }));
  app.post('/api/servers/:id/power',asyncRoute(async(req,res)=> {const ctx=serverContext(req,res,'operator');const action=req.body?.action;requireValue(['start','stop','restart'].includes(action),'Güç işlemi geçersiz.');if(ctx.data.server.demo){ctx.data.server.status=action==='stop'?'stopped':'running';if(action==='stop'){ctx.data.players.forEach((p:any)=>p.online=false);ctx.data.metrics.cpu=0;ctx.data.metrics.memory=0;ctx.data.metrics.tps=0;}else{ctx.data.metrics.cpu=23;ctx.data.metrics.memory=3.2;ctx.data.metrics.tps=20;}ctx.data.console.push({timestamp:iso(),level:'INFO',message:`[SSP Demo] ${action} işlemi uygulandı.`});saveServer(store,param(req),ctx.data);}else await remote(ctx,'/power','POST',{action});audit(store,param(req),res.locals.auth.user,`power.${action}`,`Sunucu güç işlemi: ${action}`);res.json({ok:true});}));
  app.post('/api/servers/:id/command',asyncRoute(async(req,res)=> {const ctx=serverContext(req,res,'admin');const command=text(req.body?.command,'Komut',1000);if(ctx.data.server.demo){ctx.data.console.push({timestamp:iso(),level:'INFO',message:`[SSP Demo] > ${command}`});ctx.data.console=ctx.data.console.slice(-500);saveServer(store,param(req),ctx.data);}else await remote(ctx,'/command','POST',{command});audit(store,param(req),res.locals.auth.user,'command.run',`Komut çalıştırıldı: ${command.split(/\s/)[0]}`);res.json({ok:true});}));
  app.patch('/api/servers/:id/players/:uuid',asyncRoute(async(req,res)=> {
    const ctx=serverContext(req,res,'operator');const uuid=param(req,'uuid');requireValue(/^[a-f0-9-]{36}$/i.test(uuid),'Oyuncu UUID geçersiz.');
    const change:any={};if(typeof req.body?.banned==='boolean')change.banned=req.body.banned;if(req.body?.role!==undefined){requireValue(['player','moderator','admin'].includes(req.body.role),'Yetki geçersiz.');requireValue(['owner','admin'].includes(ctx.role),'Yetki yönetimi için yönetici izni gerekli.',403);change.role=req.body.role;}requireValue(Object.keys(change).length,'Değiştirilecek alan gerekli.');
    const state=ctx.data.server.demo?ctx.data:await remote(ctx,'/state'); const player=state.players?.find((p:any)=>p.uuid===uuid);requireValue(player,'Oyuncu bulunamadı.',404);
    const old:any={};for(const key of Object.keys(change))old[key]=player[key];
    if(ctx.data.server.demo){Object.assign(player,change);if(change.banned)player.online=false;saveServer(store,param(req),ctx.data);}else await remote(ctx,`/players/${encodeURIComponent(uuid)}`,'PATCH',change);
    audit(store,param(req),res.locals.auth.user,'player.update',`${player.name}: ${'banned'in change?(change.banned?'yasaklandı':'yasağı kaldırıldı'):`yetkisi ${change.role} oldu`}`,{kind:'player',uuid,old,expected:change,permission:'role'in change?'admin':'operator'});res.json({ok:true});
  }));
  app.get('/api/servers/:id/players/:uuid/inventory',asyncRoute(async(req,res)=> {const ctx=serverContext(req,res,'operator');const uuid=param(req,'uuid');const provider=text(String(req.query.provider??'main'),'Envanter sağlayıcısı',64);if(ctx.data.server.demo){const inv=ctx.data.inventories?.[uuid]?.[provider];requireValue(inv,'Envanter sağlayıcısı bulunamadı.',404);res.json(inv);}else res.json(await remote(ctx,`/players/${encodeURIComponent(uuid)}/inventory?provider=${encodeURIComponent(provider)}`));}));
  app.put('/api/servers/:id/players/:uuid/inventory',asyncRoute(async(req,res)=> {const ctx=serverContext(req,res,'operator');const uuid=param(req,'uuid');const provider=text(String(req.query.provider??'main'),'Envanter sağlayıcısı',64);const slots=req.body?.slots;requireValue(Array.isArray(slots)&&slots.length<=256,'Envanter içeriği geçersiz.');const occupied=new Set();for(const slot of slots){requireValue(Number.isInteger(slot.slot)&&slot.slot>=0&&slot.slot<256&&typeof slot.item==='string'&&/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(slot.item)&&Number.isInteger(slot.count)&&slot.count>=1&&slot.count<=999,'Envanter yuvası geçersiz.');requireValue(!occupied.has(slot.slot),'Aynı envanter yuvası birden fazla kullanılamaz.');if(slot.data!==undefined)requireValue(typeof slot.data==='string'&&slot.data.length<=131072&&/^[A-Za-z0-9+/]*={0,2}$/.test(slot.data),'Özel eşya verisi geçersiz.');occupied.add(slot.slot);}
    const path=`/players/${encodeURIComponent(uuid)}/inventory?provider=${encodeURIComponent(provider)}`;const old=ctx.data.server.demo?ctx.data.inventories?.[uuid]?.[provider]:await remote(ctx,path);requireValue(old&&old.writable,'Bu envanter yazılabilir değil.',409);requireValue(slots.every((s:any)=>s.slot<old.capacity),'Envanter yuvası kapasite dışında.');let expected=slots;if(ctx.data.server.demo){ctx.data.inventories[uuid][provider]={...old,slots};saveServer(store,param(req),ctx.data);}else{const written=await remote(ctx,path,'PUT',{slots});expected=written?.slots??slots;}audit(store,param(req),res.locals.auth.user,'inventory.update',`${provider} envanteri güncellendi.`,{kind:'inventory',uuid,provider,old:old.slots,expected,permission:'operator'});res.json({ok:true});
  }));
  app.post('/api/servers/:id/chat',asyncRoute(async(req,res)=> {const ctx=serverContext(req,res,'operator');const message=text(req.body?.message,'Mesaj',500);if(ctx.data.server.demo){ctx.data.chat.push({id:randomUUID(),player:res.locals.auth.user.username,type:'global',message,timestamp:iso()});ctx.data.chat=ctx.data.chat.slice(-500);saveServer(store,param(req),ctx.data);}else await remote(ctx,'/chat','POST',{message});audit(store,param(req),res.locals.auth.user,'chat.send','Oyun sohbetine mesaj gönderildi.');res.json({ok:true});}));
  function catalogContext(req:Request,res:Response) {
    const serverId=typeof req.query.serverId==='string'?req.query.serverId:undefined;
    const context=serverId?loadServer(store,serverId,res.locals.auth.user.id):null;
    return {context,key:context?.secrets.curseforgeApiKey||process.env.SSP_CURSEFORGE_API_KEY,game:context?.data.server.game??String(req.query.game??'minecraft'),loader:context?.data.server.edition??String(req.query.loader??'fabric'),version:context?.data.server.version??String(req.query.version??'1.21.1')};
  }
  app.get('/api/mods/providers',asyncRoute((req,res)=>{const context=catalogContext(req,res);res.json(catalogProviders(context.key,context.game,context.loader));}));
  app.get('/api/mods/search',asyncRoute(async(req,res)=>{
    const context=catalogContext(req,res);const provider=String(req.query.provider??'modrinth') as CatalogProvider;
    res.json(await searchCatalog({provider,query:text(String(req.query.query??''),'Arama',80,0),game:context.game,loader:context.loader,version:context.version,curseforgeApiKey:context.key}));
  }));
  async function refreshAfterMods(context:any,user:any) {
    if(!context.data.server.imported)return undefined;
    try{await refreshDiscovery(context,user,false);return undefined;}catch(error){const warning=error instanceof Error?error.message:'Mod işlemi tamamlandı ancak SSH taraması yenilenemedi.';const latest=loadServer(store,context.data.server.id,user.id,'admin');if(latest.data.discovery){latest.data.discovery.warnings=[...(latest.data.discovery.warnings??[]),warning].slice(-20);saveServer(store,latest.data.server.id,latest.data);}return warning;}
  }
  app.post('/api/servers/:id/mods',asyncRoute(async(req,res)=>{
    const ctx=serverContext(req,res,'admin');requireValue(ctx.data.server.game==='minecraft','Mod kurulumu Minecraft sunucuları için kullanılabilir.',422);
    const provider=String(req.body?.provider??'modrinth').toLowerCase() as CatalogProvider;requireValue(['modrinth','curseforge'].includes(provider),'Mod sağlayıcısı geçersiz.');
    const projectId=text(req.body?.projectId,'Mod kimliği',80);requireValue(provider==='curseforge'?/^\d{1,12}$/.test(projectId):/^[a-zA-Z0-9_-]+$/.test(projectId),'Mod kimliği geçersiz.');
    const versionId=req.body.versionId===undefined?undefined:text(req.body.versionId,'Mod sürüm kimliği',80);const apiKey=ctx.secrets.curseforgeApiKey||process.env.SSP_CURSEFORGE_API_KEY;
    if(provider==='curseforge')requireValue(!!apiKey,'CurseForge API anahtarını sunucu ayarlarına ekleyin.',409);
    if(ctx.data.server.demo){
      const id=`${provider}:${projectId}`;requireValue(!ctx.data.mods.some((mod:any)=>mod.id===id||((mod.provider??'modrinth').toLowerCase()===provider&&mod.id===projectId)),'Bu mod zaten yüklü.',409);
      ctx.data.mods.push({id,projectId,name:typeof req.body.name==='string'?req.body.name.slice(0,100):projectId,version:'demo',author:provider==='curseforge'?'CurseForge':'Modrinth',description:'Örnek mod kurulumu; gerçek dosya indirilmedi. Bağımlılıklar gerçek sunucuda otomatik çözülür.',enabled:true,provider,managed:true});saveServer(store,param(req),ctx.data);
    }else if(ctx.data.server.imported&&!ctx.secrets.bridgeToken){
      await installExistingMods(ctx.secrets.connection,{directory:ctx.secrets.directory??ctx.data.server.directory,gameVersion:ctx.data.server.version,loader:ctx.data.server.edition,provider,projectId,versionId,...(provider==='curseforge'?{apiKey}:{})}).catch(error=>adapterFailure(error,{...ctx.secrets,apiKey}));
    }else await remote(ctx,'/mods','POST',{provider,projectId,versionId,...(provider==='curseforge'?{apiKey}:{})});
    audit(store,param(req),res.locals.auth.user,'mod.install',`${provider}: ${projectId} ve gerekli bağımlılıkları için kurulum tamamlandı.`);
    const inspectionWarning=await refreshAfterMods(ctx,res.locals.auth.user);res.json({ok:true,...(inspectionWarning?{inspectionWarning}:{})});
  }));
  app.delete('/api/servers/:id/mods/:modId',asyncRoute(async(req,res)=>{
    const ctx=serverContext(req,res,'admin');const modId=param(req,'modId');requireValue(/^(?:(?:modrinth|curseforge):)?[a-zA-Z0-9_-]{1,100}$/.test(modId),'Mod kimliği geçersiz.');
    if(ctx.data.server.demo){requireValue(ctx.data.mods.some((mod:any)=>mod.id===modId),'Mod bulunamadı.',404);ctx.data.mods=ctx.data.mods.filter((mod:any)=>mod.id!==modId);saveServer(store,param(req),ctx.data);}
    else if(ctx.data.server.imported&&!ctx.secrets.bridgeToken)await removeExistingMod(ctx.secrets.connection,{directory:ctx.secrets.directory??ctx.data.server.directory,gameVersion:ctx.data.server.version,loader:ctx.data.server.edition,modId}).catch(error=>adapterFailure(error,ctx.secrets));
    else await remote(ctx,`/mods/${encodeURIComponent(modId)}`,'DELETE');
    audit(store,param(req),res.locals.auth.user,'mod.remove',`${modId} modu kaldırıldı.`);const inspectionWarning=await refreshAfterMods(ctx,res.locals.auth.user);res.json({ok:true,...(inspectionWarning?{inspectionWarning}:{})});
  }));
  app.patch('/api/servers/:id/settings',asyncRoute((req,res)=> {const ctx=serverContext(req,res,'admin');const next:any={};const old:any={};if(req.body?.retentionDays!==undefined){requireValue(Number.isInteger(req.body.retentionDays)&&req.body.retentionDays>=7&&req.body.retentionDays<=365,'Saklama süresi 7–365 gün olmalı.');next.retentionDays=req.body.retentionDays;old.retentionDays=ctx.data.server.retentionDays;}if(req.body?.undoEnabled!==undefined){requireValue(typeof req.body.undoEnabled==='boolean','Geri alma ayarı geçersiz.');next.undoEnabled=req.body.undoEnabled;old.undoEnabled=ctx.data.server.undoEnabled;}requireValue(Object.keys(next).length,'Değiştirilecek ayar gerekli.');Object.assign(ctx.data.server,next);saveServer(store,param(req),ctx.data);audit(store,param(req),res.locals.auth.user,'settings.update','Sunucu paneli ayarları güncellendi.',{kind:'settings',old,expected:next,permission:'admin'});pruneActivities(store,param(req),ctx.data.server.retentionDays);res.json({ok:true});}));
  app.patch('/api/servers/:id/connection',asyncRoute((req,res)=>{
    const ctx=serverContext(req,res,'admin');const body=req.body??{};
    const bridgeChange=['bridgeToken','bridgePort','bridgeUrl'].some(key=>body[key]!==undefined);
    if(bridgeChange){requireValue(!ctx.data.server.demo,'Köprü ayarları gerçek sunucular için kullanılabilir.',409);requireValue(ctx.secrets.connection,'SSH bağlantısı kayıtlı değil.',409);}
    if(body.bridgeToken!==undefined){requireValue(typeof body.bridgeToken==='string'&&/^[a-zA-Z0-9_-]{32,256}$/.test(body.bridgeToken),'Köprü anahtarı 32–256 harf, rakam, tire veya alt çizgiden oluşmalı.');ctx.secrets.bridgeToken=body.bridgeToken;}
    if(body.bridgePort!==undefined){requireValue(Number.isInteger(body.bridgePort)&&body.bridgePort>=1&&body.bridgePort<=65535,'Köprü portu geçersiz.');ctx.secrets.bridgePort=body.bridgePort;ctx.secrets.connection.bridgePort=body.bridgePort;ctx.data.server.bridgePort=body.bridgePort;}
    if(body.bridgeUrl!==undefined){requireValue(typeof body.bridgeUrl==='string'&&body.bridgeUrl.length<=512,'Köprü adresi geçersiz.');if(body.bridgeUrl){let parsed;try{parsed=new URL(body.bridgeUrl);}catch{}requireValue(parsed&&!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash&&(parsed.protocol==='https:'||(parsed.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))),'Doğrudan köprü HTTPS kullanmalı; HTTP yalnızca localhost için kullanılabilir.');}ctx.secrets.bridgeUrl=body.bridgeUrl||undefined;}
    if(body.clearCurseforgeApiKey===true)delete ctx.secrets.curseforgeApiKey;
    if(body.curseforgeApiKey!==undefined){requireValue(typeof body.curseforgeApiKey==='string','CurseForge API anahtarı geçersiz.');const key=body.curseforgeApiKey.trim();if(key){requireValue(/^[\x21-\x7e]{16,512}$/.test(key),'CurseForge API anahtarı geçersiz.');ctx.secrets.curseforgeApiKey=key;}}
    ctx.data.server.bridgeConfigured=!!ctx.secrets.bridgeToken;ctx.data.server.curseforgeConfigured=!!(ctx.secrets.curseforgeApiKey||process.env.SSP_CURSEFORGE_API_KEY);
    store.db.prepare('UPDATE servers SET data=?,secrets=? WHERE id=?').run(JSON.stringify(ctx.data),store.encrypt(ctx.secrets),param(req));audit(store,param(req),res.locals.auth.user,'connection.update','Oyun köprüsü ve katalog bağlantı ayarları güncellendi.');res.json({ok:true});
  }));
  const undoLocks=new Set<string>();
  app.post('/api/servers/:id/activity/:activityId/undo',asyncRoute(async(req,res)=> {const id=param(req);const ctx=serverContext(req,res,'operator');requireValue(ctx.data.server.undoEnabled,'İşlem geri alma kapalı.',409);requireValue(!undoLocks.has(id),'Başka bir geri alma işlemi sürüyor.',409);undoLocks.add(id);try {pruneActivities(store,id,ctx.data.server.retentionDays);const activity=activityList(store,id,res.locals.auth.user.id,true).find(row=>row.id===param(req,'activityId'));requireValue(activity?.canUndo,'Yalnızca kendinizin son üç geri alınabilir işlemi, en yeniden başlanarak geri alınabilir.',409);const row:any=store.db.prepare('SELECT * FROM activities WHERE id=? AND server_id=? AND actor_id=?').get(activity.id,id,res.locals.auth.user.id);const inverse=JSON.parse(row.inverse);if(inverse.permission==='admin')requireValue(['admin','owner'].includes(ctx.role),'Bu işlemi geri almak için yönetici izni gerekli.',403);
    if(inverse.expected!==undefined){let current:any;if(inverse.kind==='player'){const state=ctx.data.server.demo?ctx.data:await remote(ctx,'/state');const player=state.players?.find((p:any)=>p.uuid===inverse.uuid);requireValue(player,'Oyuncu artık erişilebilir değil.',409);current=Object.fromEntries(Object.keys(inverse.expected).map(key=>[key,player[key]]));}else if(inverse.kind==='inventory'){const state=ctx.data.server.demo?ctx.data.inventories?.[inverse.uuid]?.[inverse.provider]:await remote(ctx,`/players/${encodeURIComponent(inverse.uuid)}/inventory?provider=${encodeURIComponent(inverse.provider)}`);current=normalizedSlots(state?.slots??[]);inverse.expected=normalizedSlots(inverse.expected);}else if(inverse.kind==='settings')current=Object.fromEntries(Object.keys(inverse.expected).map(key=>[key,ctx.data.server[key]]));requireValue(JSON.stringify(current)===JSON.stringify(inverse.expected),'Veri bu işlemden sonra değişti. Başka bir değişikliği silmemek için geri alma durduruldu.',409);}
    if(inverse.kind==='player'){if(ctx.data.server.demo){const player=ctx.data.players.find((p:any)=>p.uuid===inverse.uuid);requireValue(player,'Oyuncu bulunamadı.',404);Object.assign(player,inverse.old);saveServer(store,id,ctx.data);}else await remote(ctx,`/players/${encodeURIComponent(inverse.uuid)}`,'PATCH',inverse.old);}
    else if(inverse.kind==='inventory'){if(ctx.data.server.demo){ctx.data.inventories[inverse.uuid][inverse.provider].slots=inverse.old;saveServer(store,id,ctx.data);}else await remote(ctx,`/players/${encodeURIComponent(inverse.uuid)}/inventory?provider=${encodeURIComponent(inverse.provider)}`,'PUT',{slots:inverse.old});}
    else if(inverse.kind==='settings'){Object.assign(ctx.data.server,inverse.old);saveServer(store,id,ctx.data);}else throw new ApiError(409,'Bu işlem geri alınamıyor.');
    store.db.prepare('UPDATE activities SET undone=1 WHERE id=?').run(activity.id);audit(store,id,res.locals.auth.user,`undo:${row.action}`,`Geri alındı: ${row.detail}`);res.json({ok:true});
  }finally{undoLocks.delete(id);}}));
  app.post('/api/servers/:id/invites',asyncRoute((req,res)=> {serverContext(req,res,'admin');const role=req.body?.role??'viewer';requireValue(['viewer','operator','admin'].includes(role),'Davet yetkisi geçersiz.');const code=randomBytes(24).toString('hex');const invite={id:randomUUID(),serverId:param(req),role,expires:iso(Date.now()+7*86400000)};store.db.prepare('INSERT INTO invites(id,server_id,code_hash,role,expires) VALUES(?,?,?,?,?)').run(invite.id,invite.serverId,digest(code),role,new Date(invite.expires).getTime());audit(store,param(req),res.locals.auth.user,'invite.create',`${role} yetkili 7 günlük davet oluşturuldu.`);res.status(201).json({...invite,code});}));
  app.get('/api/servers/:id/invites',asyncRoute((req,res)=> {serverContext(req,res,'admin');const rows:any[]=store.db.prepare('SELECT id,role,expires,redeemed_by,revoked FROM invites WHERE server_id=? ORDER BY rowid DESC').all(param(req)) as any[];res.json(rows.map(r=>({id:r.id,role:r.role,expires:iso(r.expires),redeemed:!!r.redeemed_by,revoked:!!r.revoked})));}));
  app.delete('/api/servers/:id/invites/:inviteId',asyncRoute((req,res)=> {serverContext(req,res,'admin');const result=store.db.prepare('UPDATE invites SET revoked=1 WHERE server_id=? AND id=?').run(param(req),param(req,'inviteId'));requireValue(result.changes,'Davet bulunamadı.',404);audit(store,param(req),res.locals.auth.user,'invite.revoke','Davet iptal edildi.');res.json({ok:true});}));
  app.post('/api/invites/redeem',asyncRoute((req,res)=> {const serverId=redeem(res.locals.auth.user.id,req.body?.code);audit(store,serverId,res.locals.auth.user,'invite.redeem','Davet koduyla sunucuya katıldı.');res.json({ok:true,serverId});}));
  const installs=new Set<string>();
  async function install(id:string,user:any) { if(installs.has(id))throw new ApiError(409,'Kurulum zaten devam ediyor.');const ctx=loadServer(store,id,user.id,'admin');requireValue(!ctx.data.server.demo,'Örnek sunucu için SSH kurulumu gerekli değil.',409);requireValue(ctx.data.install.plan?.mode==='auto'&&ctx.data.install.plan?.supported,'Bu plan manuel kurulmalıdır.',409);requireValue(ctx.data.install.status!=='installed','Sunucu zaten kurulu.',409);installs.add(id);ctx.data.install.status='installing';ctx.data.server.status='installing';saveServer(store,id,ctx.data);audit(store,id,user,'install.start','Sunucu otomatik kurulumu başlatıldı.');try{await runInstallation(ctx.secrets.connection,ctx.data.install.plan,(entry:any)=>{const latest=loadServer(store,id,user.id,'admin');latest.data.install.logs.push(typeof entry==='string'?entry:JSON.stringify(entry));latest.data.install.logs=latest.data.install.logs.slice(-300);saveServer(store,id,latest.data);});await bootstrapBridge(ctx.secrets.connection,ctx.data.install.plan,{bridgeToken:ctx.secrets.bridgeToken,bridgePort:ctx.secrets.connection.bridgePort},(line:string)=>{const current=loadServer(store,id,user.id,'admin');current.data.install.logs.push(line);current.data.install.logs=current.data.install.logs.slice(-300);saveServer(store,id,current.data);});const latest=loadServer(store,id,user.id,'admin');latest.data.install.status='installed';latest.data.server.status='stopped';saveServer(store,id,latest.data);audit(store,id,user,'install.complete','Sunucu kurulumu tamamlandı.');}catch{const latest=loadServer(store,id,user.id,'admin');latest.data.install.status='error';latest.data.server.status='error';latest.data.install.logs.push('Kurulum tamamlanamadı. SSH bağlantısını, kurulum planını ve sunucu gereksinimlerini kontrol edin.');saveServer(store,id,latest.data);audit(store,id,user,'install.error','Sunucu kurulumu başarısız.');}finally{installs.delete(id);}}
  app.get('/api/servers/:id/install',asyncRoute((req,res)=> {const ctx=serverContext(req,res,'admin');res.json(ctx.data.install??{status:'installed',plan:null,logs:[]});}));
  app.post('/api/servers/:id/install',asyncRoute((req,res)=> {const ctx=serverContext(req,res,'admin');requireValue(!installs.has(param(req)),'Kurulum zaten devam ediyor.',409);requireValue(!ctx.data.server.demo&&ctx.data.install?.plan&&ctx.data.install.status!=='installed','Bu sunucu için kurulabilir bir plan yok.',409);requireValue(ctx.data.install.plan.mode==='auto'&&ctx.data.install.plan.supported===true,'Bu plan manuel kurulmalıdır.',409);void install(param(req),res.locals.auth.user).catch(()=>{});res.status(202).json({ok:true,status:'installing'});}));
  app.use('/api',(_req,res)=>res.status(404).json({error:'API yolu bulunamadı.'}));
  app.use((error:any,_req:Request,res:Response,_next:NextFunction)=> {const status=error instanceof ApiError?error.status:error.type==='entity.too.large'?413:error instanceof SyntaxError?400:502;res.status(status).json({error:error instanceof ApiError?error.message:status===400?'JSON içeriği geçersiz.':status===413?'İstek boyutu sınırı aşıldı.':'İşlem tamamlanamadı. Uzak bağlantıyı ve sunucu yapılandırmasını kontrol edin.'});});
  return app;
}
