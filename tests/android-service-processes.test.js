const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Catalog = require("../src/modules/android/service-packages");

// These transport fixtures supply synthetic profile endpoints explicitly.
// Existing-owner authentication is covered by the platform client fixtures.
test.beforeEach(t=>t.mock.method(require('../src/modules/android/platform-services/client'),'retainExisting',async()=>null));

test("Game account UI stays noninteractive without a selected account; account tools retain interaction", {timeout:10000}, async t=>{
  const {spawn}=require('node:child_process'),{once}=require('node:events');
  const wire=require.resolve('../src/modules/android/process-channel');
  for(const accountService of [false,true])await t.test(accountService?'account tools':'game without account broker',async t=>{
    const packageName=accountService?'android':'example.anonymous';
    const supervisor=await require('../src/modules/android/service-processes').prepareConnections({
      config:{packageName,...(accountService?{accountService:1}:{})},
      game:{metadata:{packageName},sourceApk:'/fixture/app.apk',filesRoot:'/fixture/files'},
      installed:{uid:accountService?1000:10020,services:[],release:async()=>{}}
    });
    const child=spawn(process.execPath,['-e',`const net=require('net'),{receive}=require(process.argv[1]);const socket=new net.Socket({fd:5});receive(socket,value=>process.send(value));socket.on('end',()=>process.exit(0));`,wire],{stdio:supervisor.stdio(['ignore','ignore','pipe','ipc'])});
    t.after(async()=>{await supervisor.close();if(child.exitCode==null&&child.signalCode==null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}});
    const message=once(child,'message');await supervisor.connect(child);const [bootstrap]=await message;
    assert.deepEqual(bootstrap.accountPolicy,{interactive:accountService});
    assert.equal(bootstrap.accounts,undefined,'UI policy does not acquire an account broker');
  });
});

