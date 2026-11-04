import { ApiError, requireValue } from './domain.js';

export type CatalogProvider = 'modrinth' | 'curseforge';
export interface CatalogOptions { provider: CatalogProvider; query: string; game: string; loader: string; version: string; curseforgeApiKey?: string; }
export interface CatalogItem {
  id: string; projectId: string; provider: CatalogProvider; name: string; author: string;
  description: string; downloads: number; iconUrl?: string; url?: string; version?: string;
  versionId?: string; compatible: boolean; installable: boolean; reason?: string; serverSideVerified?: boolean;
}
const USER_AGENT='StylishServersPanel_SSP/0.2 (https://github.com/OpenMTLLC/StylishServersPanel_SSP)';
const CF_LOADERS:Record<string,number>={forge:1,fabric:4,quilt:5,neoforge:6};
const PLUGIN_LOADERS=new Set(['paper','purpur','spigot','bukkit']);
const MODRINTH_LOADERS=new Set(['forge','fabric','quilt','neoforge',...PLUGIN_LOADERS]);
const CF_CDN=['edge.forgecdn.net','mediafilez.forgecdn.net','media.forgecdn.net','mediafiles.forgecdn.net'];
export function catalogProviders(key?:string,game='minecraft',loader='fabric') {
  const gameSupported=game==='minecraft';const cfSupported=gameSupported&&CF_LOADERS[loader]!==undefined;
  return [
    {id:'modrinth',name:'Modrinth',available:gameSupported&&MODRINTH_LOADERS.has(loader),keyRequired:false,keyConfigured:true,...(!gameSupported?{reason:'Mod kataloğu Minecraft sunucuları için kullanılabilir.'}:!MODRINTH_LOADERS.has(loader)?{reason:'Bu sunucu yazılımı JAR mod/eklenti yüklemeyi desteklemiyor.'}:{})},
    {id:'curseforge',name:'CurseForge',available:cfSupported&&!!key,keyRequired:true,keyConfigured:!!key,...(!gameSupported?{reason:'CurseForge mod kataloğu Minecraft içindir.'}:!cfSupported?{reason:'CurseForge mod kataloğu Forge, NeoForge, Fabric ve Quilt sunucularını destekler.'}:!key?{reason:'CurseForge API anahtarını sunucu ayarlarına ekleyin.'}:{})},
  ];
}
function safeUrl(value:unknown,hosts:string[]) {if(typeof value!=='string')return undefined;try{const url=new URL(value);if(url.protocol==='https:'&&hosts.includes(url.hostname)&&!url.username&&!url.password)return url.href;}catch{}return undefined;}
async function officialJson(url:URL,provider:CatalogProvider,key:string|undefined,fetcher:typeof fetch):Promise<any>{
  const origin=provider==='curseforge'?'https://api.curseforge.com':'https://api.modrinth.com';
  requireValue(url.origin===origin&&!url.username&&!url.password,'Katalog adresi doğrulanamadı.',400);
  let response:Response;
  try{response=await fetcher(url,{headers:{Accept:'application/json','User-Agent':USER_AGENT,...(provider==='curseforge'?{'x-api-key':key!}:{})},signal:AbortSignal.timeout(15000),redirect:'error'});}catch{throw new ApiError(502,`${provider==='curseforge'?'CurseForge':'Modrinth'} kataloğuna şu anda ulaşılamıyor.`);}
  if(!response.ok){if(provider==='curseforge'&&[401,403].includes(response.status))throw new ApiError(502,'CurseForge API anahtarı reddedildi. Anahtarın geçerli ve API erişiminin açık olduğunu kontrol edin.');throw new ApiError(502,`${provider==='curseforge'?'CurseForge':'Modrinth'} kataloğu isteği tamamlanamadı (${response.status}).`);}
  let body:string;try{body=await response.text();}catch{throw new ApiError(502,'Katalog yanıtı okunamadı.');}
  requireValue(body.length<=4*1024*1024,'Katalog yanıtı sınırı aşıldı.',502);try{return JSON.parse(body);}catch{throw new ApiError(502,'Katalog geçersiz veri döndürdü.');}
}
export async function searchCatalog(options:CatalogOptions,dependencies:{fetcher?:typeof fetch}={}):Promise<CatalogItem[]> {
  const {provider,game,loader,version,query,curseforgeApiKey:key}=options;const fetcher=dependencies.fetcher??fetch;
  requireValue(['modrinth','curseforge'].includes(provider),'Mod sağlayıcısı geçersiz.');
  requireValue(game==='minecraft','Mod katalogları şu anda Minecraft sunucuları için kullanılabilir.',422);
  requireValue(typeof query==='string'&&query.length<=80&&/^[a-zA-Z0-9_.-]{1,32}$/.test(version),'Katalog filtresi geçersiz.');
  requireValue(MODRINTH_LOADERS.has(loader),'Bu sunucu yazılımında JAR mod/eklenti kurulumu desteklenmiyor.',422);
  if(provider==='modrinth'){
    const plugins=PLUGIN_LOADERS.has(loader);const loaders=plugins?['paper','spigot','bukkit']:[loader];
    // Modrinth v2 keeps server_side for backwards compatibility. Required/optional
    // explicitly excludes client-only projects before any download is offered.
    const facets=[plugins?['all_project_types:plugin','project_type:plugin','project_type:mod']:['project_type:mod'],loaders.map(name=>`categories:${name}`),[`versions:${version}`],['server_side:required','server_side:optional']];
    const url=new URL('https://api.modrinth.com/v2/search');url.searchParams.set('query',query);url.searchParams.set('limit','12');url.searchParams.set('facets',JSON.stringify(facets));
    const body=await officialJson(url,provider,undefined,fetcher);const hits=Array.isArray(body.hits)?body.hits:[];
    return hits.filter((hit:any)=>hit.server_side!=='unsupported'&&!(Array.isArray(hit.environment)&&hit.environment.length&&hit.environment.every((environment:string)=>['client_only','singleplayer_only'].includes(environment)))).map((hit:any)=>{
      const projectId=String(hit.project_id??'');const compatible=Array.isArray(hit.versions)&&hit.versions.includes(version)&&Array.isArray(hit.categories)&&loaders.some(name=>hit.categories.includes(name));
      const validId=/^[a-zA-Z0-9_-]{1,80}$/.test(projectId);return {id:`modrinth:${projectId}`,projectId,provider,name:String(hit.title??projectId),author:String(hit.author??'Modrinth'),description:String(hit.description??''),downloads:Number(hit.downloads??0),iconUrl:safeUrl(hit.icon_url,['cdn.modrinth.com']),url:`https://modrinth.com/${plugins?'plugin':'mod'}/${encodeURIComponent(hit.slug??projectId)}`,compatible,installable:compatible&&validId,serverSideVerified:true,...(!compatible?{reason:'Seçilen Minecraft sürümü ve yükleyiciyle uyumlu değil.'}:{})};
    });
  }
  requireValue(!!key,'CurseForge için bir API anahtarı gerekli. Sunucu ayarlarına ekleyin.',409);
  requireValue(CF_LOADERS[loader]!==undefined,'CurseForge mod kataloğu bu sunucu yazılımını desteklemiyor.',422);
  const url=new URL('https://api.curseforge.com/v1/mods/search');url.searchParams.set('gameId','432');url.searchParams.set('classId','6');url.searchParams.set('searchFilter',query);url.searchParams.set('gameVersion',version);url.searchParams.set('modLoaderType',String(CF_LOADERS[loader]));url.searchParams.set('pageSize','12');url.searchParams.set('sortField',query?'1':'2');url.searchParams.set('sortOrder','desc');
  const body=await officialJson(url,provider,key,fetcher);const projects=Array.isArray(body.data)?body.data.slice(0,12):[];
  return Promise.all(projects.map(async(project:any):Promise<CatalogItem>=>{
    const projectId=String(project.id??'');const item:CatalogItem={id:`curseforge:${projectId}`,projectId,provider,name:String(project.name??projectId),author:(project.authors??[]).map((author:any)=>String(author.name??'')).filter(Boolean).join(', ')||'CurseForge',description:String(project.summary??''),downloads:Number(project.downloadCount??0),iconUrl:safeUrl(project.logo?.thumbnailUrl??project.logo?.url,CF_CDN),url:safeUrl(project.links?.websiteUrl,['www.curseforge.com','curseforge.com']),compatible:false,installable:false,serverSideVerified:false};
    if(!/^\d{1,12}$/.test(projectId))return {...item,reason:'Proje kimliği doğrulanamadı.'};
    if(project.allowModDistribution===false)return {...item,reason:'Mod yazarı üçüncü taraf uygulamalar üzerinden indirmeye izin vermiyor.'};
    if(project.isAvailable===false)return {...item,reason:'Bu proje şu anda indirmeye açık değil.'};
    const filesUrl=new URL(`https://api.curseforge.com/v1/mods/${projectId}/files`);filesUrl.searchParams.set('gameVersion',version);filesUrl.searchParams.set('modLoaderType',String(CF_LOADERS[loader]));filesUrl.searchParams.set('pageSize','50');
    const files=await officialJson(filesUrl,provider,key,fetcher);const compatible=(Array.isArray(files.data)?files.data:[]).filter((file:any)=>Number(file.modId)===Number(projectId)&&file.isAvailable!==false&&file.releaseType===1&&Array.isArray(file.gameVersions)&&file.gameVersions.includes(version)&&file.gameVersions.some((name:string)=>name.toLowerCase()===loader)).sort((a:any,b:any)=>(Date.parse(b.fileDate)||0)-(Date.parse(a.fileDate)||0)||Number(b.id)-Number(a.id));
    const chosen=compatible.find((file:any)=>typeof file.fileName==='string'&&/^[A-Za-z0-9._+()\- ]{1,180}\.jar$/.test(file.fileName));
    if(!chosen)return {...item,reason:'Bu Minecraft sürümü ve yükleyici için uyumlu kararlı JAR dosyası bulunamadı.'};
    const downloadUrl=safeUrl(chosen.downloadUrl,CF_CDN);const verifiedHash=(chosen.hashes??[]).some((hash:any)=>hash.algo===1&&/^[a-fA-F0-9]{40}$/.test(hash.value??''));
    return {...item,compatible:true,installable:!!downloadUrl&&verifiedHash,version:String(chosen.displayName??chosen.fileName),versionId:String(chosen.id),...(!downloadUrl?{reason:'Yazarın dağıtım ayarları nedeniyle API güvenli bir indirme adresi sağlamıyor.'}:!verifiedHash?{reason:'Dosyanın doğrulanabilir SHA1 özeti bulunamadı.'}:{})};
  }));
}
