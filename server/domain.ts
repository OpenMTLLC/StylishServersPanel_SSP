import {accessPolicy,can} from './permissions.js';
import { randomUUID } from 'node:crypto';
import type { Store } from './db.js';

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export function requireValue(condition: unknown, message: string, status = 400): asserts condition { if (!condition) throw new ApiError(status, message); }
export function text(value: unknown, name: string, max = 120, min = 1) { requireValue(typeof value === 'string' && value.trim().length >= min && value.length <= max, `${name} geçerli olmalı (${min}–${max} karakter).`); return value.trim(); }
export const iso = (value = Date.now()) => new Date(value).toISOString();
export function loadServer(store: Store, id: string, userId: string, required = 'viewer') {
  const row: any = store.db.prepare('SELECT s.*,m.role,m.permissions AS custom_permissions FROM servers s JOIN members m ON m.server_id=s.id WHERE s.id=? AND m.user_id=?').get(id,userId);
  requireValue(row, 'Sunucu bulunamadı veya erişim izniniz yok.',404);
  const access=accessPolicy(row.role,row.custom_permissions);
  const legacy:Record<string,string>={viewer:'server.view',operator:'server.power',admin:'settings.write'};
  const action=legacy[required]??required;
  requireValue(action==='server.view'?access.tabs.length>0:can(access,action),'Bu işlem için yetkiniz yok.',403);
  return {row,data:JSON.parse(row.data),secrets:store.decrypt(row.secrets),role:row.role,access};
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