test("Profile service declarations stay dormant and actual consumers own demand leases",{timeout:10000},async t=>{
  const {spawn}=require('node:child_process'),{once}=require('node:events');
  const broker=require('../src/modules/android/platform-services/client'),profile=require('../src/modules/android/platform-services/paths');
  const wire=require.resolve('../src/modules/android/process-channel'),calls=[],metadata=[];let released=0;
  t.mock.method(profile,'paths',async(_,role)=>({root:'/fixture/'+role,platformSocket:'/fixture/'+role}));
  t.mock.method(require('../src/modules/android/platform-services/boot-state'),'bootCount',async storage=>{metadata.push(storage.root);return 42;});
  t.mock.method(broker,'acquire',async options=>{
    const call={options,enrolled:[],retired:[],closed:0,states:[]};calls.push(call);
    const role=options.role,identity={packageName:role==='keystore'?'android.keystore':'android',processName:role==='accounts'?'android.accounts':role==='system'?'android.system':'android.keystore',pid:role==='keystore'?100:101,uid:role==='keystore'?1017:1000,hostUid:process.getuid?.()||0,securityContext:role==='keystore'?'u:r:keystore:s0':'u:r:system_server:s0',...(role==='system'?{processStateVersion:1}:{})};
    call.owner={identity,socketPath:'/fixture/'+role,enroll:async(...args)=>call.enrolled.push(args),retire:async peer=>call.retired.push(peer),processState:async(peer,state)=>call.states.push([peer,state]),close:()=>call.closed++};
    return call.owner;
  });
  const connections=await require('../src/modules/android/service-processes').prepareConnections({
    config:{packageName:'example.demand'},game:{metadata:{packageName:'example.demand'},sourceApk:'/app.apk',filesRoot:'/app/files'},
    installed:{services:[],uid:10021,release:async()=>released++},lazyProfileServicesVersion:1,
    platformOptions:{userDataDir:'/fixture',systemServices:true},accountOptions:{userDataDir:'/fixture',account:null,networkAllowed:false}});
  const child=spawn(process.execPath,['-e',`const net=require('net'),{receive,send}=require(process.argv[1]);const socket=new net.Socket({fd:5});receive(socket,value=>process.send(value),()=>process.exit(1));process.on('message',value=>send(socket,value));socket.on('end',()=>process.exit(0));`,wire],{stdio:connections.stdio(['ignore','ignore','pipe','ipc'])});
  const messages=[],waiters=[];child.on('message',value=>{const next=waiters.shift();if(next)next(value);else messages.push(value);});
  const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise(resolve=>waiters.push(resolve));
  t.after(async()=>{await connections.close();if(child.exitCode==null&&child.signalCode==null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}});
  assert.equal(calls.length,0,'Preparing paths cannot acquire profile processes');
  await connections.connect(child);const bootstrap=await next();
  assert.equal(calls.length,0,'Unused owners cannot delay application bootstrap');
  assert.equal(bootstrap.bootCount,42,'Original Settings metadata must precede the first application/provider lookup');
  assert.deepEqual(metadata,['/fixture/system'],'One existing profile counter owner supplies the initial packet');
  assert.equal(JSON.stringify(bootstrap).includes('session'),false,'Host boot identity stays outside the guest packet');
  assert.equal(bootstrap.accounts,undefined);assert.equal(bootstrap.platform,undefined);assert.equal(bootstrap.system,undefined);
  assert.deepEqual(Object.keys(bootstrap.serviceOwners).sort(),['account','keystore','system']);
  assert.deepEqual(connections.sandbox.localSockets.connect,['/fixture/keystore','/fixture/system','/fixture/accounts']);
  const request={op:'connect',packageName:'android',processName:'android.accounts',requestId:'accounts-first'};
  child.send(request);const account=await next();
  assert.equal(account.role,'accounts');assert.equal(account.op,'connect');assert.equal(calls.length,1);
  assert.deepEqual(calls[0].enrolled,[[bootstrap.self,{packages:connections.sandbox.installedPackages,account:null,networkAllowed:false}]]);
  child.send({...request,requestId:'same-activation'});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls.length,1,'Repeated directory demand reuses the consumer activation');
  child.send({op:'disconnect',peer:account.peer,connectionId:account.connectionId});
  for(let i=0;!calls[0].closed&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(calls[0].closed,1);assert.deepEqual(calls[0].retired,[bootstrap.self]);
  child.send({...request,requestId:'accounts-new'});const replacement=await next();assert.equal(calls.length,2);assert.notEqual(replacement.connectionId,account.connectionId);
  child.send({op:'disconnect',peer:account.peer,connectionId:account.connectionId});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(calls[1].closed,0,'Delayed retirement cannot close a replacement activation');
  child.send({op:'connect',packageName:'android',processName:'android.system',requestId:'system'});const system=await next();assert.equal(system.role,'system');
  child.send({op:'process-state',state:2});for(let i=0;!calls[2].states.length&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(calls[2].states,[[bootstrap.self,2]]);
  await connections.close();assert.deepEqual(calls.map(call=>call.closed),[1,1,1]);assert.equal(released,1);
  assert.equal(calls.some(call=>call.options.role==='keystore'),false,'Unrequested KeyStore stays dormant throughout the process lifetime');
});

test("A retired demand releases a late profile acquisition without enrolling a dead consumer",{timeout:10000},async t=>{
  const {spawn}=require('node:child_process'),{once}=require('node:events');
  let permit,started,enrolled=0,closed=0;const gate=new Promise(resolve=>permit=resolve),entered=new Promise(resolve=>started=resolve);
  t.mock.method(require('../src/modules/android/platform-services/paths'),'paths',async()=>({platformSocket:'/fixture/accounts'}));
  t.mock.method(require('../src/modules/android/platform-services/boot-state'),'bootCount',async()=>42);
  t.mock.method(require('../src/modules/android/platform-services/client'),'acquire',async()=>{started();await gate;return{enroll:async()=>enrolled++,retire:async()=>{},close:()=>closed++};});
  const connections=await require('../src/modules/android/service-processes').prepareConnections({config:{packageName:'example.cancel-demand'},game:{metadata:{packageName:'example.cancel-demand'},sourceApk:'/app.apk',filesRoot:'/app/files'},installed:{uid:10000,services:[],release:async()=>{}},lazyProfileServicesVersion:1,accountOptions:{userDataDir:'/fixture'}});
  const child=spawn(process.execPath,['-e',`const net=require('net'),{receive,send}=require(process.argv[1]);const socket=new net.Socket({fd:5});receive(socket,()=>send(socket,{op:'connect',packageName:'android',processName:'android.accounts',requestId:'pending'}));socket.on('end',()=>process.exit(0));`,require.resolve('../src/modules/android/process-channel')],{stdio:connections.stdio(['ignore','ignore','ignore'])});
  t.after(async()=>{permit();await connections.close();if(child.exitCode==null&&child.signalCode==null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}});
  await connections.connect(child);await entered;const stopping=connections.close();await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,0);permit();await stopping;
  assert.equal(enrolled,0);assert.equal(closed,1);
});

