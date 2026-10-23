const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawn, fork } = require('node:child_process'), { once } = require('node:events');
const { paths, readPrivate } = require('../src/modules/android/platform-services/paths');

test('disconnected queued enrollment performs no authority work and releases the healthy controller queue',{timeout:12000},async t=>{
 const helper=process.env.ANDROID_SUPERVISOR_SENDER;if(process.platform!=='darwin'||!helper)return t.skip('Requires the native process identity helper');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-queued-enrollment-'))),native=path.join(root,'runtime/native');await fs.mkdir(native,{recursive:true});
 await fs.copyFile(helper,path.join(native,'android-supervisor-send'));await fs.chmod(path.join(native,'android-supervisor-send'),0o700);
 const config={userDataDir:root,runtimeRoot:path.join(root,'runtime'),role:'keystore',enrollmentGate:path.join(root,'continue')},storage=await paths(root,'keystore');
 const owner=spawn(helper,['--lock',storage.lock,process.execPath,path.join(__dirname,'fixtures/android-platform-service/owner.cjs'),JSON.stringify(config)],{stdio:['ignore','ignore','pipe']});
 let detail='',lease,socket;const children=[];owner.stderr.on('data',bytes=>detail+=bytes);
 t.after(async()=>{socket?.destroy();lease?.close();await fs.writeFile(config.enrollmentGate,'');for(const child of children){if(child.exitCode==null&&child.signalCode==null){const ended=once(child,'exit');child.stdin.end();await ended;}}if(owner.exitCode==null&&owner.signalCode==null){const ended=once(owner,'exit');owner.kill('SIGTERM');await ended;}await fs.rm(root,{recursive:true,force:true});await fs.rm(storage.runRoot,{recursive:true,force:true});});
 const waitFor=async operation=>{const deadline=Date.now()+5000;for(;;){const value=await operation();if(value)return value;if(Date.now()>deadline)throw Error(detail||'Fixture did not reach its controlled boundary');await new Promise(resolve=>setTimeout(resolve,5));}};
 await waitFor(()=>readPrivate(storage.metadata).catch(error=>{if(error.code==='ENOENT')return null;throw error;}));
 lease=await require('../src/modules/android/platform-services/client').acquire(config);
 async function peer(name){const child=spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:['pipe','ignore','ignore']});children.push(child);await once(child,'spawn');return {packageName:name,processName:name,pid:child.pid,uid:10042};}
 const first=await peer('example.first'),abandoned=await peer('example.abandoned'),last=await peer('example.last');
 const blocked=lease.enroll(first);await waitFor(()=>fs.access(config.enrollmentGate+'.waiting').then(()=>true,()=>false));
 // A framed enrollment followed by TCP EOF reaches the real owner before its
 // close event. Keep the child alive so retirement cannot be attributed to an
 // ancestry or process-lifetime failure.
 const {receive,send}=require('../src/modules/android/process-channel'),metadata=await readPrivate(storage.metadata),responses=new Map();
 socket=require('node:net').createConnection(storage.controllerSocket);receive(socket,value=>{responses.get(value.id)?.(value);responses.delete(value.id);},()=>{});await once(socket,'connect');
 const hello=new Promise(resolve=>responses.set('hello',resolve));await send(socket,{op:'hello',id:'hello',capability:metadata.capability,role:config.role,runtimeRoot:config.runtimeRoot});assert.equal((await hello).error,undefined);
 await send(socket,{op:'enroll',id:'abandoned',peer:abandoned});const closed=once(socket,'close');socket.end();await closed;
 const succeeding=lease.enroll(last);await fs.writeFile(config.enrollmentGate,'');await blocked;await succeeding;
 const records=(await fs.readFile(path.join(storage.root,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(records.filter(value=>value.op==='enroll').map(value=>value.peer.pid),[first.pid,last.pid]);
 assert.equal(records.some(value=>value.peer?.pid===abandoned.pid),false,'A disconnected queued controller must neither enroll nor send a compensating retirement for a process it never admitted');
 await lease.retire(first);await lease.retire(last);
});

test('Original Java enrollment failure class crosses authority, owner and client unchanged',{timeout:12000},async t=>{
 const helper=process.env.ANDROID_SUPERVISOR_SENDER;if(process.platform!=='darwin'||!helper)return t.skip('Requires the native process identity helper');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-enrollment-failure-type-'))),native=path.join(root,'runtime/native');await fs.mkdir(native,{recursive:true});
 await fs.copyFile(helper,path.join(native,'android-supervisor-send'));await fs.chmod(path.join(native,'android-supervisor-send'),0o700);
 const config={userDataDir:root,runtimeRoot:path.join(root,'runtime'),role:'keystore',enrollmentFailureType:'java.lang.SecurityException'},storage=await paths(root,'keystore'),fixture=path.join(__dirname,'fixtures/android-platform-service');
 const owner=spawn(helper,['--lock',storage.lock,process.execPath,path.join(fixture,'owner.cjs'),JSON.stringify(config)],{stdio:['ignore','ignore','pipe']});let detail='',controller;owner.stderr.on('data',bytes=>detail+=bytes);
 t.after(async()=>{if(controller&&controller.exitCode==null&&controller.signalCode==null){const ended=once(controller,'exit');controller.kill('SIGTERM');await ended;}if(owner.exitCode==null&&owner.signalCode==null){const ended=once(owner,'exit');owner.kill('SIGTERM');await ended;}await fs.rm(root,{recursive:true,force:true});await fs.rm(storage.runRoot,{recursive:true,force:true});});
 const until=Date.now()+6000;for(;;){try{await readPrivate(storage.metadata);break;}catch(error){if(error.code!=='ENOENT'||Date.now()>until)throw Error(detail||error.message);await new Promise(resolve=>setTimeout(resolve,10));}}
 controller=fork(path.join(fixture,'controller.cjs'),[JSON.stringify(config)],{stdio:['ignore','ignore','pipe','ipc']});controller.stderr.on('data',bytes=>detail+=bytes);
 await new Promise((resolve,reject)=>{controller.once('message',resolve);controller.once('exit',()=>reject(Error(detail||'Controller stopped before readiness')));});
 const response=new Promise(resolve=>controller.once('message',resolve));controller.send({id:1,op:'enroll'});
 const rejected=await response;assert.equal(rejected.providerFailureType,'java.lang.SecurityException');assert.equal(rejected.error,'Fixture enrollment rejected');
 const records=(await fs.readFile(path.join(storage.root,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(records.some(value=>value.op==='enroll'),'original authority request was exercised');
});

test('JVM and ART containers share common platform bytes and retire changed suppliers', {timeout:20000},async t=>{
 const helper=process.env.ANDROID_SUPERVISOR_SENDER;
 if(process.platform!=='darwin'||!helper)return t.skip('Requires the native process identity helper');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-shared-implementation-'))),children=[];
 const fixture=path.join(__dirname,'fixtures/android-platform-service'),crypto=require('node:crypto');
 async function container(name,art,{java='class-data',native='native-data',profile={},image='image-data',catalog='catalog-data'}={}){
  const runtimeRoot=path.join(root,name);await fs.mkdir(path.join(runtimeRoot,'native'),{recursive:true});await fs.copyFile(helper,path.join(runtimeRoot,'native/android-supervisor-send'));await fs.chmod(path.join(runtimeRoot,'native/android-supervisor-send'),0o700);
  await fs.writeFile(path.join(runtimeRoot,'android-host.jar'),java);await fs.writeFile(path.join(runtimeRoot,'native/platform.dylib'),native);
  const files=await Promise.all(['android-host.jar','native/platform.dylib','native/android-supervisor-send'].map(async file=>{const bytes=await fs.readFile(path.join(runtimeRoot,file)),stat=await fs.stat(path.join(runtimeRoot,file));return {path:file,size:bytes.length,mode:stat.mode&0o777,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};}));
  const platformSupplier={schemaVersion:1,image:{sha256:crypto.createHash('sha256').update(image).digest('hex'),records:2,bytes:image.length},catalog:{sha256:crypto.createHash('sha256').update(catalog).digest('hex'),size:catalog.length,mode:0o644}};
  const version='container-'+name,manifest=JSON.stringify({schemaVersion:1,version,minimumMacOS:'11.0',architectures:['arm64'],sourceHash:crypto.createHash('sha256').update('source-'+name).digest('hex'),inputHash:crypto.createHash('sha256').update('input-'+name).digest('hex'),files,platformSupplier,profile:{id:'shared',javaMajor:21,nativeLoadTarget:'maclauncher.android.bridge.GuestNativeLoader',processIdentityVersion:0,...profile,...(art?{artExecutionVersion:art}:{})}});
  await fs.writeFile(path.join(runtimeRoot,'runtime.json'),manifest);
  const declaration={version,minimumMacOS:'11.0',manifestSha256:crypto.createHash('sha256').update(manifest).digest('hex')};
  return {userDataDir:root,runtimeRoot,moduleRoot:path.resolve('src/modules/android'),role:'keystore',runtimeIdentity:require('../src/modules/android/runtime').resolve({root:runtimeRoot},declaration).runtimeIdentity};
 }
 const [jvm,art,artNext]=await Promise.all([container('jvm',0),container('art',1),container('art-next',2)]),storage=await paths(root,'keystore');
 t.after(async()=>{for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');await new Promise(resolve=>setTimeout(resolve,200));await fs.rm(root,{recursive:true,force:true});await fs.rm(storage.runRoot,{recursive:true,force:true});});
 let diagnostic='';
 async function startOwner(){const owner=spawn(helper,['--lock',storage.lock,process.execPath,path.join(fixture,'owner.cjs'),JSON.stringify(jvm)],{stdio:['ignore','ignore','pipe']});children.push(owner);owner.stderr.on('data',bytes=>diagnostic+=bytes);const deadline=Date.now()+6000;while(true){try{const metadata=await readPrivate(storage.metadata);if(metadata.owner.pid===owner.pid)return owner;}catch(error){if(error.code!=='ENOENT')throw error;}if(Date.now()>=deadline)throw Error(diagnostic||'Owner did not publish');await new Promise(resolve=>setTimeout(resolve,10));}}
 const owner=await startOwner(),controllers=[];
 function controller(config){const child=fork(path.join(fixture,'controller.cjs'),[JSON.stringify(config)],{stdio:['ignore','ignore','pipe','ipc']});children.push(child);controllers.push(child);child.stderr.on('data',bytes=>diagnostic+=bytes);return new Promise((resolve,reject)=>{child.once('message',resolve);child.once('exit',()=>reject(Error(diagnostic||'Controller ended')));});}
 const values=await Promise.all([controller(art),controller(jvm),controller(artNext)]);
 assert.equal(new Set(values.map(value=>value.identity.pid)).size,1,diagnostic);assert.equal((await readPrivate(storage.metadata)).owner.pid,owner.pid);
 const events=(await fs.readFile(path.join(storage.root,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(events.filter(value=>value.op==='start').length,1);
 const {sameRuntimeImplementation}=require('../src/modules/android/platform-services/owner');
 assert.equal(sameRuntimeImplementation(jvm,art),true);
 assert.equal(sameRuntimeImplementation(jvm,artNext),true);
 assert.notEqual(jvm.runtimeIdentity.sourceHash,artNext.runtimeIdentity.sourceHash);
 assert.notEqual(jvm.runtimeIdentity.version,artNext.runtimeIdentity.version);
 const legacy=value=>({...value,runtimeIdentity:{...value.runtimeIdentity,platformHash:undefined}});
 assert.equal(sameRuntimeImplementation(legacy(jvm),legacy({...jvm,runtimeRoot:art.runtimeRoot})),true);
 assert.equal(sameRuntimeImplementation(legacy(jvm),legacy(artNext)),false);
 const variants=await Promise.all([container('changed-java',3,{java:'changed-class'}),container('changed-native',3,{native:'changed-native'}),container('changed-profile',3,{profile:{frameworkServicesVersion:2}}),container('changed-image',3,{image:'changed-image'}),container('changed-catalog',3,{catalog:'changed-catalog'}),container('changed-protocol',3,{profile:{processIdentityVersion:1}})]);
 // Concurrent applications may share byte-identical common suppliers across
 // execution containers. A different supplier must neither replace that live
 // owner nor be admitted to its Java/native or persistent database boundary.
 const {acquire}=require('../src/modules/android/platform-services/client');
 await Promise.all(variants.map(variant=>assert.rejects(acquire(variant),{code:'EBUSY'})));
 assert.equal((await readPrivate(storage.metadata)).owner.pid,owner.pid);
 assert.equal((await fs.readFile(path.join(storage.root,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(value=>value.op==='start').length,1);
 for(const [index,child] of controllers.entries()){
  const response=new Promise(resolve=>child.once('message',resolve));child.send({id:index+1,op:'enroll'});
  assert.equal((await response).ok,true,'Compatible controller remains usable after conflicting admissions');
 }
 await Promise.all(controllers.map(async child=>{const ended=once(child,'exit');child.kill('SIGTERM');await ended;}));
 await new Promise(resolve=>setTimeout(resolve,30));
 const {receive,send}=require('../src/modules/android/process-channel');
 for(const[index,variant]of variants.entries()){
  assert.equal(sameRuntimeImplementation(jvm,variant),false);
  const current=index===0?owner:await startOwner(),ended=once(current,'exit'),metadata=await readPrivate(storage.metadata);
  const socket=require('node:net').createConnection(storage.controllerSocket);
  const response=new Promise((resolve,reject)=>{receive(socket,resolve,reject);socket.once('error',reject);});
  await once(socket,'connect');await send(socket,{op:'hello',id:'changed',capability:metadata.capability,role:'keystore',...variant});
  assert.equal((await response).code,'ESTALE','A changed supplier retires the idle owner');socket.destroy();await ended;
  const history=await readPrivate(path.join(storage.root,'lifecycle.json'));assert.equal(history.at(-1).reason,'runtime-change');
 }
 assert.equal(sameRuntimeImplementation(jvm,{...art,moduleRoot:path.join(root,'other-launcher')}),false);
});

test('an acquired controller retains its profile owner before delayed application enrollment', {timeout:20000}, async t=>{
 const helper=process.env.ANDROID_SUPERVISOR_SENDER;if(process.platform!=='darwin'||!helper)return t.skip('Requires the macOS supervisor helper');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-delayed-enrollment-'))),runtime=path.join(root,'runtime'),native=path.join(runtime,'native');await fs.mkdir(native,{recursive:true});
 await fs.copyFile(helper,path.join(native,'android-supervisor-send'));await fs.chmod(path.join(native,'android-supervisor-send'),0o700);
 const config={userDataDir:root,runtimeRoot:runtime,role:'keystore'},storage=await paths(root,'keystore'),fixture=path.join(__dirname,'fixtures/android-platform-service'),children=[];
 const owner=spawn(helper,['--lock',storage.lock,process.execPath,path.join(fixture,'owner.cjs'),JSON.stringify(config)],{stdio:['ignore','ignore','pipe']});children.push(owner);let detail='';owner.stderr.on('data',v=>detail+=v);
 t.after(async()=>{for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');await new Promise(r=>setTimeout(r,750));await fs.rm(root,{recursive:true,force:true});await fs.rm(storage.runRoot,{recursive:true,force:true});});
 const until=Date.now()+8000;while(true){try{await readPrivate(storage.metadata);break;}catch(error){if(error.code!=='ENOENT'||Date.now()>until)throw Error(detail||error.message);await new Promise(r=>setTimeout(r,20));}}
 function controller(){const child=fork(path.join(fixture,'controller.cjs'),[JSON.stringify(config)],{stdio:['ignore','ignore','pipe','ipc']});children.push(child);const pending=new Map();let serial=0;child.stderr.on('data',v=>detail+=v);
  child.ready=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.ready)resolve(m);else{pending.get(m.id)?.(m);pending.delete(m.id);}});child.once('exit',()=>reject(Error('Controller ended before readiness: '+detail)));});
  child.command=(op,peer)=>new Promise(resolve=>{const id=++serial;pending.set(id,resolve);child.send({id,op,peer});});return child;}
 const first=controller(),pending=controller(),released=controller();await Promise.all([first.ready,pending.ready,released.ready]);assert.equal((await first.command('enroll')).ok,true);
 first.kill('SIGTERM');await once(first,'exit');
 // The remaining lease has issued no application enrollment. It must survive
 // the original two-second no-controller retirement interval while preparing.
 await new Promise(r=>setTimeout(r,2500));assert.equal((await readPrivate(storage.metadata)).owner.pid,owner.pid);
 assert.equal((await pending.command('enroll')).ok,true,detail);assert.equal((await pending.command('retire')).ok,true,detail);
 assert.equal((await released.command('release')).ok,true);
 const retired=await released.command('enroll');assert.equal(retired.code,'ECONNRESET');assert.equal(retired.platformRole,'keystore');assert.equal(retired.platformConnection,'released');
 owner.kill('SIGTERM');await once(owner,'exit');
 const disconnected=await pending.command('enroll');assert.equal(disconnected.code,'ECONNRESET');assert.equal(disconnected.platformRole,'keystore');assert.equal(disconnected.platformConnection,'peer-closed');
});

for(const mode of [{name:'original provider failure',flag:'failStartup',type:'java.io.IOException'},
  {name:'JavaScript initialization rejection',flag:'failStartupJavaScript',type:'TypeError'}])
test('account startup retains '+mode.name+' when cleanup closes its child first', {timeout:10000}, async t => {
  const helper=process.env.ANDROID_SUPERVISOR_SENDER;
  if(process.platform!=='darwin'||!helper)return t.skip('Requires macOS and the Android supervisor helper');
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-platform-startup-')));
  const native=path.join(root,'runtime/native');await fs.mkdir(native,{recursive:true});
  await fs.copyFile(helper,path.join(native,'android-supervisor-send'));await fs.chmod(path.join(native,'android-supervisor-send'),0o700);
  const config={userDataDir:root,runtimeRoot:path.join(root,'runtime'),role:'accounts',[mode.flag]:true};
  const storage=await paths(root,'accounts');
  const child=spawn(helper,['--lock',storage.lock,process.execPath,path.join(__dirname,'fixtures/android-platform-service/owner.cjs'),JSON.stringify(config)],{stdio:['ignore','ignore','pipe']});
  t.after(async()=>{if(child.exitCode==null)child.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true});await fs.rm(storage.runRoot,{recursive:true,force:true});});
  let diagnostic='';child.stderr.on('data',bytes=>diagnostic+=bytes);
  const [code]=await once(child,'close');
  assert.equal(code,1);
  if(mode.flag==='failStartup'){
    assert.match(diagnostic,/Original account startup failure/);
    assert.match(diagnostic,/ACCOUNT_PROVIDER_ERROR/);assert.match(diagnostic,/fixture\.Packages\.verify:42/);
  }else assert.match(diagnostic,/TypeError/);
  assert.doesNotMatch(diagnostic,/Android platform service stopped \(0\)|PRIVATE_SERVICE_OUTPUT/);
  const events=(await fs.readFile(path.join(storage.root,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(value=>value.op==='adapter-retired'),'The complete service adapter still retires');
  const history=await readPrivate(path.join(storage.root,'lifecycle.json')),outcome=history.at(-1);
  assert.equal(outcome.reason,'startup-failed');assert.equal(outcome.exitCode,0,'requested cleanup exit must not replace the actual startup rejection');
  assert.equal(outcome.failure.type,mode.type);assert.equal(outcome.failure.stage,'initialize-services');
  assert.deepEqual(outcome.failure.sites,mode.flag==='failStartup'?['fixture.Packages.verify:42']:[]);
  assert.doesNotMatch(JSON.stringify(history),/PRIVATE|oauth|token|Original account startup failure/);
  await assert.rejects(fs.access(storage.metadata),{code:'ENOENT'});
});

test('account startup records the original phase when its adapter fails before returning', {timeout:10000}, async t=>{
 const helper=process.env.ANDROID_SUPERVISOR_SENDER;
 if(process.platform!=='darwin'||!helper)return t.skip('Requires macOS and the Android supervisor helper');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'android-platform-before-return-')));
 const native=path.join(root,'runtime/native');await fs.mkdir(native,{recursive:true});
 await fs.copyFile(helper,path.join(native,'android-supervisor-send'));await fs.chmod(path.join(native,'android-supervisor-send'),0o700);
 const config={userDataDir:root,runtimeRoot:path.join(root,'runtime'),role:'accounts',failBeforeAdapterReturn:true};
 const storage=await paths(root,'accounts');
 const child=spawn(helper,['--lock',storage.lock,process.execPath,path.join(__dirname,'fixtures/android-platform-service/owner.cjs'),JSON.stringify(config)],{stdio:['ignore','ignore','ignore']});
 t.after(async()=>{if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true});await fs.rm(storage.runRoot,{recursive:true,force:true});});
 assert.equal((await once(child,'close'))[0],1);
 const history=await readPrivate(path.join(storage.root,'lifecycle.json')),outcome=history.at(-1);
 assert.equal(outcome.servicePid,null);assert.equal(outcome.reason,'startup-failed');
 assert.deepEqual(outcome.failure,{stage:'prepare-account-storage',type:'Error',sites:[],causes:[],code:'EBUSY'});
 assert.doesNotMatch(JSON.stringify(history),/PRIVATE|BOOTSTRAP_PATH/);
 await assert.rejects(fs.access(storage.metadata),{code:'ENOENT'});
});

for (const role of ['keystore','accounts']) test(role + ': one profile service survives independent controller leases and retains ownership until every database process exits',
  { timeout: 30000 }, async t => {
  const helper = process.env.ANDROID_SUPERVISOR_SENDER;
  if (process.platform !== 'darwin' || !helper) return t.skip('Requires macOS and the Android supervisor helper');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'android-platform-owner-')));
  const native = path.join(root, 'runtime/native'); await fs.mkdir(native, { recursive: true });
  await fs.copyFile(helper, path.join(native, 'android-supervisor-send')); await fs.chmod(path.join(native, 'android-supervisor-send'), 0o700);
  const config = { userDataDir: root, runtimeRoot: path.join(root, 'runtime'), role };
  const manifest = JSON.stringify({ schemaVersion: 1, version: 'fixture-logical-identities',
    profile: { id: 'fixture-logical-identities', javaMajor: 21, processIdentityVersion: 1,
      nativeLoadTarget: 'maclauncher.android.bridge.GuestNativeLoader' } });
  await fs.writeFile(path.join(config.runtimeRoot, 'runtime.json'), manifest);
  const runtimeIdentity = { version: 'fixture-logical-identities', minimumMacOS: '11.0',
    manifestSha256: require('node:crypto').createHash('sha256').update(manifest).digest('hex') };
  const storage = await paths(root,role), fixture = path.join(__dirname, 'fixtures/android-platform-service');
  assert.notEqual(storage.root,(await paths(root,role==='accounts'?'keystore':'accounts')).root);
  const children = new Set();
  const keep = child => { children.add(child); child.once('exit', () => children.delete(child)); return child; };
  t.after(async () => {
    for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
    await new Promise(resolve => setTimeout(resolve, 750));
    await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage.runRoot, { recursive: true, force: true });
  });
  function owner() {
    const child = keep(spawn(helper, ['--lock', storage.lock, process.execPath, path.join(fixture, 'owner.cjs'), JSON.stringify(config)], { stdio: ['ignore', 'pipe', 'pipe'] }));
    let error = ''; child.stderr.on('data', bytes => { error += bytes; }); child.detail = () => error; return child;
  }
  async function waitFor(probe, message, milliseconds = 8000) {
    const until = Date.now() + milliseconds;
    while (Date.now() < until) { try { const value = await probe(); if (value) return value; } catch (error) { if (error.code !== 'ENOENT') throw error; } await new Promise(resolve => setTimeout(resolve, 15)); }
    throw Error(typeof message === 'function' ? message() : message);
  }
  const first = owner();
  const metadata = await waitFor(() => readPrivate(storage.metadata), () => 'Owner did not publish: ' + first.detail());
  const contention = owner(); assert.equal((await once(contention, 'exit'))[0], 73, contention.detail());
  function controller(access='read') {
    const child = keep(fork(path.join(fixture, 'controller.cjs'), [JSON.stringify({...config,access})], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    const replies = new Map(); let serial = 0;
    child.ready = new Promise((resolve, reject) => {
      child.on('message', message => { if (message.ready) resolve(message); else { replies.get(message.id)?.(message); replies.delete(message.id); } });
      child.once('exit', () => reject(Error('Controller exited before readiness')));
    });
    child.command = (op, peer) => new Promise(resolve => { const id = ++serial; replies.set(id, resolve); child.send({ id, op, peer }); });
    child.stderr.on('data', bytes => { first.stderr.emit('data', bytes); }); return child;
  }
  const [one, two] = [controller('manage'), controller('game')];
  const [a, b] = await Promise.all([one.ready, two.ready]);
  assert.equal(a.identity.pid, b.identity.pid, 'Independent Node controllers share the service JVM');
  assert.equal(a.identity.uid, role==='accounts'?1000:1017);
  await assert.rejects(require('../src/modules/android/platform-services/client').acquire({ ...config, runtimeIdentity, processIdentityVersion: 0 }),
    { code: 'EBUSY' }, 'The trusted manifest supplies the protocol even if a nested caller omits or copies an old capability');
  if(role==='accounts') {
    assert.equal((await one.command('request',{command:'accounts',networkAllowed:true})).ok,true);
    assert.equal((await one.command('request',{command:'addAccount',networkAllowed:true})).ok,true);
    assert.match((await two.command('request',{command:'accounts'})).error,/requires account management/);
    assert.match((await one.command('request',{command:'unknown'})).error,/requires account management/);
  }
  assert.match((await one.command('enroll', { pid: process.pid })).error, /not created by this launcher controller/);
  assert.match((await one.command('enroll', { pid: one.pid })).error, /must be a child/);
  assert.equal((await one.command('enroll')).ok, true);
  assert.equal((await two.command('enroll')).ok, true);
  assert.match((await one.command('enroll')).error, /already enrolled/);
  const events = async () => (await fs.readFile(path.join(storage.root, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  if(role==='keystore'){
    assert.equal((await one.command('retire')).ok,true);
    assert.equal((await one.command('enroll',{pid:42,hostPid:a.child})).ok,true,'logical PID remains distinct from authenticated physical child');
    assert.ok((await events()).some(value=>value.op==='enroll'&&value.peer.pid===42&&value.peer.hostPid===a.child));
    assert.equal((await one.command('retire',{pid:42})).ok,true);
    assert.equal((await one.command('enroll')).ok,true);
  }
  if(role==='accounts') {
    const calls=(await events()).filter(value=>value.op==='request');
    assert.deepEqual(calls.map(value=>[value.command,value.networkAllowed,value.interactive]),[['accounts',false,false],['addAccount',true,true]]);
  }
  one.kill('SIGTERM'); await once(one, 'exit');
  await waitFor(async () => (await events()).some(value => value.op === 'retire' && value.peer.pid === a.child), 'Abrupt controller death did not retire its process');
  assert.equal((await two.command('retire')).ok, true);
  assert.equal((await two.command('enroll')).ok, true, 'Another controller remains usable after peer retirement');
  assert.equal((await readPrivate(storage.metadata)).owner.pid, metadata.owner.pid);
  first.kill('SIGKILL'); await once(first, 'exit');
  const overlap = owner(); assert.equal((await once(overlap, 'exit'))[0], 73, 'Surviving service must retain the kernel lock');
  await new Promise(resolve => setTimeout(resolve, 800));
  const restarted = owner();
  const next = await waitFor(async () => { const value = await readPrivate(storage.metadata); return value.owner.pid !== metadata.owner.pid && value; }, 'New owner did not replace stale metadata');
  assert.equal(next.owner.pid, restarted.pid);
  const three = controller(); await three.ready;
  assert.equal((await three.command('enroll')).ok, true);
  three.kill('SIGTERM'); await once(three, 'exit');
  await once(restarted, 'exit');
  assert.equal((await events()).filter(value => value.op === 'start').length, 2);
  if(role==='accounts'){
    assert.ok((await events()).some(value=>value.op==='adapter-retired'),'The owner must retain the lock through complete adapter retirement');
    await assert.rejects(fs.access(path.join(storage.root,'runtime.log')),{code:'ENOENT'});
  }
  else assert.match(await fs.readFile(path.join(storage.root,'runtime.log'),'utf8'),/PRIVATE_SERVICE_OUTPUT/);
  const outcomes=await readPrivate(path.join(storage.root,'lifecycle.json'));
  assert.equal(outcomes.at(-1).reason,'no-controllers');assert.equal(outcomes.at(-1).ownerPid,restarted.pid);
  assert.equal(outcomes.at(-1).failure,undefined,'requested retirement is not an initialization or service failure');
  assert.ok(outcomes.length<=16);assert.ok(!JSON.stringify(outcomes).includes('PRIVATE_SERVICE_OUTPUT'));
  await assert.rejects(fs.access(storage.metadata), { code: 'ENOENT' });
});
