export const TABS=['overview','console','players','chat','mods','activity','settings'] as const;
export type TabId=typeof TABS[number];
export const ACTION_GROUPS={
 overview:['server.inspect','server.power'],
 console:['console.read','console.execute'],
 players:['players.read','players.moderate','players.roles','inventory.read','inventory.write'],
 chat:['chat.read','chat.send'],
 mods:['mods.read','mods.install','mods.remove'],
 activity:['activity.read','activity.undo'],
 settings:['settings.read','settings.write','connections.manage','invites.manage'],
} as const;
export type ActionId=typeof ACTION_GROUPS[keyof typeof ACTION_GROUPS][number];
export type AccessPolicy={tabs:TabId[];actions:ActionId[]};
const ALL_ACTIONS=Object.values(ACTION_GROUPS).flat() as ActionId[];
const READ_ACTIONS:ActionId[]=['console.read','players.read','chat.read','mods.read','activity.read'];
const OPERATOR_ACTIONS:ActionId[]=[...READ_ACTIONS,'server.inspect','server.power','players.moderate','inventory.read','inventory.write','chat.send','activity.undo'];
export function rolePolicy(role:string):AccessPolicy {
 if(role==='owner'||role==='admin')return {tabs:[...TABS],actions:[...ALL_ACTIONS]};
 return {tabs:TABS.filter(tab=>tab!=='settings'),actions:role==='operator'?[...OPERATOR_ACTIONS]:[...READ_ACTIONS]};
}
export function normalizePolicy(input:unknown):AccessPolicy {
 if(!input||typeof input!=='object')throw new Error('Özel erişim ayarları gerekli.');
 const value=input as any;
 if(!Array.isArray(value.tabs)||!Array.isArray(value.actions)||!value.tabs.length||value.tabs.some((tab:unknown)=>!TABS.includes(tab as TabId))||value.actions.some((action:unknown)=>!ALL_ACTIONS.includes(action as ActionId)))throw new Error('Özel erişim ayarları geçersiz.');
 const tabs=TABS.filter(tab=>value.tabs.includes(tab));
 let actions=ALL_ACTIONS.filter(action=>value.actions.includes(action)&&tabs.some(tab=>(ACTION_GROUPS[tab] as readonly string[]).includes(action)));
 const dependency:Partial<Record<ActionId,ActionId>>={'console.execute':'console.read','players.moderate':'players.read','players.roles':'players.read','inventory.read':'players.read','inventory.write':'inventory.read','chat.send':'chat.read','mods.install':'mods.read','mods.remove':'mods.read','activity.undo':'activity.read','settings.write':'settings.read','connections.manage':'settings.read','invites.manage':'settings.read'};
 let previous=-1;while(previous!==actions.length){previous=actions.length;actions=actions.filter(action=>!dependency[action]||actions.includes(dependency[action]!));}
 return {tabs,actions};
}
export function accessPolicy(role:string,stored?:string|null):AccessPolicy {
 if(role!=='custom')return rolePolicy(role);
 try{return normalizePolicy(JSON.parse(stored||'{}'));}catch{return {tabs:[],actions:[]};}
}
export function can(access:AccessPolicy,action:string){return access.actions.includes(action as ActionId);}
export function canDelegate(grantor:AccessPolicy,requested:AccessPolicy){return requested.tabs.every(tab=>grantor.tabs.includes(tab))&&requested.actions.every(action=>grantor.actions.includes(action));}