test("Profile acquisition failures retain their role and error code without logging private messages",{timeout:10000},async t=>{
  const {spawn}=require('node:child_process'),{once}=require('node:events'),warnings=[];
  t.mock.method(require('../src/modules/android/platform-services/paths'),'paths',async()=>({platformSocket:'/fixture/system'}));
  t.mock.method(require('../src/modules/android/platform-services/boot-state'),'bootCount',async()=>42);
  t.mock.method(require('../src/modules/android/platform-services/client'),'acquire',async()=>{throw Object.assign(Error('PRIVATE_PROFILE_VALUE'),{code:'EBUSY'});});
  const connections=await require('../src/modules/android/service-processes').prepareConnections({
    config:{packageName:'example.busy'},game:{metadata:{packageName:'example.busy'},sourceApk:'/app.apk',filesRoot:'/app/files'},
    installed:{uid:10000,services:[],release:async()=>{}},lazyProfileServicesVersion:1,
    platformOptions:{userDataDir:'/fixture',systemServices:true},logger:{warn:value=>warnings.push(value)}});
  const child=spawn(process.execPath,['-e',`const net=require('net'),{receive,send}=require(process.argv[1]);const socket=new net.Socket({fd:5});receive(socket,value=>{if(value.schemaVersion)send(socket,{op:'connect',packageName:'android',processName:'android.system',requestId:'pending'});else process.send(value);});socket.on('end',()=>process.exit(0));`,require.resolve('../src/modules/android/process-channel')],{stdio:connections.stdio(['ignore','ignore','ignore','ipc'])});
  const response=once(child,'message');
  t.after(async()=>{await connections.close();if(child.exitCode==null&&child.signalCode==null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}});
  await connections.connect(child);const [unavailable]=await response;
  assert.equal(unavailable.op,'unavailable');assert.equal(unavailable.requestId,'pending');
  assert.equal(warnings.length,1);assert.match(warnings[0],/"role":"system"/);assert.match(warnings[0],/"code":"EBUSY"/);
  assert.doesNotMatch(warnings[0],/PRIVATE_PROFILE_VALUE/);
});

test("Cancellation joins pending main enrollment before releasing profile leases",{timeout:10000},async t=>{
  const {spawn}=require('node:child_process'),{once}=require('node:events');
  const profile=require('../src/modules/android/platform-services/paths'),client=require('../src/modules/android/platform-services/client');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-cancel-enrollment-')),controller=new AbortController(),reason=Error('focused launch cancellation');
  let permit,entered;const gate=new Promise(resolve=>permit=resolve),started=new Promise(resolve=>entered=resolve);
  const events=[];let accountClosed=false,released=0;
  t.mock.method(profile,'paths',async(_,role)=>({platformSocket:'/fixture/'+role}));
  t.mock.method(require('../src/modules/android/platform-services/boot-state'),'bootCount',async()=>42);
  t.mock.method(client,'acquire',async()=>({identity:{uid:1000},socketPath:'/fixture/accounts',
    enroll:async()=>{events.push('accounts-enroll');if(accountClosed)throw Error('closed account lease');},retire:async()=>{},close(){accountClosed=true;events.push('accounts-close');}}));
  const system={identity:{uid:1000},socketPath:'/fixture/system',enroll:async()=>{events.push('system-enroll');entered();await gate;events.push('system-enrolled');},retire:async()=>{events.push('system-retire');},close(){throw Error('Borrowed system lease must stay with its owner');}};
  const supervisor=await require('../src/modules/android/service-processes').prepareConnections({
    config:{packageName:'example.cancel'},signal:controller.signal,game:{metadata:{packageName:'example.cancel'},sourceApk:'/app.apk',filesRoot:'/app/files'},
    installed:{uid:10000,services:[],release:async()=>{released++;}},platformOwners:{system},accountOptions:{userDataDir:root,account:null}});
  // Hold the real child alive after authority EOF to model native cleanup while
  // its original system registration is still completing.
  const child=spawn(process.execPath,['-e',"require('fs').createReadStream(null,{fd:5}).resume();setInterval(()=>{},1000)"],{stdio:supervisor.stdio(['ignore','ignore','ignore'])});
  t.after(async()=>{permit();await supervisor.close();if(child.exitCode==null&&child.signalCode==null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}fs.rmSync(root,{recursive:true,force:true});});
  const connecting=supervisor.connect(child);connecting.catch(()=>{});await started;
  controller.abort(reason);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(accountClosed,false,'The account lease stays alive through in-flight main registration');
  permit();await assert.rejects(connecting,error=>error===reason);await supervisor.close();
  assert.ok(events.includes('system-retire'));assert.equal(events.includes('accounts-enroll'),false,'Cancelled initialization cannot progress to the next profile owner');
  assert.equal(accountClosed,true);assert.equal(released,1);assert.ok(events.indexOf('system-enrolled')<events.indexOf('accounts-close'));
});

