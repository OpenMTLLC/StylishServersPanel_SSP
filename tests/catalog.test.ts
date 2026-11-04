import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalogProviders,searchCatalog} from '../server/catalog.js';
import {ApiError} from '../server/domain.js';

test('Modrinth search filters server-side and NeoForge compatibility',async()=>{
  let observed:URL|undefined;
  const fetcher:typeof fetch=async(input,init)=>{observed=new URL(String(input));assert.equal(init?.redirect,'error');return Response.json({hits:[{project_id:'serverMod',title:'Server mod',author:'Author',description:'Works on server',versions:['1.21.1'],categories:['neoforge'],server_side:'required'},{project_id:'clientMod',title:'Client only',versions:['1.21.1'],categories:['neoforge'],server_side:'unsupported'},{project_id:'otherVersion',title:'Old mod',versions:['1.20.1'],categories:['forge'],server_side:'optional'}]});};
  const result=await searchCatalog({provider:'modrinth',query:'performance',game:'minecraft',loader:'neoforge',version:'1.21.1'},{fetcher});
  assert(observed);const facets=JSON.parse(observed.searchParams.get('facets')!);assert(facets.some((facet:string[])=>facet.includes('categories:neoforge')));assert(facets.some((facet:string[])=>facet.includes('server_side:required')&&facet.includes('server_side:optional')));assert.equal(result.length,2);assert.equal(result[0].id,'modrinth:serverMod');assert.equal(result[0].installable,true);assert.equal(result[1].compatible,false);assert.equal(result[1].installable,false);
});
test('CurseForge uses official key header, Minecraft mod filters and NeoForge enum 6',async()=>{
  const key='private-test-key-do-not-return';const calls:URL[]=[];
  const file={id:91,fileName:'example.jar',displayName:'Example1.0',releaseType:1,isAvailable:true,gameVersions:['1.21.1','NeoForge'],downloadUrl:'https://edge.forgecdn.net/files/1/2/example.jar',hashes:[{algo:1,value:'a'.repeat(40)}]};
  const fetcher:typeof fetch=async(input,init)=>{const url=new URL(String(input));calls.push(url);assert.equal(url.origin,'https://api.curseforge.com');assert.equal(new Headers(init?.headers).get('x-api-key'),key);assert(!url.href.includes(key));if(url.pathname==='/v1/mods/search'){assert.equal(url.searchParams.get('gameId'),'432');assert.equal(url.searchParams.get('classId'),'6');assert.equal(url.searchParams.get('modLoaderType'),'6');assert.equal(url.searchParams.get('gameVersion'),'1.21.1');return Response.json({data:[{id:1,name:'Allowed',allowModDistribution:true},{id:2,name:'Blocked author',allowModDistribution:false},{id:3,name:'No download URL',allowModDistribution:true}]});}return Response.json({data:[{...file,modId:Number(url.pathname.split('/')[3]),...(url.pathname.includes('/3/')?{downloadUrl:null}:{})}]});};
  const result=await searchCatalog({provider:'curseforge',query:'backpack',game:'minecraft',loader:'neoforge',version:'1.21.1',curseforgeApiKey:key},{fetcher});
  assert.equal(result[0].id,'curseforge:1');assert.equal(result[0].installable,true);assert.equal(result[0].versionId,'91');assert.equal(result[1].installable,false);assert.match(result[1].reason!,/yazarı/);assert(!calls.some(url=>url.pathname==='/v1/mods/2/files'));assert.equal(result[2].installable,false);assert.match(result[2].reason!,/indirme adresi/);assert(!JSON.stringify(result).includes(key));
});
test('CurseForge missing key is explicit and no request is sent',async()=>{
  let calls=0;const fetcher:typeof fetch=async()=>{calls++;return Response.json({});};
  await assert.rejects(searchCatalog({provider:'curseforge',query:'',game:'minecraft',loader:'fabric',version:'1.21.1'},{fetcher}),(error:any)=>error instanceof ApiError&&error.status===409&&/anahtarı/.test(error.message));assert.equal(calls,0);assert.equal(catalogProviders(undefined)[1].available,false);assert.equal(catalogProviders(undefined)[1].keyConfigured,false);assert.equal(catalogProviders('configured','minecraft','neoforge')[1].available,true);
});
test('API failures cannot echo keys or upstream response bodies',async()=>{
  const key='secret-key-1234567890';const options={provider:'curseforge' as const,query:'',game:'minecraft',loader:'forge',version:'1.21.1',curseforgeApiKey:key};
  const fetcher:typeof fetch=async()=>new Response(key,{status:403});await assert.rejects(searchCatalog(options,{fetcher}),(error:any)=>error.status===502&&!error.message.includes(key)&&/reddedildi/.test(error.message));
  const failed:typeof fetch=async()=>{throw new Error(`Network failed ${key}`);};await assert.rejects(searchCatalog(options,{fetcher:failed}),(error:any)=>!error.message.includes(key));
});
test('unverified CDN and beta artifacts cannot be advertised as installable',async()=>{
  const fetcher:typeof fetch=async(input)=>new URL(String(input)).pathname.endsWith('/search')?Response.json({data:[{id:1,name:'Unsafe mirror'},{id:2,name:'Beta only'}]}):Response.json({data:[{id:91,modId:Number(new URL(String(input)).pathname.split('/')[3]),fileName:'example.jar',releaseType:String(input).includes('/2/')?2:1,isAvailable:true,gameVersions:['1.21.1','Fabric'],downloadUrl:'https://untrusted.example/example.jar',hashes:[{algo:1,value:'a'.repeat(40)}]}]});
  const result=await searchCatalog({provider:'curseforge',query:'',game:'minecraft',loader:'fabric',version:'1.21.1',curseforgeApiKey:'configured-key'},{fetcher});assert.equal(result[0].installable,false);assert.equal(result[1].compatible,false);assert.equal(result[1].installable,false);
});
test('CurseForge chooses the newest matching project file and accepts safe names with spaces',async()=>{
  const artifact={isAvailable:true,releaseType:1,gameVersions:['1.21.1','NeoForge'],downloadUrl:'https://edge.forgecdn.net/files/1/2/example.jar',hashes:[{algo:1,value:'a'.repeat(40)}]};
  const fetcher:typeof fetch=async(input)=>new URL(String(input)).pathname.endsWith('/search')?Response.json({data:[{id:55,name:'Backpack',allowModDistribution:true}]}):Response.json({data:[{...artifact,id:999,modId:999,fileName:'wrong-project.jar',fileDate:'2026-11-04T12:00:00Z'},{...artifact,id:90,modId:55,fileName:'old.jar',fileDate:'2025-01-01T00:00:00Z'},{...artifact,id:92,modId:55,fileName:'Example Mod (1).jar',fileDate:'2026-01-01T00:00:00Z'}]});
  const result=await searchCatalog({provider:'curseforge',query:'',game:'minecraft',loader:'neoforge',version:'1.21.1',curseforgeApiKey:'configured-key'},{fetcher});assert.equal(result[0].versionId,'92');assert.equal(result[0].installable,true);
});
