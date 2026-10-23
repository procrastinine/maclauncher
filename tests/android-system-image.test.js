const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const Image=require('../src/modules/android/system-image');
const RuntimeImage=require('../src/modules/android/runtime-image');
const {DownloadManager}=require('../src/modules/shared/runtime/download-manager');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-image-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const userDataDir=path.join(root,'profile'),volume=path.join(root,'original');fs.mkdirSync(userDataDir);fs.mkdirSync(path.join(volume,'root/system'),{recursive:true,mode:0o755});
  fs.writeFileSync(path.join(volume,'root/system/build.prop'),'ro.build.id=original\n');fs.symlinkSync('/system/build.prop',path.join(volume,'root/original-link'));
  const archive=Buffer.from('original archive'),image={url:'https://example.invalid/android.zip',sha256:sha(archive),bytes:archive.length};
  fs.writeFileSync(path.join(volume,'root.identity'),image.sha256+'\n');
  const expected=await Image.contentIdentity(path.join(volume,'root'));
  const context={userDataDir},events=[],mounts=new Map();let downloads=0,held=false;
  const deps={legacyLocations:()=>[],acquireLock:async()=>{if(held)return null;held=true;return async()=>{held=false;};},
    confirm:async()=>events.push('consent'),
    downloadToFile:async(_url,file)=>{downloads++;events.push('download');fs.writeFileSync(file,archive);},
    command:async(file,args,options={})=>{
      const op=path.basename(file);events.push(op+':'+args[0]);
      if(op==='plutil')return options.input;
      if(op==='hdiutil'){
        if(args[0]==='info')return JSON.stringify({images:[...mounts].map(([mount,record])=>({...record,'system-entities':[{'mount-point':mount}]}))});
        if(args[0]==='create'){fs.writeFileSync(args.at(-1),'sparse');return '';}
        if(args[0]==='attach'){
          const mount=args[args.indexOf('-mountpoint')+1],base=args.at(-1),writable=args.includes('-readwrite');
          fs.mkdirSync(mount,{recursive:true});if(!writable)fs.cpSync(volume,mount,{recursive:true,verbatimSymlinks:true});
          mounts.set(mount,{'image-path':base,writeable:writable});return '';
        }
        if(args[0]==='detach'){const mount=args[1];mounts.delete(mount);for(const name of fs.readdirSync(mount))fs.rmSync(path.join(mount,name),{recursive:true,force:true});return '';}
        if(args[0]==='convert'){fs.writeFileSync(args.at(-1),'immutable DMG');return '';}
      }
      if(op==='extractor'){fs.cpSync(volume,args[1]===path.join(path.dirname(args[1]),'root')?path.dirname(args[1]):args[1],{recursive:true,verbatimSymlinks:true});return '';}
      throw Error('Unexpected command '+file+' '+args[0]);
    }};
  const options={context,image,expected,extractor:'/owned/extractor'};
  return {root,userDataDir,volume,image,expected,context,events,mounts,deps,options,get downloads(){return downloads;}};
}

function runtimeFixture(f){
  const root=path.join(f.root,'runtime'),relative='native/bionic/profile.json',extractor='native/bionic/extractor';
  fs.mkdirSync(path.join(root,'native/bionic'),{recursive:true});fs.writeFileSync(path.join(root,extractor),'selected original extractor',{mode:0o755});
  const profile={schemaVersion:1,nativeAbi:'arm64-v8a',systemImage:{acquisition:f.image,content:f.expected,extractor}};
  const payload={root,runtimeIdentity:{}};
  const publish=()=>{
    fs.writeFileSync(path.join(root,relative),JSON.stringify(profile));
    const files=[relative,extractor].map(name=>{const stat=fs.statSync(path.join(root,name));return {path:name,size:stat.size,mode:stat.mode&0o777,sha256:sha(fs.readFileSync(path.join(root,name)))};});
    const bytes=Buffer.from(JSON.stringify({schemaVersion:1,files}));fs.writeFileSync(path.join(root,'runtime.json'),bytes);payload.runtimeIdentity.manifestSha256=sha(bytes);
  };
  publish();return {payload,profile,publish,relative,extractor};
}