test("Concurrent installed-service demands share one fully enrolled process before descriptor dispatch",{timeout:10000},async t=>{
  const {spawn}=require('node:child_process'),{once}=require('node:events');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-service-demand-'))),dispatches=path.join(root,'dispatches');
  const helper=path.join(root,'android-supervisor-send');fs.writeFileSync(helper,'#!'+process.execPath+'\nrequire("node:fs").appendFileSync('+JSON.stringify(dispatches)+',"dispatch\\n");\n',{mode:0o700});
  t.mock.method(require('../src/modules/android/clipboard'),'create',()=>({enroll(){},retire(){},close:async()=>{}}));
  let launched=0,permit,enrolled;const enrollment=new Promise(resolve=>enrolled=resolve),gate=new Promise(resolve=>permit=resolve);
  const owner={identity:{uid:1000},enroll:async peer=>{if(peer.uid===10030){enrolled();await gate;}},retire:async()=>{}};
  const prepared=name=>({metadata:{packageName:name},sourceApk:'/runtime/'+name+'.apk',convertedJar:'/runtime/'+name+'.jar',nativeRoot:'/runtime/native',filesRoot:path.join(root,name,'files')});
  const services=['example.second','example.first'].map(packageName=>({record:{packageName,processName:'example.shared',uid:10030},prepared:prepared(packageName)}));
  const wire=require.resolve('../src/modules/android/process-channel');let serviceChild;
  const supervisor=await require('../src/modules/android/service-processes').prepareConnections({
    installed:{services,uid:1000,release:async()=>{}},game:prepared('android'),config:{packageName:'android'},
    descriptorSender:helper,platformOwners:{system:owner},
    launchService:async(service,fields,stdio)=>{launched++;assert.equal(service.record.packageName,'example.first');assert.equal(fields.zygoteCommand,undefined);
      serviceChild=spawn(process.execPath,['-e',`const net=require('net'),{receive}=require(process.argv[1]);const socket=new net.Socket({fd:5});receive(socket,value=>{if(value.schemaVersion)process.stdout.write(JSON.stringify(value)+'\\n');},()=>process.exit(1));socket.on('end',()=>process.exit(0));`,wire],{stdio:stdio.map((value,index)=>index===1?'pipe':value)});return serviceChild;}
  });
  t.after(async()=>{permit();await supervisor.close();if(child.exitCode==null&&child.signalCode==null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}fs.rmSync(root,{recursive:true,force:true});});
  const child=spawn(process.execPath,['-e',`const net=require('net'),{receive,send}=require(process.argv[1]);const socket=new net.Socket({fd:5});receive(socket,value=>{if(value.schemaVersion)send(socket,{op:'connect',packageName:'example.first',processName:'example.shared'});},()=>process.exit(1));process.on('message',async value=>{if(value==='quit')return process.exit(0);await send(socket,{op:'connect',packageName:'example.second',processName:'example.shared'});process.send('second-request-sent');});socket.on('end',()=>process.send('authority-ended'));`,wire],{stdio:supervisor.stdio(['ignore','ignore','pipe','ipc'])});
  await supervisor.connect(child);await enrollment;const sent=once(child,"message");child.send("second");await sent;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(launched,1);assert.equal(fs.existsSync(dispatches),false,'No descriptor dispatch may precede provider enrollment');
  const bootstrap=once(serviceChild.stdout,'data');permit();const packet=JSON.parse(String((await bootstrap)[0]));assert.equal(packet.self.pid,serviceChild.pid);assert.equal(packet.self.uid,10030);
  assert.deepEqual(packet.accountPolicy,{interactive:false},'Background providers inherit the game account policy without an account broker');
  for(let i=0;!fs.existsSync(dispatches)&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(fs.readFileSync(dispatches,'utf8'),'dispatch\n','Shared process aliases must create one connection');
  // A process can remain alive during native teardown after its authority EOF.
  // A peer exit must reject its queued notice, never throw from the exit event.
  const eof=once(child,'message');child.stdio[5].end();assert.equal((await eof)[0],'authority-ended');
  assert.equal(child.exitCode,null);assert.equal(child.stdio[5].writable,false);
  const serviceExited=once(serviceChild,'exit');serviceChild.kill('SIGTERM');await serviceExited;
  const gameExited=once(child,'exit');child.send('quit');await gameExited;
  await supervisor.close();
});

test("Provider enrollment failure retains its structural cause before authority EOF",{timeout:10000},async t=>{
  const {spawn}=require('node:child_process'),{once}=require('node:events');
  const wire=require.resolve('../src/modules/android/process-channel'),warnings=[],children=[];
  const prepared=packageName=>({metadata:{packageName},sourceApk:'/fixture/'+packageName+'.apk',nativeRoot:'/fixture/native',filesRoot:'/fixture/'+packageName+'/files'});
  const owner={identity:{uid:1000},enroll:async peer=>{if(peer.uid===10030)throw Object.assign(Error('private-provider-value'),{providerFailureType:'java.lang.SecurityException'});},retire:async()=>{}};
  const supervisor=await require('../src/modules/android/service-processes').prepareConnections({
    game:prepared('example.client'),config:{packageName:'example.client'},
    installed:{uid:10020,services:[{record:{packageName:'example.provider',processName:'example.provider',uid:10030},prepared:prepared('example.provider')}],release:async()=>{}},
    platformOwners:{system:owner},logger:{warn:value=>warnings.push(value)},
    launchService:async(service,fields,stdio)=>{
      const child=spawn(process.execPath,['-e',`const net=require('net');const socket=new net.Socket({fd:5});socket.resume();socket.on('end',()=>process.exit(0));`],{stdio});children.push(child);return child;
    }
  });
  const child=spawn(process.execPath,['-e',`const net=require('net'),{receive,send}=require(process.argv[1]);const socket=new net.Socket({fd:5});receive(socket,value=>{if(value.schemaVersion)send(socket,{op:'connect',packageName:'example.provider',processName:'example.provider',requestId:'original-request'});else process.send(value);},()=>process.exit(1));socket.on('end',()=>process.exit(0));`,wire],{stdio:supervisor.stdio(['ignore','ignore','pipe','ipc'])});children.push(child);
  t.after(async()=>{await supervisor.close();for(const owned of children)if(owned.exitCode==null&&owned.signalCode==null){const ended=once(owned,'exit');owned.kill('SIGKILL');await ended;}});
  const unavailable=once(child,'message');await supervisor.connect(child);
  const [message]=await unavailable;assert.equal(message.op,'unavailable');assert.equal(message.requestId,'original-request');
  assert.equal(children[1].exitCode,0,'The provider receives ordinary authority EOF after the rejected enrollment');
  assert.equal(warnings.length,1);const failure=JSON.parse(warnings[0].split(': ').slice(1).join(': '));
  assert.deepEqual(failure,{stage:'enroll-system',type:'java.lang.SecurityException',sites:[],causes:[]});
  assert.equal(warnings[0].includes('private-provider-value'),false,'Provider values cannot enter structural diagnostics');
});

test("A game process starts while profile owners initialize and receives authority only after enrollment", { timeout: 10000 }, async t => {
  const { spawn } = require("node:child_process"), { once } = require("node:events");
  const client = require("../src/modules/android/platform-services/client"), profile = require("../src/modules/android/platform-services/paths");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "android-service-overlap-")), owners = new Map(), enrolled = [];
  const locations = await Promise.all(["keystore", "system"].map(role => profile.paths(userDataDir, role)));
  t.after(async () => { await Promise.all(locations.map(location => fs.promises.rm(location.runRoot, { recursive: true, force: true }))); fs.rmSync(userDataDir, { recursive: true, force: true }); });
  let released = 0, closed = 0;
  t.mock.method(client, "acquire", options => new Promise(resolve => owners.set(options.role, () => resolve({
    identity: { packageName: options.role, uid: options.role === "system" ? 1000 : 1017, ...(options.role==="system"?{mediaInputsVersion:1}:{}) }, socketPath: locations[options.role === "system" ? 1 : 0].platformSocket,
    enroll: async (identity,authorization) => enrolled.push([options.role, identity.pid,authorization]), retire: async () => {}, close: () => closed++
  }))));
  const config = { packageName: "example.game", activityClass: "example.Main", audioInputUid:"selected-input",audioMuted:true,networkAllowed:0 };
  t.mock.method(require('../src/modules/android/process-channel'),'processIdentity',async child=>({pid:child.pid,hostPid:child.pid}));
  const prepared = { metadata: { packageName: config.packageName }, sourceApk: "/installed/base.apk", filesRoot: "/private/app/files" };
  const supervisor = await require("../src/modules/android/service-processes").prepareConnections({
    userDataDir,installed: { services: [], uid: 10000, release: async () => released++ }, game: prepared, config,
    platformOptions: { userDataDir, runtimeRoot: "/unused", javaPath: "/unused", systemServices: true }
  });
  assert.equal(owners.size, 2);
  assert.deepEqual(supervisor.sandbox.localSockets.connect, locations.map(location => location.platformSocket));
  const child = spawn(process.execPath, ["-e", `const fs=require('fs');let bytes=Buffer.alloc(0);process.stdout.write('initialized\\n');const input=fs.createReadStream(null,{fd:5});input.on('data',data=>{bytes=Buffer.concat([bytes,data]);if(bytes.length>=4&&bytes.length>=4+bytes.readUInt32BE(0)){process.stdout.write(JSON.stringify(JSON.parse(bytes.subarray(4,4+bytes.readUInt32BE(0))))+'\\n');}});input.on('end',()=>process.exit(0));`], { stdio: supervisor.stdio(["ignore", "pipe", "ignore"]) });
  t.after(async () => { await supervisor.close(); if (child.exitCode == null && child.signalCode == null) child.kill(); });
  child.stdout.setEncoding("utf8"); let output = ""; child.stdout.on("data", data => output += data);
  await once(child.stdout, "data"); assert.equal(output, "initialized\n", "The process initializes before profile owners are ready");
  const connected = supervisor.connect(child);
  owners.get("keystore")(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(enrolled.length, 0, "Partial readiness cannot publish the application authority");
  owners.get("system")(); await connected;
  if (!output.includes("schemaVersion")) await once(child.stdout, "data");
  const packet = JSON.parse(output.trim().split("\n")[1]);
  assert.equal(packet.self.pid, child.pid); assert.equal(packet.self.uid, 10000);
  assert.equal(enrolled.length, 2); assert.ok(packet.platform && packet.system);
  assert.equal(enrolled.find(row=>row[0]==="keystore")[2],undefined);
  assert.deepEqual(enrolled.find(row=>row[0]==="system")[2],{packages:supervisor.sandbox.installedPackages});
  assert.equal(config.audioInputUid,"selected-input");assert.equal(config.audioMuted,true);assert.equal(config.networkAllowed,0);
  assert.equal(config.processIds,undefined);assert.equal(config.packetSocket,undefined);
  const stopped = once(child, "exit"); await supervisor.close(); await stopped;
  assert.equal(released, 1); assert.equal(closed, 2);
});

