import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../server/db.js';
import {normalizePolicy,accessPolicy} from '../server/permissions.js';

test('permission dependencies fail closed even when several prerequisite levels are missing',()=>{
 assert.deepEqual(normalizePolicy({tabs:['players'],actions:['inventory.read','inventory.write']}),{tabs:['players'],actions:[]});
 assert.deepEqual(normalizePolicy({tabs:['players'],actions:['players.read','players.roles','chat.send']}),{tabs:['players'],actions:['players.read','players.roles']});
 assert.deepEqual(accessPolicy('custom','invalid'),{tabs:[],actions:[]});
});

test('legacy sample cleanup preserves real accounts, remote secrets and memberships',()=>{
 const directory=mkdtempSync(join(tmpdir(),'ssp-migration-'));let store=openDatabase(directory);
 try{
  store.db.exec('ALTER TABLE users ADD COLUMN demo INTEGER NOT NULL DEFAULT 0');
  const insert=store.db.prepare('INSERT INTO users(id,username,password,demo) VALUES(?,?,?,?)');insert.run('real','Real','hash',0);insert.run('sample','Sample','hash',1);
  store.db.prepare('INSERT INTO servers VALUES(?,?,?,?)').run('real-server','real',JSON.stringify({server:{id:'real-server',demo:false,name:'Existing'}}),store.encrypt({password:'keep-this'}));
  store.db.prepare('INSERT INTO servers VALUES(?,?,?,?)').run('sample-server','sample',JSON.stringify({server:{id:'sample-server',demo:true}}),store.encrypt({}));
  store.db.prepare('INSERT INTO members(server_id,user_id,role) VALUES(?,?,?)').run('real-server','real','owner');store.db.prepare('INSERT INTO members(server_id,user_id,role) VALUES(?,?,?)').run('sample-server','sample','owner');store.close();
  store=openDatabase(directory);assert.equal((store.db.prepare('SELECT count(*) AS n FROM users').get() as any).n,1);assert.equal((store.db.prepare('SELECT count(*) AS n FROM servers').get() as any).n,1);assert.equal((store.db.prepare('SELECT count(*) AS n FROM members').get() as any).n,1);
  const row=store.db.prepare('SELECT * FROM servers').get() as any;assert.equal(row.id,'real-server');assert.equal(store.decrypt(row.secrets).password,'keep-this');assert.equal(JSON.parse(row.data).server.demo,undefined);assert(!(store.db.prepare('PRAGMA table_info(users)').all() as any[]).some(row=>row.name==='demo'));
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
