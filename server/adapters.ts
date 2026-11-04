import ssh2, { type ConnectConfig, type Client as SshClient } from 'ssh2';
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {readFile} from 'node:fs/promises';
import {resolve as resolvePath} from 'node:path';

export interface SshConfig {
  host: string; port?: number; username: string; password?: string; privateKey?: string;
  hostFingerprint?: string; bridgePort?: number;
}
export interface InstallOptions {
  id?: string; name?: string; game: string; edition?: string; version?: string;
  eulaAccepted?: boolean; installMode?: string; memoryMb?: number;
}
export interface InstallPlan {
  supported: boolean; mode: 'auto' | 'manual'; game: string; edition: string; version: string;
  directory: string; steps: Array<{ label: string; command: string }>;
  notes: string[]; artifact?: { url: string; algorithm?: string; hash?: string }; loaderVersion?:string;
}
const USER_AGENT = 'StylishServersPanel_SSP/0.2 (https://github.com/OpenMTLLC/StylishServersPanel_SSP)';
const {Client} = ssh2;
export function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function safeName(value: string, label: string): string {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(value) || value === '.' || value === '..') throw new Error(`${label} geçersiz.`);
  return value;
}
function validateConfig(config: SshConfig) {
  if (!config || typeof config.host !== 'string' || !/^[a-zA-Z0-9.:[\]_-]{1,253}$/.test(config.host)) throw new Error('SSH adresi geçersiz.');
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(config.username || '')) throw new Error('SSH kullanıcı adı geçersiz.');
  if (!Number.isInteger(config.port ?? 22) || (config.port ?? 22) < 1 || (config.port ?? 22) > 65535) throw new Error('SSH portu geçersiz.');
  if (!config.password && !config.privateKey) throw new Error('SSH parola veya özel anahtarı gerekli.');
}
function fingerprint(key: Buffer): string { return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, ''); }
function equalText(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
async function ssh(config: SshConfig, probe = false): Promise<{client: SshClient; observed: string; verified: boolean}> {
  validateConfig(config);
  if (!probe && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(config.hostFingerprint || '')) throw new Error('Önce SSH sunucusunun SHA256 parmak izini doğrulayın.');
  return new Promise((resolve, reject) => {
    const client = new Client(); let observed = ''; let verified = false;
    const options: ConnectConfig = {
      host: config.host, port: config.port ?? 22, username: config.username,
      ...(config.privateKey ? { privateKey: config.privateKey } : { password: config.password }),
      readyTimeout: 15000, keepaliveInterval: 10000, keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => { observed = fingerprint(key); verified = !!config.hostFingerprint && equalText(observed, config.hostFingerprint); return verified; }
    };
    client.once('error', () => {
      client.end();
      if (probe && !config.hostFingerprint && observed) return resolve({client,observed,verified:false});
      reject(new Error(observed && config.hostFingerprint && !verified ? 'SSH parmak izi eşleşmiyor. Bağlantı reddedildi.' : 'SSH bağlantısı kurulamadı. Adres, kimlik bilgileri ve erişimi kontrol edin.'));
    });
    client.once('ready', () => resolve({client, observed, verified}));
    client.connect(options);
  });
}
function execSsh(client: SshClient, command: string, onLog?: (line: string) => void, timeoutMs = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => { client.end(); reject(new Error('Uzak işlem zaman aşımına uğradı.')); }, timeoutMs);
    client.exec(command, (error, stream) => {
      if (error) { clearTimeout(timer); return reject(new Error('Uzak işlem başlatılamadı.')); }
      const collect = (data: Buffer) => { const text = data.toString('utf8'); output = (output + text).slice(-65536); onLog?.(text.slice(0,8192)); };
      stream.on('data', collect); stream.stderr.on('data', collect);
      stream.once('close', (code: number | null) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`Uzak işlem başarısız (çıkış kodu ${code ?? '?'}).`)); });
      stream.once('error', () => { clearTimeout(timer); reject(new Error('SSH işlem akışı kesildi.')); });
    });
  });
}
export async function probeSsh(config: SshConfig) {
  const connection = await ssh(config, true);
  try {
    // First contact never executes commands: only the SSH handshake discovers the key.
    const platform = connection.verified ? (await execSsh(connection.client, 'uname -s', undefined, 10000)).trim() : 'unverified';
    return {fingerprint: connection.observed, verified: connection.verified, platform};
  } finally { connection.client.end(); }
}
/** Fixed trusted Python source on the command channel; secrets/input only on stdin. */
export async function runSshPython(config:SshConfig, script:string, input:unknown, timeoutMs=90000):Promise<any> {
  if (typeof script !== 'string' || script.length > 512*1024) throw new Error('Keşif betiği geçersiz.');
  const payload=Buffer.from(JSON.stringify(input));
  if (payload.length > 1024*1024) throw new Error('SSH işlem girdisi çok büyük.');
  const connection=await ssh(config);
  try {
    return await new Promise((resolve,reject)=>{
      const chunks:Buffer[]=[];let size=0;let settled=false;
      const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>{connection.client.end();finish(new Error('SSH keşif işlemi zaman aşımına uğradı.'));},Math.min(Math.max(timeoutMs,1000),600000));
      connection.client.exec(`python3 -c ${shellQuote(script)}`,(error,stream)=>{
        if(error)return finish(new Error('SSH Python işlemi başlatılamadı.'));
        stream.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>8*1024*1024){stream.close();finish(new Error('SSH yanıtı çok büyük.'));}else chunks.push(Buffer.from(chunk));});
        stream.stderr.on('data',()=>{});
        stream.once('error',()=>finish(new Error('SSH keşif akışı kesildi.')));
        stream.once('close',(code:number|null)=>{
          if(code!==0)return finish(new Error('SSH Python işlemi tamamlanamadı. Uzak dizin izinlerini ve Python kurulumunu kontrol edin.'));
          try{finish(undefined,JSON.parse(Buffer.concat(chunks,size).toString('utf8')));}catch{finish(new Error('SSH işlemi geçerli JSON döndürmedi.'));}
        });
        stream.end(payload);
      });
    });
  } finally {connection.client.end();}
}
export async function inspectExistingServer(config:SshConfig,options:{directory?:string;port?:number}={}) {
  if(options.directory!==undefined && (typeof options.directory!=='string'||options.directory.length>4096||!options.directory.startsWith('/')||/[\0\r\n]/.test(options.directory)))throw new Error('Sunucu dizini mutlak bir Linux yolu olmalıdır.');
  if(options.port!==undefined && (!Number.isInteger(options.port)||options.port<1||options.port>65535))throw new Error('Sunucu portu geçersiz.');
  const source=await readFile(resolvePath(process.cwd(),'bridge','discover.py'),'utf8');
  const script=`${source}\n_ssp_input=json.load(sys.stdin)\nprint(json.dumps(discover(_ssp_input),ensure_ascii=False))\n`;
  // __name__ prevents the standalone CLI from running before stdin has been read.
  const result=await runSshPython(config,`__name__='ssp_discovery'\n${script}`,options);
  if(result?.error)throw new Error('Uzak sunucu keşfi tamamlanamadı. Dizin izinlerini ve Python kurulumunu kontrol edin.');
  for(const candidate of result.candidates||[])candidate.address=`${config.host}:${candidate.port}`;
  const selected=options.directory ? result.candidates?.[0] : result.candidates?.length===1 ? result.candidates[0] : null;
  return {...(selected||{}),...result};
}
async function getJson(url: string): Promise<any> {
  const response = await fetch(url, {headers:{'User-Agent':USER_AGENT}, signal:AbortSignal.timeout(20000), redirect:'error'});
  if (!response.ok) throw new Error(`Resmî indirme servisi yanıt vermedi (${response.status}).`);
  return response.json();
}
async function getText(url:string):Promise<string>{
  const response=await fetch(url,{headers:{'User-Agent':USER_AGENT},signal:AbortSignal.timeout(20000),redirect:'error'});
  if(!response.ok)throw new Error(`Resmî NeoForge servisi yanıt vermedi (${response.status}).`);
  const value=await response.text();if(value.length>2*1024*1024)throw new Error('NeoForge metadata yanıtı çok büyük.');return value;
}
export async function resolveNeoForgeVersion(gameVersion:string){
  if(!/^(?:1\.\d+(?:\.\d+)?|26\.\d+(?:\.\d+)?)$/.test(gameVersion))throw new Error('NeoForge Minecraft sürümü geçersiz.');
  const parts=gameVersion.split('.');
  const prefix=parts[0]==='1'?`${parts[1]}.${parts[2]||'0'}.`:`${parts[0]}.${parts[1]}.${parts[2]||'0'}.`;
  const metadata=await getText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
  const versions=[...metadata.matchAll(/<version>([^<]+)<\/version>/g)].map(match=>match[1]).filter(value=>value.startsWith(prefix)&&/^\d+(?:\.\d+){2,3}$/.test(value));
  versions.sort((a,b)=>{const av=a.split('.').map(Number),bv=b.split('.').map(Number);for(let i=0;i<Math.max(av.length,bv.length);i++){const d=(bv[i]||0)-(av[i]||0);if(d)return d;}return 0;});
  if(!versions.length)throw new Error('Seçilen Minecraft sürümü için kararlı NeoForge dağıtımı bulunamadı.');
  const loaderVersion=versions[0];const url=`https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
  const hash=(await getText(url+'.sha512')).trim().split(/\s+/)[0];
  if(!/^[a-fA-F0-9]{128}$/.test(hash))throw new Error('NeoForge resmî SHA512 özeti geçersiz.');
  return {loaderVersion,url,hash:hash.toLowerCase()};
}
function checkedUrl(value: string, domains: string[]): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !domains.includes(url.hostname)) throw new Error('İndirme adresi doğrulanamadı.');
  return url.href;
}
export async function createInstallPlan(options: InstallOptions): Promise<InstallPlan> {
  const game = safeName(options.game, 'Oyun'); const edition = safeName(options.edition || 'vanilla', 'Sürüm türü');
  const version = safeName(options.version || '1.21.4', 'Oyun sürümü'); const id = safeName(options.id || 'server', 'Sunucu kimliği');
  const directory = `ssp-servers/${id}`;
  const plan: InstallPlan = {supported:false, mode:options.installMode === 'manual' ? 'manual' : 'auto',game,edition,version,directory,steps:[],notes:[]};
  if (game !== 'minecraft' || !['paper','fabric','vanilla','neoforge'].includes(edition)) {
    plan.mode = 'manual'; plan.notes.push('Bu oyun/sürüm için otomatik kurulum henüz desteklenmiyor. Resmî sunucu dağıtımını SSH ile yükleyin; çalışan sunucuyu SSP köprüsüne bağlayın.');
    return plan;
  }
  if (!options.eulaAccepted) throw new Error('Minecraft kurulumu için EULA açıkça kabul edilmelidir: https://www.minecraft.net/eula');
  let artifact: InstallPlan['artifact'];
  if(edition==='neoforge'){
    const neo=await resolveNeoForgeVersion(version);
    plan.loaderVersion=neo.loaderVersion;artifact={url:neo.url,algorithm:'sha512',hash:neo.hash};
    plan.notes.push(`NeoForge ${neo.loaderVersion}; resmî installer --installServer ile kurulur. Minecraft ve NeoForge sürümleri eşleştirildi.`);
  } else if (edition === 'paper') {
    const builds = await getJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`);
    const build = Array.isArray(builds) ? builds.find((x:any) => x.channel === 'STABLE' && x.downloads?.['server:default']) : null;
    if (!build) throw new Error('Seçilen Paper sürümünün kararlı derlemesi bulunamadı. Başka bir sürüm seçin.');
    const file = build.downloads['server:default'];
    if (!/^[a-f0-9]{64}$/.test(file.checksums?.sha256 || '')) throw new Error('Paper dosyasının SHA256 özeti eksik.');
    artifact = {url:checkedUrl(file.url,['fill-data.papermc.io']),algorithm:'sha256',hash:file.checksums.sha256};
  } else if (edition === 'fabric') {
    const [loaders, installers] = await Promise.all([getJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`),getJson('https://meta.fabricmc.net/v2/versions/installer')]);
    const loader = loaders.find((x:any) => x.loader?.stable)?.loader?.version; const installer = installers.find((x:any) => x.stable)?.version;
    if (!loader || !installer) throw new Error('Kararlı Fabric yükleyicisi bulunamadı.');
    safeName(loader,'Fabric loader'); safeName(installer,'Fabric installer');
    artifact = {url:`https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`};
    plan.notes.push(`Fabric loader ${loader}; installer ${installer}. Fabric API ve diğer modların sürüm uyumluluğunu Modlar bölümünden kontrol edin.`);
  } else {
    const manifest = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    const entry = manifest.versions?.find((x:any) => x.id === version);
    if (!entry) throw new Error('Minecraft sürümü resmî manifestte bulunamadı.');
    const metadata = await getJson(checkedUrl(entry.url,['piston-meta.mojang.com','launchermeta.mojang.com']));
    const file = metadata.downloads?.server;
    if (!file || !/^[a-f0-9]{40}$/.test(file.sha1 || '')) throw new Error('Minecraft sunucu indirmesi bulunamadı.');
    artifact = {url:checkedUrl(file.url,['piston-data.mojang.com','launcher.mojang.com']),algorithm:'sha1',hash:file.sha1};
  }
  plan.supported = true; plan.artifact = artifact;
  const major = Number(version.split('.')[0]); const requiredJava = major >= 26 ? 25 : version.startsWith('1.20') || version.startsWith('1.21') ? 21 : 17;
  const memory = options.memoryMb ?? 2048;
  if (!Number.isInteger(memory) || memory < 512 || memory > 65536) throw new Error('Bellek miktarı geçersiz.');
  const cd = `cd "$HOME"/${shellQuote(directory)}`;
  const startScript = edition==='neoforge'
    ? `#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nexec java @user_jvm_args.txt @libraries/net/neoforged/neoforge/${plan.loaderVersion}/unix_args.txt nogui\n`
    : `#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nexec java -Xms512M -Xmx${memory}M -jar server.jar nogui\n`;
  const artifactName=edition==='neoforge'?'installer.jar':'server.jar';
  plan.steps = [
    {label:'Gereksinimleri kontrol et',command:`set -eu\ncommand -v curl >/dev/null\ncommand -v python3 >/dev/null\ncommand -v java >/dev/null\nJAVA_VERSION=$(java -version 2>&1 | head -n 1 | sed -E 's/.*version "([0-9]+).*/\\1/')\n[ "$JAVA_VERSION" -ge ${requiredJava} ] || { echo 'Java ${requiredJava}+ gerekli'; exit 1; }`},
    {label:'Yeni sunucu dizinini oluştur',command:`set -eu\numask 077\nmkdir -p "$HOME"/ssp-servers\nmkdir "$HOME"/${shellQuote(directory)}`},
    {label:'Doğrulanmış sunucu dosyasını indir',command:`set -eu\n${cd}\ncurl --fail --location --proto '=https' --tlsv1.2 --max-time 180 --user-agent ${shellQuote(USER_AGENT)} --output ${artifactName}.part ${shellQuote(artifact.url)}\n${artifact.hash ? `printf '%s  %s\\n' ${shellQuote(artifact.hash)} '${artifactName}.part' | ${artifact.algorithm}sum --check --status\n` : ''}mv ${artifactName}.part ${artifactName}`},
    ...(edition==='neoforge'?[{label:'NeoForge sunucu kütüphanelerini kur',command:`set -eu\n${cd}\njava -jar installer.jar --installServer\ntest -f ${shellQuote(`libraries/net/neoforged/neoforge/${plan.loaderVersion}/unix_args.txt`)}\nprintf '%s\\n' '-Xms512M' '-Xmx${memory}M' > user_jvm_args.txt`}]:[]),
    {label:'Kabul edilen EULA ve başlatıcıyı kaydet',command:`set -eu\n${cd}\nprintf '%s\\n' 'eula=true' > eula.txt\nprintf '%s' ${shellQuote(startScript)} > start.sh\nchmod 700 start.sh\nmkdir -p ${edition === 'paper' ? 'plugins' : 'mods'}`},
  ];
  plan.notes.push(`Kurulum SSH kullanıcısının $HOME/${directory} dizinine yapılır. Mevcut dizinin üzerine yazılmaz.`, `Java ${requiredJava}+ ve python3 önceden kurulu olmalıdır.`, 'Otomatik kurulum SSP süreç köprüsünü de yükler; dünyayı Başlat düğmesiyle açabilirsiniz. Paper oyuncu köprüsü derlenmiş JAR dağıtımda varsa otomatik yüklenir; yoksa docs/BRIDGE.md adımlarını izleyin.');
  if (edition === 'fabric') plan.notes.push('Fabric dağıtımı HTTPS üzerinden alınır; resmî launcher uç noktası dosya özeti sağlamaz.');
  return plan;
}
export async function runInstallation(config: SshConfig, plan: InstallPlan, onLog: (line: string) => void = () => {}) {
  if (!plan.supported || plan.mode !== 'auto' || !plan.steps.length) throw new Error('Bu plan otomatik kuruluma uygun değil.');
  const connection = await ssh(config);
  const logs: string[] = [];
  const log = (line:string) => { logs.push(line); onLog(line); };
  try {
    for (const step of plan.steps) { log(step.label); await execSsh(connection.client, step.command, log,step.label.startsWith('NeoForge')?600000:180000); }
    log('Sunucu dosyaları kuruldu. Köprü yapılandırması ve ilk başlatma hazır.');
    return {status:'installed' as const, logs};
  } finally { connection.client.end(); }
}
/** Upload secrets using SFTP, then launch only the loopback bridge (never the world). */
export async function bootstrapBridge(config:SshConfig, plan:InstallPlan, options:{bridgeToken:string;bridgePort?:number}, onLog:(line:string)=>void=()=>{}) {
  if (!plan.supported || !/^ssp-servers\/[a-zA-Z0-9._-]{1,80}$/.test(plan.directory)) throw new Error('Köprü kurulum dizini geçersiz.');
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(options.bridgeToken)) throw new Error('Köprü anahtarı geçersiz.');
  const port = options.bridgePort ?? config.bridgePort ?? 8765;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Köprü portu 1024–65535 arasında olmalıdır.');
  const source = await readFile(resolvePath(process.cwd(),'bridge','ssp_bridge.py'),'utf8');
  const discoverySource = await readFile(resolvePath(process.cwd(),'bridge','discover.py'),'utf8');
  const connection = await ssh(config);
  try {
    const sftp = await new Promise<any>((resolve,reject)=>connection.client.sftp((error,channel)=>error?reject(new Error('SFTP kanalı açılamadı.')):resolve(channel)));
    const home = await new Promise<string>((resolve,reject)=>sftp.realpath('.',(error:any,value:string)=>error?reject(new Error('SSH ana dizini bulunamadı.')):resolve(value)));
    const directory = `${home.replace(/\/$/,'')}/${plan.directory}`;
    const providerPort = port === 65535 ? port - 1 : port + 1;
    const env = [
      `SSP_BRIDGE_TOKEN=${shellQuote(options.bridgeToken)}`,
      `SSP_PROVIDER_TOKEN=${shellQuote(options.bridgeToken)}`,
      `SSP_SERVER_DIR=${shellQuote(directory)}`,
      `SSP_GAME_VERSION=${shellQuote(plan.version)}`,
      `SSP_LOADER=${shellQuote(plan.edition)}`,
      `SSP_BRIDGE_PORT=${port}`,
      `SSP_PROVIDER_URL='http://127.0.0.1:${providerPort}'`,
      `SSP_START_COMMAND='./start.sh'`,''
    ].join('\n');
    const wrapper = `#!/bin/sh\nset -eu\ncd ${shellQuote(directory)}\nset -a\n. ./.ssp-env\nset +a\nexec python3 -u ./ssp_bridge.py\n`;
    const write = (name:string,content:string,mode:number) => new Promise<void>((resolve,reject)=>sftp.writeFile(`${directory}/${name}`,content,{mode},(error:any)=>error?reject(new Error('Köprü dosyası SFTP ile yazılamadı.')):resolve()));
    onLog('SSP köprüsü şifreli SFTP ile aktarılıyor.');
    await write('ssp_bridge.py',source,0o600);
    await write('discover.py',discoverySource,0o600);
    await write('.ssp-env',env,0o600);
    await write('.ssp-bridge-start.sh',wrapper,0o700);
    // The config is shipped before first world start so the Paper provider uses the same token/port.
    if (plan.edition === 'paper') {
      await new Promise<void>((resolve,reject)=>sftp.mkdir(`${directory}/plugins/SSPBridge`,{mode:0o700},(error:any)=>error && error.code !== 4?reject(new Error('Paper köprü yapılandırma dizini oluşturulamadı.')):resolve()));
      await write('plugins/SSPBridge/config.yml',`port: ${providerPort}\ntoken: ${shellQuote(options.bridgeToken)}\nmoderator-command: ''\nplayer-command: ''\n`,0o600);
      try {
        const jar = await readFile(resolvePath(process.cwd(),'bridge','paper','target','ssp-paper-bridge-0.1.0.jar'));
        await new Promise<void>((resolve,reject)=>sftp.writeFile(`${directory}/plugins/ssp-paper-bridge-0.1.0.jar`,jar,{mode:0o600},(error:any)=>error?reject(new Error('Paper köprü eklentisi aktarılamadı.')):resolve()));
        onLog('Paper oyuncu ve envanter köprüsü yüklendi.');
      } catch(error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        onLog('Paper eklenti JAR dosyası bu dağıtımda yok; oyuncu/sohbet/envanter sağlayıcısını docs/BRIDGE.md ile yükleyin.');
      }
    }
    sftp.end();
    onLog('SSP köprüsü localhost üzerinde başlatılıyor.');
    const launch = `set -eu\ncd ${shellQuote(directory)}\npython3 -c ${shellQuote(`import socket\ns=socket.socket(); s.bind(('127.0.0.1',${port})); s.close()`)}\nnohup ./.ssp-bridge-start.sh </dev/null >>.ssp-bridge.log 2>&1 &\nprintf '%s\\n' "$!" > .ssp-bridge.pid`;
    await execSsh(connection.client,launch,undefined,15000);
    // A bounded health check verifies that a daemon exists instead of treating shell launch as success.
    await execSsh(connection.client,`python3 -c ${shellQuote(`import socket,time\nfor attempt in range(30):\n try:\n  s=socket.create_connection(('127.0.0.1',${port}),1);s.close();break\n except OSError:\n  time.sleep(0.2)\nelse:\n raise SystemExit('SSP bridge did not become ready')`)}`,undefined,15000);
    await adapterRequest({secrets:{connection:{...config,bridgePort:port},bridgeToken:options.bridgeToken}},'/state');
    onLog('SSP köprüsü hazır. Dünya Başlat düğmesiyle açılabilir.');
    return {status:'ready' as const,bridgePort:port};
  } finally { connection.client.end(); }
}
/** Server-side bridge. SSH mode forwards only to the remote loopback, using the pinned host key. */
export async function adapterRequest(server: any, path: string, method = 'GET', body?: unknown): Promise<any> {
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) throw new Error('Köprü yolu geçersiz.');
  const secrets = server.secrets || {};
  const token = server.bridgeToken || secrets.bridgeToken;
  const bridgeUrl = server.bridgeUrl || secrets.bridgeUrl;
  const config: SshConfig = {...(server.connection || {}),...(secrets.connection || {})};
  if (!token) throw new Error('Canlı işlem için SSP oyun köprüsü ve köprü anahtarı yapılandırılmalıdır.');
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) throw new Error('Köprü anahtarı en az 32 karakter olmalıdır.');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  let connection: Awaited<ReturnType<typeof ssh>> | undefined;
  let stream: any;
  let url: URL;
  if (bridgeUrl) {
    url = new URL(bridgeUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))) throw new Error('Köprü HTTPS kullanmalıdır; HTTP yalnızca localhost için açıktır.');
    url = new URL(url.href.replace(/\/$/,'') + path);
  } else {
    connection = await ssh(config);
    const port = Number(server.bridgePort || secrets.bridgePort || config.bridgePort || 8765);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { connection.client.end(); throw new Error('Köprü portu geçersiz.'); }
    try { stream = await new Promise<any>((resolve,reject) => connection!.client.forwardOut('127.0.0.1',0,'127.0.0.1',port,(error,channel) => error ? reject(new Error('SSP köprüsüne SSH tüneli kurulamadı.')) : resolve(channel))); }
    catch (error) { connection.client.end(); throw error; }
    url = new URL(`http://127.0.0.1:${port}${path}`);
  }
  try {
    return await new Promise((resolve,reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(url, {method, ...(stream ? {createConnection:()=>stream} : {agent:false as const}), timeout:path==='/mods'&&method==='POST'?600000:20000, headers:{'Authorization':`Bearer ${token}`,'Accept':'application/json', ...(payload ? {'Content-Type':'application/json','Content-Length':payload.length} : {})}},res => {
        let raw = ''; res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; if (raw.length > 4*1024*1024) req.destroy(new Error('Köprü yanıtı çok büyük.')); });
        res.on('end', () => {
          let data:any; try { data = JSON.parse(raw); } catch { return reject(new Error('Köprü geçersiz JSON döndürdü.')); }
          if ((res.statusCode || 500) >= 400) return reject(new Error(typeof data.error === 'string' ? data.error.slice(0,300) : 'Oyun köprüsü işlemi reddetti.'));
          resolve(data);
        });
      });
      req.once('timeout', () => req.destroy(new Error('Oyun köprüsü yanıt vermedi.')));
      req.once('error', error => reject(new Error(error.message.includes('Köprü') || error.message.includes('köprüsü') ? error.message : 'SSP oyun köprüsüne bağlanılamadı.')));
      if (payload) req.write(payload); req.end();
    });
  } finally { stream?.destroy(); connection?.client.end(); }
}