test('verified JVM image requirements use shared consent/downloads and preserve cached older profiles',async t=>{
  const f=await fixture(t),runtime=runtimeFixture(f),history=[],downloads=new DownloadManager({progressThrottleMs:0,onChange:()=>history.push(downloads.list())});
  f.context.downloads=downloads;
  const original=f.deps.downloadToFile;f.deps.downloadToFile=async(url,file,options)=>{assert.equal(downloads.list()[0].managerId,'android-system-image');await original(url,file,options);options.onProgress({downloaded:f.image.bytes,total:f.image.bytes});};
  const image=await RuntimeImage.prepare({payload:runtime.payload,context:f.context},{imageDependencies:f.deps});
  assert.equal(image.archiveSha256,f.image.sha256);assert.equal(f.downloads,1);assert.equal(f.events[0],'consent');
  assert.ok(f.events.some(value=>value.startsWith('extractor:')));
  assert.ok(history.some(rows=>rows.some(row=>row.detail==='Preparing…')));assert.deepEqual(downloads.list(),[]);
  delete runtime.profile.systemImage.extractor;runtime.publish();f.events.length=0;
  assert.equal((await RuntimeImage.prepare({payload:runtime.payload,context:f.context},{imageDependencies:f.deps})).root,image.root);
  assert.equal(f.downloads,1);assert.ok(!f.events.includes('consent'));
});

test('JVM image requirement denial, cancellation and changed descriptor never start acquisition',async t=>{
  const f=await fixture(t),runtime=runtimeFixture(f),denied=Error('Original image consent declined');
  f.deps.confirm=async()=>{throw denied;};
  await assert.rejects(RuntimeImage.prepare({payload:runtime.payload,context:f.context},{imageDependencies:f.deps}),error=>error===denied);
  assert.equal(f.downloads,0);assert.deepEqual(fs.readdirSync(f.userDataDir),[]);
  fs.appendFileSync(path.join(runtime.payload.root,runtime.relative),' ');
  await assert.rejects(RuntimeImage.prepare({payload:runtime.payload,context:f.context},{imageDependencies:f.deps}),/preparation files changed/);
  assert.equal(f.downloads,0);assert.deepEqual(fs.readdirSync(f.userDataDir),[]);
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(RuntimeImage.prepare({payload:runtime.payload,context:{...f.context,signal:cancelled.signal}},{imageDependencies:f.deps}),{name:'AbortError'});
});

test('legacy and ARM32 JVM payloads add no image requirement; fresh preparation needs its own supplied helper',async t=>{
  const f=await fixture(t),runtime=runtimeFixture(f),never={prepareImage:()=>assert.fail('This payload must not acquire an image')};
  assert.equal(await RuntimeImage.prepare({payload:runtime.payload,context:f.context,nativeAbi:'armeabi-v7a'},never),null);
  fs.unlinkSync(path.join(runtime.payload.root,runtime.relative));
  assert.equal(await RuntimeImage.prepare({payload:runtime.payload,context:f.context},never),null);
  runtime.publish();delete runtime.profile.systemImage.extractor;runtime.publish();
  await assert.rejects(RuntimeImage.prepare({payload:runtime.payload,context:f.context},{imageDependencies:f.deps}),/does not include system image preparation/);
  assert.equal(f.downloads,0);assert.deepEqual(fs.readdirSync(f.userDataDir),[]);
});

test('system image consent precedes all output writes and download; denial and pre-cancel preserve storage',async t=>{
  const f=await fixture(t),cancelled=Error('Declined setup');f.deps.confirm=async()=>{assert.deepEqual(fs.readdirSync(f.userDataDir),[]);throw cancelled;};
  await assert.rejects(Image.prepare(f.options,f.deps),error=>error===cancelled);
  assert.deepEqual(fs.readdirSync(f.userDataDir),[]);assert.equal(f.downloads,0);
  const controller=new AbortController();controller.abort();f.context.signal=controller.signal;
  await assert.rejects(Image.prepare(f.options,f.deps),{name:'AbortError'});assert.deepEqual(fs.readdirSync(f.userDataDir),[]);
});

