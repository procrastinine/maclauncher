const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events');

test('independent original media publishers share readiness and retain owned failure/cancellation cleanup',{timeout:20000},async t=>{
 if(process.platform!=='darwin')return t.skip('Requires the composition owner\'s macOS pipe lifecycle');
 const {startComposition}=await import('../src/modules/android/art/composition.mjs');
 const wait=async(condition)=>{const end=Date.now()+4000;while(!condition()){assert.ok(Date.now()<end,'owned fixture reached its expected stage');await new Promise(resolve=>setTimeout(resolve,5));}};
 for(const outcome of ['ready','failure','cancel'])await t.test(outcome,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-media-concurrency-')),children=[],controller=new AbortController();let composition;
  t.after(async()=>{
   controller.abort(Error('fixture retirement'));
   if(composition)await composition.close();
   for(const {process:p} of children)if(p.exitCode===null&&p.signalCode===null)try{process.kill(-p.pid,'SIGKILL');}catch{}
   await Promise.allSettled(children.map(({process:p})=>p.closed));fs.rmSync(root,{recursive:true,force:true});
  });
  const c={image:path.join(root,'image'),halRoot:path.join(root,'hal'),halManifests:path.join(root,'manifests'),linuxRun:path.join(root,'linux-run')};
  for(const name of ['vendor/etc/vintf/manifest'])fs.mkdirSync(path.join(c.image,name),{recursive:true});
  for(const directory of [c.halRoot,c.halManifests,path.join(root,'kernel'),path.join(root,'sensors')])fs.mkdirSync(directory);
  for(const name of ['logLibrary','composerHal','compositionRoot','sensorsHal','dnsPolicyLibrary','vendorManifest','binderLibrary','serviceWaiter','bootstrap','hostLibrary']){c[name]=path.join(root,name);fs.writeFileSync(c[name],'');}
  const enrollments=[],retirements=[];
  const owner={socketPath:path.join(root,'owner.sock'),identity:{pid:process.pid,uid:process.getuid(),securityContext:'u:r:system_server:s0',packageName:'android',processName:'android.system'},async enroll(value){enrollments.push(value);},async retire(value){retirements.push(value);}};
  const spawnProcess=(name,command,args,options)=>{
   const p=spawn(process.execPath,[path.join(__dirname,'fixtures/android-art-composition/publisher.mjs'),root,name,JSON.stringify(args)],options);
   p.closed=once(p,'close');p.closed.catch(()=>{});children.push({name,args,process:p});return p;
  };
  composition=await startComposition({directory:root,supplier:{components:c},payload:{root,profile:{}},sharedGraphics:root,binderName:'fixture',env:{...process.env},owner,appUid:10000,appLabel:'Android',application:{executablePath:path.join(root,'presenter')},kernelRuntime:path.join(root,'kernel'),pathMap:'root\t/\t'+c.image+'\n',cache:path.join(root,'cache'),spawnProcess,signal:controller.signal,viewport:{width:64,height:32,densityDpi:160},sensorRoot:path.join(root,'sensors'),networkAllowed:false,allowAds:false});
  const publishers=['system-suspend','mediametrics','audio-hal'];
  await wait(()=>publishers.every(name=>children.some(child=>child.name===name)));
  const barriers=children.filter(child=>child.name==='wait-system-suspend-mediametrics-audio-hal');
  assert.equal(barriers.length,1,'one helper observes all three original publications');
  assert.deepEqual(barriers[0].args.slice(barriers[0].args.indexOf('/system/bin/maclauncher-art-service-wait')+1),['android.system.suspend.ISystemSuspend/default','media.metrics','android.hardware.audio.core.IModule/default']);
  await wait(()=>['mediametrics','audio-hal'].every(name=>fs.existsSync(path.join(root,'marks',name))));
  assert.equal(fs.existsSync(path.join(root,'marks/system-suspend')),false,'the first publication is still blocked');
  assert.equal(children.some(child=>child.name==='audioserver'),false,'audioserver retains all three dependencies');
  if(outcome==='ready'){
   fs.writeFileSync(path.join(root,'marks/release-suspend'),'1');await composition.mediaStartup;
   assert.ok(children.some(child=>child.name==='audioserver'));
   assert.equal(composition.mediaFailures.length,0);
  }else{
   if(outcome==='failure'){const p=children.find(child=>child.name==='system-suspend').process;p.kill('SIGTERM');await p.closed;}
   else controller.abort(Error('cancelled media fixture'));
   await composition.mediaStartup;
   assert.equal(children.some(child=>child.name==='audioserver'),false);
   assert.ok(composition.mediaFailures.some(row=>outcome==='failure'?/system-suspend/.test(row.error):/cancelled media fixture/.test(row.error)));
  }
  await composition.close();await composition.close();
  await Promise.all(children.map(({process:p})=>p.closed));
  assert.ok(children.every(({process:p})=>p.exitCode!==null||p.signalCode!==null),'every exact owned helper/publisher retires');
  assert.deepEqual(retirements,enrollments,'the same enrolled authority retires once');
  assert.throws(()=>fs.fstatSync(composition.input),{code:'EBADF'});
 });
});