test("Independent launch controllers allocate distinct persistent package UIDs", { skip: process.platform !== "darwin" }, async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "android-catalog-workers-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const { execFile } = require("node:child_process"), { promisify } = require("node:util");
  const script = `const Catalog=require(process.argv[1]);Catalog.prepareInstalled({gameId:process.argv[3]},
    {metadata:{packageName:'example.'+process.argv[3]}},{userDataDir:process.argv[2]},
    {profile:{servicePackagesVersion:1}},{})
    .then(async value=>{await value.release();process.stdout.write(String(value.uid));})
    .catch(error=>{console.error(error);process.exitCode=1});`;
  const invoke = name => promisify(execFile)(process.execPath, ['-e', script, require.resolve('../src/modules/android/service-packages'), userDataDir, name]);
  const first = await Promise.all(Array.from({ length: 8 }, (_, index) => invoke('app' + index)));
  assert.equal(new Set(first.map(result => result.stdout)).size, 8);
  assert.equal(Object.keys(Catalog.read(userDataDir).identities).length, 8);
  const again = await invoke('app3'); assert.equal(again.stdout, first[3].stdout);
});


test("Original Android service lifecycle binds an installed signed APK across isolated processes", { timeout: 45000 }, async t => {
  const runtime = process.env.KLEPTON_NATIVE_RUNTIME, prepared = process.env.ANDROID_SERVICE_PREPARED, client = process.env.ANDROID_SERVICE_CLIENT_APK;
  if (process.platform !== "darwin" || !runtime || !prepared || !client || !process.env.JAVA_HOME)
    return t.skip("Requires Java21, native runtime, prepared microG APK and signed client APK");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "android-installed-service-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures/android-services/installed.cjs"),
    path.join(process.env.JAVA_HOME, "bin/java"), path.resolve(runtime), path.resolve(prepared), path.resolve(client), fs.realpathSync(temporary)],
    { encoding: "utf8", timeout: 40000 });
  const log = role => { try { return fs.readFileSync(path.join(temporary, role, "stderr.log"), "utf8"); } catch { return ""; } };
  assert.equal(result.status, 0, result.stdout + result.stderr + log("client") + log("service"));
  assert.match(fs.readFileSync(path.join(temporary, "client/stdout.log"), "utf8"), /PASS actual installed service .* binder=android.os.IMessenger clientUid=10000/);
});