test('one immutable base is atomically shared by concurrent preparations and reused without further consent/download',async t=>{
  const f=await fixture(t);
  const results=await Promise.all([Image.prepare(f.options,f.deps),Image.prepare(f.options,f.deps)]);
  assert.equal(results[0].root,results[1].root);assert.equal(f.downloads,1);
  assert.equal(f.events[0],'consent');assert.equal(fs.statSync(results[0].base).mode&0o777,0o400);
  assert.equal(f.mounts.get(path.dirname(results[0].root)).writeable,false);
  f.events.length=0;const same=await Image.prepare(f.options,f.deps);
  assert.equal(same.base,results[0].base);assert.equal(f.downloads,1);assert.ok(!f.events.includes('consent'));
  assert.deepEqual(fs.readdirSync(path.dirname(same.directory)).filter(name=>name.startsWith('.image-')),[]);
});

test('system image acquisition remains in shared downloads through verification/import and reuses its completed base',async t=>{
  const f=await fixture(t),history=[],downloads=new DownloadManager({progressThrottleMs:0,onChange:()=>history.push(downloads.list())});
  f.context.downloads=downloads;
  const transfer=f.deps.downloadToFile,run=f.deps.command;
  f.deps.downloadToFile=async(url,file,options)=>{assert.equal(downloads.list()[0].sectionId,'default');await transfer(url,file,options);options.onProgress({downloaded:f.image.bytes,total:f.image.bytes});};
  f.deps.command=async(file,args,options)=>{
    if(file==='/owned/extractor'){const task=downloads.list()[0];assert.equal(task.detail,'Preparing…');assert.equal(task.downloaded,f.image.bytes);}
    return run(file,args,options);
  };
  await Image.prepare(f.options,f.deps);
  assert.deepEqual(downloads.list(),[]);assert.ok(history.some(rows=>rows.some(row=>row.detail==='Verifying…')));
  assert.ok(history.some(rows=>rows.some(row=>row.status==='done')));
  history.length=0;await Image.prepare(f.options,f.deps);assert.equal(f.downloads,1);assert.deepEqual(history,[]);
});

test('shared image task cancellation preserves launch cancellation and cleans its staged mount',async t=>{
  for(const from of ['downloads','launch'])await t.test(from,async t=>{
    const f=await fixture(t),controller=new AbortController(),downloads=new DownloadManager();
    f.context.downloads=downloads;f.context.signal=controller.signal;
    const run=f.deps.command;f.deps.command=async(file,args,options)=>{
      const result=await run(file,args,options);
      if(file==='/owned/extractor'){
        if(from==='downloads')downloads.cancel(downloads.list()[0].id);else controller.abort();
        options.context.signal.throwIfAborted();
      }
      return result;
    };
    await assert.rejects(Image.prepare(f.options,f.deps),{name:'AbortError'});
    assert.deepEqual(downloads.list(),[]);assert.equal(f.mounts.size,0);
    assert.ok(!fs.readdirSync(path.join(f.userDataDir,'android/system-images')).some(name=>name.startsWith('.image-')));
  });
});

