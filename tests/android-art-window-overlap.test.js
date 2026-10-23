const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process'),{once}=require('node:events');
const wait=async condition=>{const end=Date.now()+4000;while(!condition()){assert.ok(Date.now()<end,'native window reached the requested boundary');await new Promise(resolve=>setTimeout(resolve,5));}};
test('native window load overlaps authority readiness while credentials follow real enrollment',{timeout:20000},async t=>{
 if(process.platform!=='darwin')return t.skip('Requires the composition owner macOS pipe lifecycle');
 const {startComposition}=await import('../src/modules/android/art/composition.mjs');
 for(const outcome of ['ready','authority-failure','window-failure','cancel','cancel-enrollment'])await t.test(outcome,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-window-overlap-')),children=[],controller=new AbortController();let composition;
  t.after(async()=>{controller.abort(Error('fixture retirement'));await composition?.close();for(const child of children)if(child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGKILL');}catch{}await Promise.allSettled(children.map(child=>child.closed));fs.rmSync(root,{recursive:true,force:true});});
  const c={image:path.join(root,'image'),halRoot:path.join(root,'hal'),halManifests:path.join(root,'manifests'),linuxRun:path.join(root,'linux-run')};
  fs.mkdirSync(path.join(c.image,'vendor/etc/vintf/manifest'),{recursive:true});for(const directory of [c.halRoot,c.halManifests,path.join(root,'kernel'),path.join(root,'sensors')])fs.mkdirSync(directory);
  for(const name of ['logLibrary','composerHal','compositionRoot','sensorsHal','dnsPolicyLibrary','vendorManifest','binderLibrary','serviceWaiter','bootstrap','hostLibrary']){c[name]=path.join(root,name);fs.writeFileSync(c[name],'');}
  let ready,failReady,enroll,releaseEnrollment;const enrollments=[],retirements=[];
  const owner={socketPath:path.join(root,'owner.sock'),identity:{pid:process.pid,uid:process.getuid(),securityContext:'u:r:system_server:s0',packageName:'android',processName:'android.system'},ready:new Promise((resolve,reject)=>{ready=()=>resolve(owner);failReady=reject;}),
   async enroll(value){enrollments.push(value);enroll();await new Promise(resolve=>releaseEnrollment=resolve);},async retire(value){retirements.push(value);}};
  const enrolling=new Promise(resolve=>enroll=resolve);
  const spawnProcess=(name,command,args,options)=>{const child=spawn(process.execPath,[path.join(__dirname,'fixtures/android-art-composition/publisher.mjs'),root,name,JSON.stringify(args)],options);child.closed=once(child,'close');child.closed.catch(()=>{});children.push(child);return child;};
  const starting=startComposition({directory:root,supplier:{components:c},payload:{root,profile:{}},sharedGraphics:root,binderName:'fixture',env:{...process.env},owner,appUid:10000,appLabel:'Android',application:{executablePath:path.join(root,'presenter')},kernelRuntime:path.join(root,'kernel'),pathMap:'root\t/\t'+c.image+'\n',cache:path.join(root,'cache'),spawnProcess,signal:controller.signal,viewport:{width:64,height:32,densityDpi:160},sensorRoot:path.join(root,'sensors'),networkAllowed:false,allowAds:false});starting.catch(()=>{});
  const marker=name=>path.join(root,'marks',name);
  await wait(()=>fs.existsSync(marker('window-root-loaded')));
  assert.equal(enrollments.length,0,'the original executable loads before the authority is ready');
  assert.equal(fs.existsSync(marker('window-root-authority.json')),false,'no credentials are sent before readiness');
  if(outcome==='ready'){
   ready();await enrolling;assert.equal(fs.existsSync(marker('window-root-authority.json')),false,'readiness alone cannot release the process');
   releaseEnrollment();composition=await starting;
   const fields=JSON.parse(fs.readFileSync(marker('window-root-authority.json')));
   assert.deepEqual(fields,['/dev/socket/maclauncher-platform',String(owner.identity.pid),String(owner.identity.uid),owner.identity.securityContext,owner.identity.packageName,owner.identity.processName]);
   fs.writeFileSync(marker('release-suspend'),'1');await composition.mediaStartup;await composition.close();
   assert.deepEqual(retirements,enrollments,'the exact enrolled process retires once');
  }else{
   if(outcome==='cancel-enrollment'){ready();await enrolling;controller.abort(Error('window overlap cancelled'));releaseEnrollment();}
   else if(outcome==='authority-failure')failReady(Error('original authority initialization failed'));
   else if(outcome==='window-failure')children.find(child=>child.ownerName==='window-root').kill('SIGTERM');
   else controller.abort(Error('window overlap cancelled'));
   await assert.rejects(starting,outcome==='authority-failure'?/original authority initialization failed/:outcome==='window-failure'?/window-root stopped/:/window overlap cancelled/);
   assert.equal(fs.existsSync(marker('window-root-authority.json')),false,'a failed launch receives no credentials');
  }
  await Promise.allSettled(children.map(child=>child.closed));assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null),'all original composition children retire');
 });
});
test('the native window consumes the complete authenticated authority packet and rejects truncation',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-window-packet-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {nativePlatformAuthority}=await import('../src/modules/android/art/composition.mjs');
 const binary=path.join(root,'packet'),compile=spawnSync('clang++',['-std=c++17','-Wall','-Wextra','-Werror','tests/fixtures/android-art-composition/authority.cpp','-o',binary],{encoding:'utf8'});assert.equal(compile.status,0,compile.stderr);
 const owner={socketPath:'/dev/socket/maclauncher-platform',identity:{pid:173,uid:1000,securityContext:'u:r:system_server:s0',packageName:'android',processName:'android.system'}};
 const packet=nativePlatformAuthority(owner),valid=spawnSync(binary,[],{input:packet,encoding:'utf8'});assert.equal(valid.status,0,valid.stderr);assert.deepEqual(valid.stdout.trim().split('\n'),[owner.socketPath,'173','1000',owner.identity.securityContext,'android','android.system']);
 for(const input of [packet.subarray(0,4),packet.subarray(0,-1),Buffer.concat([Buffer.from('0'),packet.subarray(1)])])assert.equal(spawnSync(binary,[],{input}).status,7);
});
