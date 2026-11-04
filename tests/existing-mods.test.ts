import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import ssh2 from 'ssh2';
import {probeSsh} from '../server/adapters.js';
import {installExistingMods} from '../server/existing-mods.js';
const {Server}=ssh2;

async function sshFixture(reply:any,run:(config:any,observed:{command:string;input:any})=>Promise<void>) {
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const observed={command:'',input:null as any};
  const clients=new Set<any>();
  const server=new Server({hostKeys:[privateKey]},client=>{
    clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
    client.on('authentication',context=>context.method==='password'&&context.password==='ssh-fixture-password'?context.accept():context.reject(['password']));
    client.on('ready',()=>client.on('session',accept=>accept().on('exec',(accept,_reject,info)=>{
      observed.command=info.command;
      const stream=accept();let raw='';
      stream.on('data',(chunk:Buffer)=>raw+=chunk.toString('utf8'));
      stream.on('end',()=>{observed.input=JSON.parse(raw);stream.write(JSON.stringify(reply));stream.exit(0);stream.end();});
    })));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const config={host:'127.0.0.1',port:address.port,username:'ssp',password:'ssh-fixture-password'};
  try {const discovered=await probeSsh(config);await run({...config,hostFingerprint:discovered.fingerprint},observed);}
  finally {for(const client of clients)client.end();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}

test('existing mod task sends CurseForge key only through verified SSH stdin and leaves game installation out of the command',async()=>{
  await sshFixture({ok:true,mods:[],result:{installed:[]},source:'ssh-one-shot'},async(config,observed)=>{
    const result=await installExistingMods(config,{directory:'/home/ssp/existing game',gameVersion:'1.21.1',loader:'neoforge',provider:'curseforge',projectId:'123',apiKey:'fake-curseforge-secret-value'});
    assert.equal(result.ok,true);
    assert.equal(observed.input.apiKey,'fake-curseforge-secret-value');
    assert.equal(observed.input.directory,'/home/ssp/existing game');
    assert.equal(observed.input.operation,'install');
    assert.ok(observed.input.bridgeSource.includes('def install_mod'));
    assert.equal(observed.command.includes('fake-curseforge-secret-value'),false);
    assert.equal(observed.command.includes('ssh-fixture-password'),false);
    assert.equal(observed.command.includes('--installServer'),false);
  });
});

test('existing mod operation keeps actionable stopped-server errors from the one-shot task',async()=>{
  await sshFixture({error:'Oyun sunucusu çalışıyor; önce durdurun.',status:409},async(config)=>{
    await assert.rejects(installExistingMods(config,{directory:'/home/ssp/server',gameVersion:'1.21.1',loader:'fabric',projectId:'lithium'}),/önce durdurun/);
  });
});
