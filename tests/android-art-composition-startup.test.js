const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');

test('original window loading overlaps composer and SurfaceFlinger before authenticated enrollment',{timeout:45000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_SHARED_GRAPHICS:sharedGraphics,ANDROID_TEST_BACKGROUND:background}=process.env;
 if(process.platform!=='darwin'||![payload,sharedGraphics,background].every(Boolean))return t.skip('Requires the native ART supplier, shared graphics and background test policy');
 const {layout,environment}=await import('../src/modules/android/art/layout.mjs');
 const {startComposition}=await import('../src/modules/android/art/composition.mjs');
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload)),c=supplier.components;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-composition-start-')),children=[],signal=AbortSignal.timeout(35000);
 t.after(async()=>{
  for(const child of children.toReversed())if(child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGTERM');}catch{}
  let timer;await Promise.race([Promise.allSettled(children.map(child=>child.closed)),new Promise(resolve=>timer=setTimeout(resolve,1500))]);clearTimeout(timer);
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGKILL');}catch{}
  await Promise.allSettled(children.map(child=>child.closed));
  assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null),'Every owned native component retires');
  const output=process.env.ANDROID_ART_COMPOSITION_OUTPUT;
  if(output&&fs.existsSync(path.join(root,'composition'))){fs.mkdirSync(output,{recursive:true});for(const name of fs.readdirSync(path.join(root,'composition')))if(name.endsWith('.log'))fs.copyFileSync(path.join(root,'composition',name),path.join(output,name));}
  fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});
 });
 const nativeState=path.join(root,'native'),sensorRoot=path.join(root,'sensors');
 fs.mkdirSync(nativeState);fs.mkdirSync(sensorRoot);
 const profile=path.join(root,'profile');fs.mkdirSync(profile);
 const namespace=await require('../src/modules/android/process-channel').processNamespace(profile,1);
 const env={...process.env,...environment(supplier),...namespace.environment,
  DYLD_LIBRARY_PATH:path.resolve(payload,'native'),DYLD_FRAMEWORK_PATH:path.resolve(payload,'native'),
  DYLD_INSERT_LIBRARIES:path.resolve(background)};
 const spawnProcess=(name,command,args,options)=>{
  // Every process uses the actual supplier and original service implementation.
  // The injected test policy only keeps this application's window behind others.
  const child=spawn(command,args,{...options,env:{...env,...options.env},detached:true});
  child.closed=once(child,'close');child.closed.catch(()=>{});children.push(child);return child;
 };
 const binderName='maclauncher.android.composition-start.'+require('node:crypto').randomUUID();
 const binder=spawnProcess('binder',c.binder,['--host-module',c.hostLibrary,'--service',binderName],{env,stdio:'ignore'});
 execFileSync(c.bootstrap,['wait-binder',binderName],{env,timeout:6000});
 const phases=[],enrollmentBoundary=Error('Application enrollment boundary reached');
 const cache=process.env.ANDROID_ART_COMPOSITION_CACHE||path.join(root,'code-cache');fs.mkdirSync(cache,{recursive:true});
 const owner={socketPath:path.join(root,'not-an-application-service.sock'),identity:{pid:process.pid,uid:1000,securityContext:'u:r:system_server:s0',packageName:'android',processName:'android.system'},
  async enroll(peer){
   assert.ok(phases.some(phase=>phase.name==='composition-composer-surfaceflinger')||
    phases.some(phase=>phase.name==='composition-composer')&&phases.some(phase=>phase.name==='composition-surfaceflinger'),
    'Original composer and SurfaceFlinger publish before window authority enrollment');
   assert.ok(phases.some(phase=>phase.name==='composition-window-identity'),
    'The actual window identity is published before enrollment');
   const window=children.find(child=>child.ownerName==='window-root');
   assert.equal(peer.hostPid,window.pid,'Enrollment retains the actual native process owner');
   assert.equal(window.stdin.writableEnded,false,'Guest startup remains blocked before authenticated enrollment');
   throw enrollmentBoundary;
  },async retire(){}};
 let ready;owner.ready=new Promise(resolve=>ready=()=>resolve(owner));
 await assert.rejects(startComposition({directory:root,supplier,payload:{root:payload,profile:{processIdentityVersion:1}},
  sharedGraphics:path.resolve(sharedGraphics),binderName,env,owner,appUid:10000,appLabel:'Android',
  application:{executablePath:c.presenter},kernelRuntime:nativeState,pathMap:layout({supplier,state:nativeState}),
  cache,spawnProcess,signal,
  viewport:{width:640,height:480,densityDpi:160},networkAllowed:false,allowAds:false,sensorRoot,
  measure:async(name,operation)=>{
   if(['composition-composer-surfaceflinger','composition-composer','composition-surfaceflinger'].includes(name)){
    const window=children.find(child=>child.ownerName==='window-root');
    assert.ok(window,'Original window loading starts before waiting for display publication');
    assert.equal(window.stdin.writableEnded,false,'No platform authority is released while display publication is pending');
   }
   if(name==='composition-platform-services'){
    const initialized=phases.map(phase=>phase.name);
    assert.ok(initialized.includes('composition-composer-surfaceflinger')||
      initialized.includes('composition-composer')&&initialized.includes('composition-surfaceflinger'),
      'Original composer and SurfaceFlinger publication precedes joining the profile authority');
    assert.equal(children.some(child=>child.ownerName==='window-root'),true,'Read-only window loading overlaps initialization of the authenticated authority');
    ready();
   }
   const began=performance.now();const result=await operation();phases.push({name,milliseconds:performance.now()-began});return result;
  }
 }),error=>error===enrollmentBoundary);
 const names=phases.map(p=>p.name).sort();
 assert.deepEqual(names,names.includes('composition-composer-surfaceflinger')?
  ['composition-composer-surfaceflinger','composition-platform-services','composition-window-identity']:
  ['composition-composer','composition-platform-services','composition-surfaceflinger','composition-window-identity']);
 assert.equal(binder.exitCode,null,'The original Binder owner remains live until fixture retirement');
 t.diagnostic(JSON.stringify(phases));
});