test('archive mismatch and cancellation after writable attachment leave no completed image or mounted stage',async t=>{
  const f=await fixture(t);f.deps.downloadToFile=async(_url,file)=>fs.writeFileSync(file,'wrong archive');
  await assert.rejects(Image.prepare(f.options,f.deps),/checksum/);
  assert.deepEqual(fs.readdirSync(path.join(f.userDataDir,'android/system-images')).filter(name=>!name.startsWith('.'+f.image.sha256)),[]);
  const controller=new AbortController();f.context.signal=controller.signal;
  f.deps.downloadToFile=async(_url,file)=>fs.writeFileSync(file,'original archive');
  const run=f.deps.command;f.deps.command=async(file,args,options)=>{const result=await run(file,args,options);if(file==='/owned/extractor')controller.abort();return result;};
  await assert.rejects(Image.prepare(f.options,f.deps),{name:'AbortError'});
  assert.equal(f.mounts.size,0);assert.ok(!fs.existsSync(path.join(f.userDataDir,'android/system-images',f.image.sha256)));
  assert.ok(!fs.readdirSync(path.join(f.userDataDir,'android/system-images')).some(name=>name.startsWith('.image-')));
});

test('original content, stored DMG bytes, aliases and writable foreign mounts fail closed',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(f.userDataDir,'android'));
  await assert.rejects(Image.prepare(f.options,f.deps),/aliases/);assert.equal(f.events.length,0);assert.deepEqual(fs.readdirSync(outside),[]);fs.unlinkSync(path.join(f.userDataDir,'android'));
  fs.writeFileSync(path.join(f.volume,'root/system/build.prop'),'different source\n');
  await assert.rejects(Image.prepare(f.options,f.deps),/content differs/);assert.equal(f.mounts.size,0);
  fs.writeFileSync(path.join(f.volume,'root/system/build.prop'),'ro.build.id=original\n');
  const good=await Image.prepare(f.options,f.deps);
  const mount=path.dirname(good.root);f.mounts.get(mount).writeable=true;
  await assert.rejects(Image.prepare(f.options,f.deps),/different or writable/);assert.equal(f.mounts.get(mount).writeable,true,'A foreign/writable owner is never force-detached');
  f.mounts.get(mount).writeable=false;
  fs.chmodSync(good.base,0o600);fs.writeFileSync(good.base,'modified DMG!');fs.chmodSync(good.base,0o400);
  await assert.rejects(Image.prepare(f.options,f.deps),/content changed|receipt differs/);
});

test('matching original AIM bases share storage without mutating writable legacy modes or using derived images',async t=>{
  const f=await fixture(t),legacy=path.join(f.userDataDir,'android/runtimes/aim/old');fs.mkdirSync(path.join(legacy,'system'),{recursive:true});
  fs.cpSync(f.volume,path.join(legacy,'system'),{recursive:true,verbatimSymlinks:true});fs.writeFileSync(path.join(legacy,'system.dmg'),'immutable DMG',{mode:0o600});
  f.mounts.set(path.join(legacy,'system'),{'image-path':path.join(legacy,'system.dmg'),writeable:false});
  f.deps.legacyLocations=()=>[legacy];f.deps.downloadToFile=()=>assert.fail('Compatible original image needs no download');
  const shared=await Image.prepare(f.options,f.deps);
  assert.equal(fs.statSync(path.join(legacy,'system.dmg')).mode&0o777,0o600);
  assert.equal(fs.statSync(shared.base).mode&0o777,0o400);
  assert.notEqual(fs.statSync(shared.base).ino,fs.statSync(path.join(legacy,'system.dmg')).ino,'Writable legacy owner retains a distinct inode');
  assert.equal(f.events.some(value=>value.startsWith('extractor:')),false);assert.equal(f.downloads,0);
});

test('AIM setup adopts the shared original through an isolated inode without another download or consent',async t=>{
  const f=await fixture(t),original=await Image.prepare(f.options,f.deps);
  f.events.length=0;f.deps.confirm=()=>assert.fail('An acquired original needs no new consent');f.deps.downloadToFile=()=>assert.fail('An acquired original needs no download');
  const destination=path.join(f.userDataDir,'android/runtimes/aim/new/system.dmg');
  assert.equal(await Image.adoptBase({context:f.context,image:f.image,destination},f.deps),true);
  assert.notEqual(fs.statSync(original.base).ino,fs.statSync(destination).ino,'AIM and ART retain independent image attach/detach owners');
  assert.equal(fs.statSync(destination).mode&0o777,0o400);assert.ok(fs.readFileSync(destination).equals(fs.readFileSync(original.base)));
  fs.chmodSync(destination,0o600);fs.writeFileSync(destination,'AIM independent replacement');
  assert.equal(fs.readFileSync(original.base,'utf8'),'immutable DMG','A later AIM inode mutation does not alter ART original');
  assert.ok(!f.events.includes('consent'));
});

