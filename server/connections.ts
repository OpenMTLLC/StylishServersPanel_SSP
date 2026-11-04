import {randomUUID} from 'node:crypto';
import {ApiError,requireValue,text,iso} from './domain.js';
import type {Store} from './db.js';
export type RemoteServices={probe:(config:any)=>Promise<any>;inspect:(config:any,options:any)=>Promise<any>;request:(server:any,path:string,method?:string,body?:any)=>Promise<any>};
export function sshInput(input:any){
 requireValue(input&&typeof input==='object','Uzak sunucu bağlantısı gerekli.');
 const type=input.type??'ssh';requireValue(['ssh','ssh-key'].includes(type),'Bağlantı türü geçersiz.');
 const value={type,host:text(input.host,'Bağlantı adresi',253),port:Number(input.port??22),username:text(input.username,'SSH kullanıcı adı',64),hostFingerprint:text(input.hostFingerprint,'SSH parmak izi',128),bridgePort:Number(input.bridgePort??8765),password:input.password,privateKey:input.privateKey};
 requireValue(Number.isInteger(value.port)&&value.port>0&&value.port<=65535,'SSH portu geçersiz.');
 requireValue(type==='ssh-key'?typeof value.privateKey==='string'&&value.privateKey.length>0&&value.privateKey.length<=32768:typeof value.password==='string'&&value.password.length>0&&value.password.length<=1024,'Bağlantı kimlik bilgileri gerekli.');
 if(type==='ssh-key')delete value.password;else delete value.privateKey;
 return value;
}
export function bridgeInput(input:any){
 requireValue(input&&typeof input==='object','Uzak sunucu bağlantısı gerekli.');
 let url:URL|undefined;try{url=new URL(input.url??input.bridgeUrl);}catch{}
 requireValue(url&&!url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))),'Köprü adresi HTTPS kullanmalıdır.');
 const token=input.token??input.bridgeToken;requireValue(typeof token==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(token),'Bağlantı erişim anahtarı gerekli.');
 return {type:'bridge',url:url.href.replace(/\/$/,''),token};
}
export async function verifyRemote(body:any,services:RemoteServices,store?:Store,userId?:string):Promise<{connection:any;secrets:any;candidate:any;existing:any}>{
 const raw=body.connection;requireValue(raw,'Kendi sunucunuz için bağlantı bilgileri gerekli.');
 if(raw.type==='bridge'){
  const connection=bridgeInput(raw);const secrets={bridgeUrl:connection.url,bridgeToken:connection.token};
  const state=await services.request({secrets},'/state');requireValue(state&&Array.isArray(state.players),'Köprü yanıtı doğrulanamadı.',502);
  const info=state.server??{};const address=new URL(connection.url);
  const candidate={directory:connection.url,game:info.game??'minecraft',edition:info.edition??'unknown',version:info.version??'unknown',status:state.status??'unknown',address:info.address??address.hostname,playersOnline:state.playerCounts?.online??state.players.filter((p:any)=>p.online).length,playersTotal:state.playerCounts?.total??state.players.length,maxPlayers:info.maxPlayers??null,mods:state.mods??[],metrics:state.metrics??null,source:'game-bridge',observedAt:iso(),warnings:[]};
  const existing=findExisting(store,userId,c=>c.type==='bridge'&&c.url===connection.url);
  return {connection:{type:'bridge',host:address.host,port:Number(address.port||443),username:'',url:connection.url},secrets,candidate,existing};
 }
 const connection=sshInput(raw);const verified=await services.probe(connection);requireValue(verified.verified,'SSH parmak izi doğrulanamadı.',409);
 const directory=body.directory?text(body.directory,'Sunucu dizini',4096):undefined;
 const existing=findExisting(store,userId,c=>c.host===connection.host&&c.port===connection.port&&c.username===connection.username,directory);
 if(existing)return {connection,secrets:{connection},candidate:existing.data.discovery,existing};
 const scan=await services.inspect(connection,{directory});
 const candidate=scan.directory?scan:scan.candidates?.length===1?scan.candidates[0]:directory?scan.candidates?.find((item:any)=>item.directory===directory):null;
 requireValue(candidate?.directory,'Sunucu dizini belirlenemedi. Mevcut oyun sunucusunun tam dizinini girin.',409);
 requireValue(candidate.game&&['minecraft','valheim','terraria','rust'].includes(candidate.game),'Bu dizinde desteklenen bir oyun sunucusu bulunamadı.',422);
 const host=connection.host.includes(':')&&!connection.host.startsWith('[')?`[${connection.host}]`:connection.host;
 return {connection,secrets:{connection,directory:candidate.directory},candidate:{...candidate,address:`${host}:${candidate.port??25565}`,source:'ssh-discovery',observedAt:scan.observedAt??iso(),machine:scan.machine??{},warnings:[...(scan.warnings??[]),...(candidate.warnings??[])]},existing:null};
}
function findExisting(store:Store|undefined,userId:string|undefined,predicate:(connection:any)=>boolean,directory?:string){
 if(!store||!userId)return null;
 for(const row of store.db.prepare('SELECT id,data,secrets FROM servers WHERE owner_id=?').all(userId) as any[]){const data=JSON.parse(row.data);if(predicate(data.server.connection??{})&&(!directory||data.server.directory===directory))return {row,data,secrets:store.decrypt(row.secrets)};}
 return null;
}
export function attachRemote(store:Store,user:any,body:any,target:Awaited<ReturnType<typeof verifyRemote>>){
 if(target.existing){const existing=target.existing;const secrets={...existing.secrets,...target.secrets};store.db.prepare('UPDATE servers SET secrets=? WHERE id=?').run(store.encrypt(secrets),existing.row.id);return existing.data.server;}
 const discovery=target.candidate;const id=randomUUID();const server={id,name:typeof body.name==='string'&&body.name.trim()?text(body.name,'Sunucu adı',80):target.connection.host,game:discovery.game,edition:discovery.edition??'unknown',version:discovery.version??'unknown',status:discovery.status??'unknown',address:discovery.address,maxPlayers:discovery.maxPlayers??null,imported:true,directory:discovery.directory,retentionDays:90,undoEnabled:true,bridgeConfigured:!!target.secrets.bridgeToken,bridgePort:target.connection.type==='bridge'?undefined:target.connection.bridgePort,curseforgeConfigured:false,connection:{type:target.connection.type,host:target.connection.host,port:target.connection.port,username:target.connection.username,url:target.connection.url},createdAt:iso()};
 const data={server,discovery,install:{status:'installed',plan:null,logs:[]},players:[],chat:[],mods:discovery.mods??[],metrics:discovery.metrics??null,console:[],inventoryProviders:[]};
 store.db.exec('BEGIN IMMEDIATE');
 try{store.db.prepare('INSERT INTO servers(id,owner_id,data,secrets) VALUES(?,?,?,?)').run(id,user.id,JSON.stringify(data),store.encrypt(target.secrets));store.db.prepare('INSERT INTO members(server_id,user_id,role) VALUES(?,?,?)').run(id,user.id,'owner');store.db.exec('COMMIT');}catch(error){store.db.exec('ROLLBACK');throw error;}
 return server;
}