test("Installed service catalog owns copied code, persistent distinct UIDs and explicit caller data scope", async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "android-service-catalog-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const metadata = { packageName: "example.service", versionCode: 1, applicationProcessName: "example.service", applicationProcesses: ["example.service", "example.service:ui", "example.service:persistent"] };
  const key = "a".repeat(64), source = path.join(userDataDir, "android/apps", Catalog.codeId(metadata.packageName), "prepared", key, "source.apk");
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, "actual copied APK bytes");
  const prepared = { key, root: path.dirname(source), metadata, sourceApk: source, apkSha256: "b".repeat(64) };
  const context = { userDataDir };
  const record = await Catalog.installServicePackage("/selected/service.apk", context, {}, {}, { processName: "example.service:persistent", inspect: () => metadata, prepare: async () => prepared });
  assert.equal(record.uid, 10000); assert.equal(record.scope, "caller"); assert.equal(record.processName, "example.service:persistent");
  const options = { prepare: async entry => { assert.equal(entry.gamePath, source); return prepared; }, retain: () => async () => {},
    storage: async entry => ({ root: path.join(userDataDir, entry.gameId), filesRoot: path.join(userDataDir, entry.gameId, "data/files"), cacheRoot: path.join(userDataDir, entry.gameId, "data/cache") }) };
  const first = await Catalog.prepareInstalled({ gameId: "game-a" }, { metadata: { packageName: "example.game" } }, context, { profile: { servicePackagesVersion: 1 } }, {}, options);
  const second = await Catalog.prepareInstalled({ gameId: "game-b" }, { metadata: { packageName: "example.game" } }, context, { profile: { servicePackagesVersion: 1 } }, {}, options);
  assert.equal(first.uid, 10001); assert.equal(second.uid, first.uid);
  assert.deepEqual(first.services.map(item => item.record.processName), ["example.service", "example.service:persistent"]);
  assert.equal(first.services[0].record.uid, first.services[1].record.uid, "One actual package UID across its processes");
  assert.equal(first.services[0].prepared.filesRoot, first.services[1].prepared.filesRoot, "Declared package processes share the package data owner");
  assert.notEqual(first.services[0].storage.launchFile, first.services[1].storage.launchFile, "Process startup identities cannot overwrite one another");
  assert.notEqual(first.services[0].storage.logFile, first.services[1].storage.logFile, "Process logs have independent owners");
  assert.notEqual(first.services[0].prepared.filesRoot, second.services[0].prepared.filesRoot);
  assert.equal(first.services[0].prepared.sourceApk, second.services[0].prepared.sourceApk);
  const withUi = await Catalog.prepareInstalled({ gameId: "game-a" }, { metadata: { packageName: "example.game" } }, context, { profile: { servicePackagesVersion: 1, providerConnectionsVersion: 1 } }, {}, options);
  assert.deepEqual(withUi.services.map(item => item.record.processName), ["example.service", "example.service:persistent", "example.service:ui"]);
  await withUi.release();
  const complete = await Catalog.prepareInstalled({ gameId: "game-a" }, { metadata: { packageName: "example.game", applicationProcesses: ["example.game", "example.game:worker"] } }, context, { profile: { servicePackagesVersion: 1, providerConnectionsVersion: 1, processAuthorityVersion: 1 } }, {}, options);
  assert.deepEqual(complete.services.filter(item => item.record.packageName === "example.game").map(item => item.record.processName), ["example.game", "example.game:worker"], "Own-package processes use the same complete declaration catalog");
  await complete.release();
  assert.equal(Object.hasOwn(Catalog.read(userDataDir).packages[0], "signatures"), false);
  await first.release(); await second.release();
  await Catalog.installServicePackage("/selected/service.apk", context, {}, {}, { inspect: () => metadata, prepare: async () => prepared });
  const defaultOnly = await Catalog.prepareInstalled({ gameId: "game-a" }, { metadata: { packageName: "example.game" } }, context, { profile: { servicePackagesVersion: 1 } }, {}, options);
  assert.equal(defaultOnly.services.length, 1, "Default startup process is deduplicated");await defaultOnly.release();
  await Catalog.setEnabled(userDataDir, metadata.packageName, false);
  assert.equal(Catalog.read(userDataDir).packages[0].enabled, false);
  fs.unlinkSync(source); fs.symlinkSync("/etc/passwd", source); await Catalog.setEnabled(userDataDir, metadata.packageName, true);
  await assert.rejects(Catalog.prepareInstalled({ gameId: "game-a" }, { metadata: { packageName: "example.game" } }, context, { profile: { servicePackagesVersion: 1 } }, {}, options), /not a regular file/);
});

