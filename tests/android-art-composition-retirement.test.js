const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events');

test('composition authority failure still closes descriptors after every owned CPU helper exits',{timeout:15000},async t=>{
 const {startComposition}=await import('../src/modules/android/art/composition.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-composition-retirement-'));
 const fixture=path.join(__dirname,'fixtures/android-art-composition/publisher.mjs'),children=[];
 const c={image:path.join(root,'image'),halRoot:path.join(root,'hal'),halManifests:path.join(root,'manifests'),linuxRun:path.join(root,'linux-run')};
 fs.mkdirSync(path.join(c.image,'vendor/etc/vintf/manifest'),{recursive:true});
 for(const directory of[c.halRoot,c.halManifests,path.join(root,'kernel'),path.join(root,'sensors')])fs.mkdirSync(directory);
 for(const name of['logLibrary','composerHal','compositionRoot','sensorsHal','dnsPolicyLibrary','vendorManifest','binderLibrary','serviceWaiter','bootstrap','hostLibrary']){c[name]=path.join(root,name);fs.writeFileSync(c[name],'');}
 const failure=Error('owned authority retirement failed');let calls=0,composition;
 const owner={socketPath:path.join(root,'owner.sock'),identity:{pid:process.pid,uid:process.getuid(),securityContext:'u:r:system_server:s0',packageName:'android',processName:'android.system'},
  async enroll(){},async retire(){calls++;assert.ok(children.every(p=>p.exitCode!==null||p.signalCode!==null));throw failure;}};
 const spawnProcess=(name,command,args,options)=>{
  const child=spawn(process.execPath,[fixture,root,name,JSON.stringify(args)],options);
  child.closed=once(child,'close');child.closed.catch(()=>{});children.push(child);return child;
 };
 t.after(async()=>{
  await composition?.close().catch(()=>{});
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGKILL');}catch{}
  await Promise.allSettled(children.map(child=>child.closed));fs.rmSync(root,{recursive:true,force:true});
 });
 composition=await startComposition({directory:root,supplier:{components:c},payload:{root,profile:{}},sharedGraphics:root,binderName:'cpu-retirement',env:{...process.env},owner,appUid:10000,appLabel:'Android',application:{executablePath:path.join(root,'presenter')},kernelRuntime:path.join(root,'kernel'),pathMap:'root\t/\t'+c.image+'\n',cache:path.join(root,'cache'),spawnProcess,viewport:{width:64,height:32,densityDpi:160},sensorRoot:path.join(root,'sensors'),networkAllowed:false,allowAds:false});
 const first=composition.close();assert.equal(composition.close(),first);
 await assert.rejects(first,error=>error===failure);
 assert.equal(calls,1);assert.ok(children.every(p=>p.exitCode!==null||p.signalCode!==null));
 assert.throws(()=>fs.fstatSync(composition.input),{code:'EBADF'});
 assert.throws(()=>fs.fstatSync(composition.control),{code:'EBADF'});
 for(const child of children)assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
});
