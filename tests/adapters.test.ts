import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import ssh2 from 'ssh2';
import http from 'node:http';
import net from 'node:net';
import {adapterRequest,createInstallPlan,inspectExistingServer,probeSsh,runInstallation,runSshPython,shellQuote} from '../server/adapters.js';
const {Server} = ssh2;

test('shell quoting keeps apostrophes, substitutions and newlines inside one literal',()=>{
  assert.equal(shellQuote("a'b;$(id)\n"), "'a'\\''b;$(id)\n'");
});
test('installer rejects interpolation and requires explicit Minecraft EULA',async()=>{
  await assert.rejects(createInstallPlan({game:'minecraft',edition:'paper',version:'1.21.4;whoami',eulaAccepted:true}),/geçersiz/);
  await assert.rejects(createInstallPlan({game:'minecraft',edition:'paper',version:'1.21.4'}),/EULA/);
  await assert.rejects(createInstallPlan({id:'../world',game:'minecraft',eulaAccepted:true}),/geçersiz/);
  const unsupported = await createInstallPlan({game:'valheim',edition:'vanilla',version:'stable'});
  assert.equal(unsupported.supported,false); assert.equal(unsupported.mode,'manual');
  await assert.rejects(runInstallation({host:'example.com',username:'user',password:'pass'},unsupported),/uygun değil/);
});
test('Paper plan uses stable official artifact and checksum and never runs the world',async()=>{
  const original = globalThis.fetch;
  globalThis.fetch = (async()=>new Response(JSON.stringify([
    {channel:'ALPHA',downloads:{'server:default':{url:'https://evil.example/x.jar'}}},
    {channel:'STABLE',downloads:{'server:default':{url:'https://fill-data.papermc.io/v1/objects/hash/paper.jar',checksums:{sha256:'a'.repeat(64)}}}}
  ]),{status:200})) as typeof fetch;
  try {
    const plan = await createInstallPlan({id:'abc-123',game:'minecraft',edition:'paper',version:'1.21.4',eulaAccepted:true});
    assert.equal(plan.supported,true); assert.equal(plan.artifact?.hash,'a'.repeat(64));
    assert.equal(plan.directory,'ssp-servers/abc-123');
    assert.match(plan.steps[2].command,/sha256sum --check/);
    assert.match(plan.steps[0].command,/Java 21/);
    assert.equal(plan.steps.some(step => step.command.includes('./start.sh\n')),false);
  } finally { globalThis.fetch = original; }
});
test('Paper installer rejects compromised artifact hosts and missing checksum',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=(async()=>new Response(JSON.stringify([{channel:'STABLE',downloads:{'server:default':{url:'https://evil.example/paper.jar',checksums:{sha256:'a'.repeat(64)}}}}]),{status:200})) as typeof fetch;
  try { await assert.rejects(createInstallPlan({game:'minecraft',edition:'paper',version:'1.21.4',eulaAccepted:true}),/adresi/); }
  finally {globalThis.fetch=original;}
});
test('NeoForge selects only matching stable loader, verifies official SHA512 and starts using installed argfiles',async()=>{
  const original=globalThis.fetch;
  const requested:string[]=[];
  globalThis.fetch=(async(input)=>{
    const url=String(input);requested.push(url);
    if(url.endsWith('maven-metadata.xml'))return new Response('<metadata><version>21.1.99</version><version>21.1.209</version><version>21.1.999-beta</version><version>21.4.999</version></metadata>');
    if(url.endsWith('.sha512'))return new Response('b'.repeat(128));
    throw new Error('Unexpected URL');
  }) as typeof fetch;
  try{
    const plan=await createInstallPlan({game:'minecraft',edition:'neoforge',version:'1.21.1',eulaAccepted:true});
    assert.equal(plan.loaderVersion,'21.1.209');assert.equal(plan.artifact?.algorithm,'sha512');
    assert.match(plan.steps[2].command,/sha512sum --check/);
    assert.match(plan.steps[3].command,/java -jar installer.jar --installServer/);
    assert.match(plan.steps[4].command,/@libraries\/net\/neoforged\/neoforge\/21\.1\.209\/unix_args\.txt/);
    assert.equal(requested.length,2);
    await assert.rejects(createInstallPlan({game:'minecraft',edition:'neoforge',version:'1.20.1',eulaAccepted:true}),/kararlı/);
  }finally{globalThis.fetch=original;}
});
test('NeoForge installer refuses missing official checksum',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=(async(input)=>new Response(String(input).endsWith('maven-metadata.xml')?'<version>21.1.209</version>':'not-a-checksum')) as typeof fetch;
  try{await assert.rejects(createInstallPlan({game:'minecraft',edition:'neoforge',version:'1.21.1',eulaAccepted:true}),/SHA512/);}
  finally{globalThis.fetch=original;}
});
test('bridge refuses missing credentials, unsafe paths and cleartext remote HTTP',async()=>{
  await assert.rejects(adapterRequest({},'/state'),/köprüsü/);
  await assert.rejects(adapterRequest({},'//evil.example'),/geçersiz/);
  await assert.rejects(adapterRequest({bridgeToken:'a'.repeat(64),bridgeUrl:'http://example.com'},'/state'),/HTTPS/);
  await assert.rejects(adapterRequest({bridgeToken:'a'.repeat(64),bridgeUrl:'https://user:pass@example.com'},'/state'),/HTTPS/);
});
test('SSH discovery sends no credentials; only a matching pinned key permits authentication and execution',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  let authentications=0, commands=0;
  const server=new Server({hostKeys:[privateKey.export({format:'pem',type:'pkcs1'}).toString()]},client=>{
    client.on('error',()=>{});
    client.on('authentication',ctx=>{authentications++;ctx.accept();});
    client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('exec',(acceptCommand,_reject,info)=>{commands++;assert.equal(info.command,'uname -s');const stream=acceptCommand();stream.write('Linux\n');stream.exit(0);stream.end();});}));
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address() as {port:number};
  const config={host:'127.0.0.1',port:address.port,username:'ssp',password:'private-password'};
  try {
    const discovered=await probeSsh(config);
    assert.match(discovered.fingerprint,/^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.equal(discovered.verified,false); assert.equal(authentications,0);assert.equal(commands,0);
    const verified=await probeSsh({...config,hostFingerprint:discovered.fingerprint});
    assert.equal(verified.verified,true);assert.equal(verified.platform,'Linux');assert.equal(authentications,1);assert.equal(commands,1);
    await assert.rejects(probeSsh({...config,hostFingerprint:'SHA256:'+'A'.repeat(43)}),/eşleşmiyor/);
    assert.equal(authentications,1);assert.equal(commands,1);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
test('live requests use the SSH loopback tunnel, preserve inventory queries and keep the bearer server-side',async()=>{
  const token='a'.repeat(64);
  let tunneledBytes=0;
  const bridge=http.createServer((request,response)=>{
    assert.equal(request.headers.authorization,'Bearer '+token);
    assert.equal(request.url,'/players/abc/inventory?provider=backpack');
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({provider:'backpack',slots:[],capacity:27,writable:true}));
  });
  await new Promise<void>(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  const bridgePort=(bridge.address() as net.AddressInfo).port;
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const server=new Server({hostKeys:[privateKey.export({format:'pem',type:'pkcs1'}).toString()]},client=>{
    client.on('error',()=>{});client.on('authentication',ctx=>ctx.accept());
    client.on('tcpip',(accept,_reject,info)=>{
      assert.equal(info.destIP,'127.0.0.1');assert.equal(info.destPort,bridgePort);
      const stream=accept();stream.on('data',(data:Buffer)=>{tunneledBytes+=data.length;});const upstream=net.connect(bridgePort,'127.0.0.1',()=>{stream.pipe(upstream);upstream.pipe(stream);});
      upstream.on('error',()=>stream.destroy());stream.on('error',()=>upstream.destroy());
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={host:'127.0.0.1',port:(server.address() as net.AddressInfo).port,username:'ssp',password:'secret',bridgePort};
  try {
    const {fingerprint}=await probeSsh(config);
    const result=await adapterRequest({secrets:{connection:{...config,hostFingerprint:fingerprint},bridgeToken:token}},'/players/abc/inventory?provider=backpack');
    assert.equal(result.provider,'backpack');assert.equal(result.capacity,27);assert.ok(tunneledBytes>0,'HTTP payload must travel through SSH channel');
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await new Promise<void>(resolve=>bridge.close(()=>resolve()));
  }
});
test('SSH Python input travels only through stdin and inspection never starts an installer',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const commands:string[]=[];const inputs:any[]=[];
  const server=new Server({hostKeys:[privateKey.export({format:'pem',type:'pkcs1'}).toString()]},client=>{
    client.on('error',()=>{});client.on('authentication',ctx=>ctx.accept());
    client.on('ready',()=>client.on('session',accept=>accept().on('exec',(acceptCommand,_reject,info)=>{
      commands.push(info.command);const stream=acceptCommand();let input='';
      stream.on('data',(block:Buffer)=>{input+=block.toString();});
      stream.on('end',()=>{inputs.push(JSON.parse(input));stream.write(JSON.stringify({candidates:[{directory:'/home/ssp/game',port:25565,status:'running',playersOnline:3}],machine:{ramGb:16},warnings:[]}));stream.exit(0);stream.end();});
    })));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={host:'127.0.0.1',port:(server.address() as net.AddressInfo).port,username:'ssp',password:'secret'};
  try{
    const key=await probeSsh(config);const pinned={...config,hostFingerprint:key.fingerprint};
    await runSshPython(pinned,'import json,sys\nprint(json.dumps({}))',{apiKey:'PRIVATE_API_KEY'});
    const report=await inspectExistingServer(pinned,{directory:'/home/ssp/game'});
    assert.equal(inputs[0].apiKey,'PRIVATE_API_KEY');assert.equal(inputs[1].directory,'/home/ssp/game');
    assert.equal(report.address,'127.0.0.1:25565');assert.equal(report.playersOnline,3);
    assert.ok(commands.every(command=>command.startsWith('python3 -c ')));
    assert.ok(commands.every(command=>!command.includes('PRIVATE_API_KEY')&&!command.includes('--installServer')));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
