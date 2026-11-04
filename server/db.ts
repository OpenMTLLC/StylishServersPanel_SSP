import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function passwordHash(password: string) { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
export function verifyPassword(password: string, hash: string) { try { const [salt, expected] = hash.split(':'); return timingSafeEqual(Buffer.from(expected, 'hex'), scryptSync(password, salt, 64)); } catch { return false; } }

export function openDatabase(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'master.key');
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('SSP ana şifreleme anahtarı geçersiz.');
  const db = new DatabaseSync(join(directory, 'ssp.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL, secrets TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members(server_id TEXT REFERENCES servers(id), user_id TEXT REFERENCES users(id), role TEXT NOT NULL, PRIMARY KEY(server_id,user_id));
    CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,server_id TEXT REFERENCES servers(id),code_hash TEXT UNIQUE NOT NULL,role TEXT NOT NULL,expires INTEGER NOT NULL,redeemed_by TEXT,revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS activities(id TEXT PRIMARY KEY, server_id TEXT REFERENCES servers(id), actor_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, timestamp INTEGER NOT NULL, inverse TEXT, undone INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS activities_server_time ON activities(server_id,timestamp DESC);
    CREATE INDEX IF NOT EXISTS sessions_expiration ON sessions(expires);
  `);
  // Schema migration also removes only the former sample environment.
  const hasColumn=(table:string,column:string)=>(db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some(row=>row.name===column);
  if(!hasColumn('members','permissions'))db.exec('ALTER TABLE members ADD COLUMN permissions TEXT');
  if(!hasColumn('members','invite_id'))db.exec('ALTER TABLE members ADD COLUMN invite_id TEXT');
  if(!hasColumn('invites','permissions'))db.exec('ALTER TABLE invites ADD COLUMN permissions TEXT');
  if(hasColumn('users','demo')) {
    db.exec(`BEGIN IMMEDIATE;
      DELETE FROM activities WHERE server_id IN (SELECT id FROM servers WHERE json_extract(data,'$.server.demo')=1);
      DELETE FROM invites WHERE server_id IN (SELECT id FROM servers WHERE json_extract(data,'$.server.demo')=1);
      DELETE FROM members WHERE server_id IN (SELECT id FROM servers WHERE json_extract(data,'$.server.demo')=1);
      DELETE FROM servers WHERE json_extract(data,'$.server.demo')=1;
      DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE demo=1);
      DELETE FROM members WHERE user_id IN (SELECT id FROM users WHERE demo=1);
      DELETE FROM users WHERE demo=1;
      UPDATE servers SET data=json_remove(data,'$.server.demo');
      ALTER TABLE users DROP COLUMN demo;
      COMMIT;`);
  }
  function encrypt(value: unknown) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]); return `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${encrypted.toString('hex')}`; }
  function decrypt(value: string): any { const [iv, tag, encrypted] = value.split('.'); const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex')); cipher.setAuthTag(Buffer.from(tag, 'hex')); return JSON.parse(Buffer.concat([cipher.update(Buffer.from(encrypted, 'hex')), cipher.final()]).toString('utf8')); }
  return { db, encrypt, decrypt, close: () => db.close() };
}
export type Store = ReturnType<typeof openDatabase>;