test('failed owner close retains the first failure while releasing other retired service resources',{timeout:10000},async t=>{
 const {spawn}=require('node:child_process'),{once}=require('node:events');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-service-retirement-')),failure=Error('owned profile close failed');
 let closed=0,released=0;
 t.mock.method(require('../src/modules/android/platform-services/client'),'acquire',async()=>({
  identity:{uid:1017},socketPath:'/fixture/keystore',enroll:async()=>{},retire:async()=>{},close(){closed++;throw failure;}
 }));
 t.mock.method(require('../src/modules/android/process-channel'),'processIdentity',async child=>({pid:child.pid,hostPid:child.pid}));
 const supervisor=await require('../src/modules/android/service-processes').prepareConnections({
  userDataDir:root,config:{packageName:'example.retirement'},game:{metadata:{packageName:'example.retirement'},sourceApk:'/fixture/app.apk',filesRoot:'/fixture/files'},
  installed:{uid:10000,services:[],release:async()=>{released++;}},platformOptions:{userDataDir:root,runtimeRoot:'/fixture/runtime',javaPath:'/fixture/java'}
 });
 const child=spawn(process.execPath,['-e',"const net=require('net');const socket=new net.Socket({fd:5});socket.resume();socket.on('end',()=>process.exit(0));process.stdout.write('ready\\n');"],{stdio:supervisor.stdio(['ignore','pipe','ignore'])});
 t.after(async()=>{await supervisor.close().catch(()=>{});if(child.exitCode==null&&child.signalCode==null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}fs.rmSync(root,{recursive:true,force:true});});
 await once(child.stdout,'data');await supervisor.connect(child);
 const first=supervisor.close();assert.equal(supervisor.close(),first);
 await assert.rejects(first,error=>error===failure);
 assert.equal(closed,1);assert.equal(released,1);assert.equal(child.exitCode,0);
 assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
});
