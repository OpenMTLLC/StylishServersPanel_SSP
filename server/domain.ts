import { randomUUID } from 'node:crypto';
import type { Store } from './db.js';

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export function requireValue(condition: unknown, message: string, status = 400): asserts condition { if (!condition) throw new ApiError(status, message); }
export function text(value: unknown, name: string, max = 120, min = 1) { requireValue(typeof value === 'string' && value.trim().length >= min && value.length <= max, `${name} geçerli olmalı (${min}–${max} karakter).`); return value.trim(); }
export const iso = (value = Date.now()) => new Date(value).toISOString();
export function makeDemo(name = 'Survival • Ana Dünya') {
  const players = [
    ['Notch', 28, 189720, true, 'admin'], ['EnderWalker', 42, 98460, true, 'moderator'], ['PixelCraft', 18, 76680, true, 'player'], ['LunaBuilds', 56, 55440, true, 'player'], ['DiamondHunter', 0, 130200, false, 'player'], ['Alex', 0, 41400, false, 'player'],
  ].map(([name,ping,playTime,online,role]) => ({uuid: randomUUID(), name,ping,playTime,online,role,banned:false}));
  const now = Date.now();
  const chat = [
    {player:'EnderWalker',type:'global',message:'Herkese merhaba! Yeni dünyaya hoş geldiniz.'},
    {player:'PixelCraft',type:'global',message:'Spawn alanındaki yeni yapıyı gördünüz mü?'},
    {player:'LunaBuilds',type:'global',message:'Evet! Birlikte inşa etmek çok keyifliydi ✦'},
    {player:'Notch',recipient:'LunaBuilds',type:'whisper',message:'Akşam etkinliği için hazır mısın?'},
    {player:'PixelCraft',type:'command',message:'/home base'},
    {player:'LunaBuilds',recipient:'Notch',type:'whisper',message:'Hazırım, birazdan geliyorum.'},
    {player:'EnderWalker',type:'global',message:'Birazdan keşfe çıkıyoruz, katılmak isteyen var mı?'},
  ].map((entry,i) => ({...entry,id:randomUUID(),timestamp:iso(now-(7-i)*45000)}));
  const server = { id:randomUUID(),name,game:'minecraft',edition:'fabric',version:'1.21.1',status:'running',address:'demo.ssp.local:25565',maxPlayers:20,demo:true,retentionDays:90,undoEnabled:true,connection:{host:'demo.ssp.local',port:22,username:'ssp'},createdAt:iso() };
  const inventories: Record<string,Record<string,unknown>> = {};
  for (const player of players) inventories[player.uuid] = {
    main:{provider:'main',capacity:36,writable:true,slots:[{slot:0,item:'minecraft:diamond_sword',count:1},{slot:1,item:'minecraft:diamond_pickaxe',count:1},{slot:2,item:'minecraft:oak_log',count:64},{slot:3,item:'minecraft:golden_apple',count:8},{slot:9,item:'minecraft:diamond',count:24},{slot:10,item:'minecraft:bread',count:32}]},
    backpack:{provider:'backpack',capacity:27,writable:true,slots:[{slot:0,item:'minecraft:emerald',count:16},{slot:1,item:'minecraft:torch',count:64},{slot:8,item:'minecraft:iron_ingot',count:32}]}
  };
  return {server,players,chat,inventories,mods:[
    {id:'fabric-api',name:'Fabric API',version:'0.102.1',author:'FabricMC',description:'Fabric modları için ortak kütüphaneler.',enabled:true,provider:'Modrinth'},
    {id:'ferrite-core',name:'FerriteCore',version:'7.0.2',author:'malte0811',description:'Sunucuda bellek kullanımını azaltan optimizasyonlar.',enabled:true,provider:'Modrinth'},
    {id:'travelersbackpack',name:'Traveler’s Backpack',version:'10.1.1',author:'Tiviacz1337',description:'Oyuncular için genişletilebilir sırt çantaları.',enabled:true,provider:'Modrinth'},
    {id:'lithium',name:'Lithium',version:'0.14.0',author:'CaffeineMC',description:'Sunucu oyun mantığı için performans iyileştirmeleri.',enabled:true,provider:'Modrinth'},
  ],metrics:{cpu:23,memory:3.2,memoryTotal:8,disk:12.4,diskTotal:80,tps:20,uptime:104820,networkIn:1.2,networkOut:4.8},console:[{timestamp:iso(now-60000),level:'INFO',message:'[SSP Demo] Örnek sunucu çalışıyor. Gerçek bağlantı kurulmadı.'},{timestamp:iso(now-30000),level:'INFO',message:'[Server] 4 oyuncu çevrimiçi. Dünya kaydedildi.'}],inventoryProviders:[{id:'main',name:'Ana envanter',capacity:36,writable:true},{id:'backpack',name:'Gezgin çantası',capacity:27,writable:true,mod:'Traveler’s Backpack'}],install:{status:'idle',logs:[],plan:null}};
}

export function loadServer(store: Store, id: string, userId: string, required = 'viewer') {
  const row: any = store.db.prepare('SELECT s.*,m.role FROM servers s JOIN members m ON m.server_id=s.id WHERE s.id=? AND m.user_id=?').get(id,userId);
  requireValue(row, 'Sunucu bulunamadı veya erişim izniniz yok.',404);
  const ranks:Record<string,number> = {viewer:0,operator:1,admin:2,owner:3};
  requireValue(ranks[row.role] >= ranks[required], 'Bu işlem için yetkiniz yok.',403);
  return {row,data:JSON.parse(row.data),secrets:store.decrypt(row.secrets),role:row.role};
}
export function saveServer(store: Store,id: string,data: any) { store.db.prepare('UPDATE servers SET data=? WHERE id=?').run(JSON.stringify(data),id); }
export function audit(store: Store, serverId: string, user: any, action: string, detail: string, inverse: any = null) { const id=randomUUID(); store.db.prepare('INSERT INTO activities(id,server_id,actor_id,actor,action,detail,timestamp,inverse) VALUES(?,?,?,?,?,?,?,?)').run(id,serverId,user.id,user.username,action,detail,Date.now(),inverse ? JSON.stringify(inverse):null); return id; }
export function pruneActivities(store: Store,serverId: string,days: number) { store.db.prepare('DELETE FROM activities WHERE server_id=? AND timestamp<?').run(serverId,Date.now()-days*86400000); }
export function activityList(store: Store,serverId: string,userId: string,enabled: boolean) {
  const rows:any[] = store.db.prepare('SELECT rowid AS sequence,* FROM activities WHERE server_id=? ORDER BY timestamp DESC,rowid DESC LIMIT 200').all(serverId) as any[];
  const window = rows.filter(r=>r.actor_id===userId && r.inverse && !r.action.startsWith('undo:')).slice(0,3);
  const next = window.find(r=>!r.undone);
  return rows.map(r=>({id:r.id,actor:r.actor,action:r.action,detail:r.detail,timestamp:iso(r.timestamp),reversible:!!r.inverse,undone:!!r.undone,canUndo:enabled && next?.id===r.id}));
}
