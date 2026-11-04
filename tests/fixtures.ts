import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.js';
// Remote responses for tests only. The application has no sample login or data route.
export const connection={type:'ssh',host:'server.example',port:22,username:'ssp',password:'remote-test-password',hostFingerprint:'SHA256:'+'a'.repeat(43)};
export const candidate={directory:'/srv/minecraft',game:'minecraft',edition:'neoforge',version:'1.21.1',status:'running',port:25565,maxPlayers:32,playersOnline:2,playersTotal:7,mods:[{id:'local:example.jar',name:'Example',version:'1.0',managed:false}],metrics:{memory:1.5,memoryTotal:4,machineMemoryTotal:16,disk:12,diskTotal:100},warnings:[]};
export function testRemote(){
 const state:any={status:'running',players:Array.from({length:7},(_,i)=>({uuid:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,name:['North','Birch','Stone','River','Valley','Oak','Fox'][i],online:i<2,ping:35+i*12,playTime:3600*(i+1),role:'player',banned:false})),chat:[],mods:candidate.mods,metrics:{...candidate.metrics,cpu:12,tps:20,uptime:3600},console:[{timestamp:new Date().toISOString(),level:'INFO',message:'Server started'}],inventoryProviders:[{id:'main',name:'Inventory',capacity:36,writable:true},{id:'backpack',name:'Backpack',capacity:27,writable:true}]};
 const inventory:any={provider:'main',slots:[{slot:0,item:'minecraft:diamond',count:3,data:Buffer.from('custom-item').toString('base64')}],capacity:36,writable:true};let scans=0,probes=0,requests=0;
 const services={
  probeSsh:async(config:any)=>{probes++;if(!config.hostFingerprint)return {verified:false,fingerprint:connection.hostFingerprint};if(config.hostFingerprint!==connection.hostFingerprint||config.password!==connection.password)throw new Error('SSH authentication failed');return {verified:true,fingerprint:connection.hostFingerprint};},
  inspectExistingServer:async(_config:any,_options:any)=>{scans++;return {...structuredClone(candidate),candidates:[structuredClone(candidate)],machine:{ramGb:16,diskGb:12,diskTotalGb:100},observedAt:'2026-11-04T12:00:00.000Z',source:'ssh-discovery'};},
  adapterRequest:async(_server:any,path:string,method='GET',body?:any)=>{requests++;
   if(path==='/state')return structuredClone(state);
   if(path.includes('/inventory')){if(method==='PUT')inventory.slots=structuredClone(body.slots);return structuredClone(inventory);}
   if(path.startsWith('/players/')&&method==='PATCH'){const player=state.players.find((p:any)=>path.endsWith(p.uuid));if(!player)throw new Error('Player missing');Object.assign(player,body);return {ok:true};}
   if(path==='/chat'){state.chat.push({id:String(state.chat.length+1),player:'SSP',message:body.message,type:'public',timestamp:new Date().toISOString()});return {ok:true};}
   if(path==='/power'){state.status=body.action==='stop'?'stopped':'running';return {ok:true};}
   return {ok:true};
  }
 };
 return {state,inventory,services,get scans(){return scans;},get probes(){return probes;},get requests(){return requests;}};
}
export async function fixture(run:(context:any)=>Promise<void>,overrides:NonNullable<Parameters<typeof createApp>[0]>['services']={}){
 const remote=testRemote(),dataDir=mkdtempSync(join(tmpdir(),'ssp-test-')),app=createApp({dataDir,services:{...remote.services,...overrides}}),listener=app.listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>listener.once('listening',resolve));const base=`http://127.0.0.1:${(listener.address() as any).port}`;
 function client(){let cookie='',csrf='';return {get csrf(){return csrf;},async request(path:string,method='GET',body?:any,extra:Record<string,string>={}){const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie')!.split(';')[0];const json:any=await response.json();if(json.csrfToken)csrf=json.csrfToken;return {status:response.status,body:json,headers:response.headers};}};}
 async function register(target:any,username='Owner',extra:any={}){return target.request('/api/auth/register','POST',{username,password:'correct horse battery staple',mode:'own',connection,...extra});}
 function connectBridge(id:string){const store=app.locals.store,row=store.db.prepare('SELECT secrets FROM servers WHERE id=?').get(id) as any;store.db.prepare('UPDATE servers SET secrets=? WHERE id=?').run(store.encrypt({...store.decrypt(row.secrets),bridgeToken:'b'.repeat(64)}),id);}
 try{await run({app,store:app.locals.store,base,client,dataDir,remote,register,connectBridge});}finally{await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));app.locals.close();rmSync(dataDir,{recursive:true,force:true});}
}