test('thin ART binds a verified external image and its exact complete owned package root',async t=>{
  const f=await fixture(t),root=path.join(f.root,'thin'),art=path.join(root,'art');fs.mkdirSync(art,{recursive:true});
  const definition=require('../src/modules/android/art/supplier.json'),components=require('../src/modules/android/art/components.json');
  for(const [name,relative]of Object.entries(components))if(name!=='image')fs.mkdirSync(path.join(art,relative),{recursive:true});
  fs.writeFileSync(path.join(art,'host/android-image-extract'),'included helper');
  const manifest={schemaVersion:1,execution:'art',supplier:definition.id,hostcallVersion:definition.hostcallVersion,android:definition.android,
    imageAcquisition:definition.imageAcquisition,components,bootClasspath:['/apex/com.android.art/javalib/core-oj.jar'],platformSupplier:{schemaVersion:1,image:f.expected}};
  const bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(art,'runtime.json'),bytes,{mode:0o644});
  const install={root,declaration:{files:[{path:'art/runtime.json',size:bytes.length,sha256:sha(bytes),mode:0o644}]}};
  let prepared=0;const {prepareSupplier}=require('../src/modules/android/art/image');
  const descriptor=await prepareSupplier({install,context:f.context},{prepareImage:async options=>{prepared++;assert.equal(options.expected.sha256,f.expected.sha256);assert.equal(options.extractor,path.join(art,'host/android-image-extract'));return {root:path.join(f.volume,'root')};}});
  assert.equal(descriptor.packageRoot,fs.realpathSync(root));assert.equal(descriptor.root,art);assert.equal(descriptor.components.image,path.join(f.volume,'root'));
  assert.equal(prepared,1);fs.appendFileSync(path.join(art,'runtime.json'),' ');
  await assert.rejects(prepareSupplier({install,context:f.context},{prepareImage:()=>assert.fail('Changed metadata cannot prepare an image')}),/metadata changed/);
});

test('fresh launcher workers reuse verified immutable fingerprints and reverify any changed base',async t=>{
  const f=await fixture(t),image=await Image.prepare(f.options,f.deps);
  const {spawnSync}=require('node:child_process'),moduleFile=require.resolve('../src/modules/android/system-image');
  const records=[...f.mounts].map(([mount,row])=>({...row,'system-entities':[{'mount-point':mount}]}));
  const script=`const Image=require(${JSON.stringify(moduleFile)});const options=${JSON.stringify(f.options)};options.context={userDataDir:${JSON.stringify(f.userDataDir)}};Image.prepare(options,{acquireLock:async()=>async()=>{},legacyLocations:()=>[],hashFile:async()=>{throw Error('unexpected full container hash')},contentIdentity:async()=>{throw Error('unexpected full image walk')},command:async(file,args,opts)=>file.endsWith('/plutil')?opts.input:JSON.stringify({images:${JSON.stringify(records)}})}).then(()=>console.log('persistent verification reused'),error=>{console.error(error.message);process.exitCode=1;});`;
  const run=()=>spawnSync(process.execPath,['-e',script],{encoding:'utf8',timeout:10000});
  const first=run();assert.ifError(first.error);assert.equal(first.status,0,first.stderr);assert.match(first.stdout,/persistent verification reused/);
  fs.chmodSync(image.base,0o600);fs.writeFileSync(image.base,'new bytes same size');fs.chmodSync(image.base,0o400);
  const changed=run();assert.ifError(changed.error);assert.notEqual(changed.status,0);assert.match(changed.stderr,/receipt differs|unexpected full container hash/);
});
