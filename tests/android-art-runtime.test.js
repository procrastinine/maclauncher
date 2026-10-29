const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolve}=require('../src/modules/android/art/runtime');
const definition=require('../src/modules/android/art/supplier.json');
function fixture(t,cleanup){const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-'));t.after(()=>{cleanup?.(root);fs.rmSync(root,{recursive:true,force:true});});return root;}
const componentNames=Object.keys(require('../src/modules/android/art/components.json'));
test('actual ART native host binds the selected runner identity API before guest execution',{timeout:15000},t=>{
 if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires the native Apple Silicon ART supplier');
 const {spawnSync}=require('node:child_process');
 const declarations=require('../src/modules/android/managed-packages.json');
 const payloadRoot=path.resolve(__dirname,'../src/resources/native-runtimes');
 const art=declarations.find(row=>row.id==='android-art'&&row.arch==='arm64'),common=declarations.find(row=>row.id==='android'&&row.arch==='arm64');
 const supplierRoot=art&&path.join(payloadRoot,art.directoryRelative,'art');
 const runner=process.env.ANDROID_ART_LINUX_RUN||(supplierRoot&&path.join(supplierRoot,'host/linux-run'));
 const host=process.env.ANDROID_ART_HOST_LIBRARY||(supplierRoot&&path.join(supplierRoot,'host/libandroid-art-host.dylib'));
 if(!runner||!host||!fs.existsSync(runner)||!fs.existsSync(host))return t.skip('Requires the installed ART runner and production host library');
 const root=fixture(t),identity=path.join(root,'identity');fs.mkdirSync(identity,{mode:0o700});
 const frameworkPath=common&&path.join(payloadRoot,common.directoryRelative,'native');
 const result=spawnSync(runner,['--host-module',host,'--root',root,'--no-cache','/__art_host_binding_missing__'],{
  encoding:'utf8',timeout:10000,maxBuffer:64*1024,env:{...process.env,KL_ANDROID_ID_DIRECTORY:identity,...(frameworkPath?{DYLD_FRAMEWORK_PATH:frameworkPath}:{})}
 });
 assert.ifError(result.error);assert.equal(result.signal,null,result.stderr);assert.equal(result.status,127,result.stderr);
 // The actual runner installs every required identity operation from the real
 // host before resolving this absent program. No image or guest app is needed.
 assert.equal(result.stderr.trim(),'linux-run: /__art_host_binding_missing__: cannot execute (errno 2)');
});
test('ART preparation joins an independent pending package lease before failed-launch cleanup',{timeout:10000},async t=>{
 const {launch}=await import('../src/modules/android/art/launch.mjs');
 const Host=require('../src/modules/android/host'),Preparation=require('../src/modules/android/prepare');
 const root=fixture(t),entry={gameId:'parallel-preparation'};
 const prepared={root,metadata:{packageName:'example.parallel',launchers:[{activity:'example.parallel.Main'}]},filesRoot:root,cacheRoot:root,assetsRoot:root,nativeRoot:root,resourcesRoot:root};
 let packageStarted,metadataStarted,finishPackage,failMetadata,released=0,apkReleased=0,settled=false;
 const packageReady=new Promise(resolve=>{packageStarted=resolve;}),metadataReady=new Promise(resolve=>{metadataStarted=resolve;});
 const pendingPackage=new Promise(resolve=>{finishPackage=resolve;}),pendingMetadata=new Promise((_,reject)=>{failMetadata=reject;});
 t.mock.method(require('../src/modules/android/art/runtime'),'resolve',()=>({manifest:{android:{architectures:['arm64-v8a']}},components:{}}));
 t.mock.method(Host,'ensureJava',async()=>({javaPath:'/unused/java'}));
 t.mock.method(require('../src/modules/android/runtime'),'resolveForLaunch',async()=>({root,profile:{}}));
 t.mock.method(Preparation,'retainPrepared',async()=>async()=>{apkReleased++;});
 t.mock.method(require('../src/modules/android/web-links'),'prepareLaunch',()=>{});
 t.mock.method(require('../src/modules/android/platform-services/client'),'prepare',async()=>({ready:Promise.resolve(),close:async()=>{}}));
 t.mock.method(require('../src/modules/android/media-inputs'),'configureLaunch',async()=>{});
 t.mock.method(require('../src/modules/android/service-packages'),'prepareInstalled',async()=>{packageStarted();return pendingPackage;});
 t.mock.method(require('../src/modules/android/package-metadata'),'applyLaunchIdentity',async()=>{metadataStarted();return pendingMetadata;});
 const operation=launch(entry,{userDataDir:root,runtimeSettings:{}},{root,profile:{}},{prepare:async()=>prepared,resolveVulkan:async()=>({}),resolvePlatformRuntime:async()=>({root,profile:{}})});
 operation.then(()=>{settled=true;},()=>{settled=true;});
 await Promise.all([packageReady,metadataReady]);
 const failure=Error('Original metadata failure');failMetadata(failure);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(settled,false,'Launch failure must retain ownership of pending package preparation');
 assert.equal(apkReleased,0,'The APK source stays retained until its dependent preparation settles');
 finishPackage({release:async()=>{released++;}});
 await assert.rejects(operation,error=>error===failure);
 assert.equal(released,1);assert.equal(apkReleased,1);
 assert.deepEqual(fs.readdirSync(path.join(require('../src/modules/android/storage').storagePaths(root,entry.gameId).runtimeRoot,'art')),[]);
});
test('ART browser registration preserves frames and rejects a retired presenter asynchronously',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires native FIFO descriptors');
 const {execFileSync}=require('node:child_process');
 const {browserRegistrationWriter}=await import('../src/modules/android/art/composition.mjs');
 const root=fixture(t),pipe=path.join(root,'browser');execFileSync('/usr/bin/mkfifo',['-m','600',pipe]);
 const reader=fs.openSync(pipe,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK),fd=fs.openSync(pipe,fs.constants.O_WRONLY|fs.constants.O_NONBLOCK);fs.unlinkSync(pipe);
 let failure;const writer=browserRegistrationWriter(fd,error=>{failure=error;});
 t.after(()=>{writer.close();try{fs.closeSync(reader);}catch{}});
 const registrations=[{token:'one',root:'/private/app',guest:'/data/user/0/one',network:false},{token:'one',retire:true}];
 await Promise.all(registrations.map(value=>writer.send(value)));
 const bytes=Buffer.alloc(4096),count=fs.readSync(reader,bytes,0,bytes.length,null);let offset=0;
 for(const value of registrations){const length=bytes.readUInt32LE(offset);offset+=4;assert.deepEqual(JSON.parse(bytes.subarray(offset,offset+length)),value);offset+=length;}assert.equal(offset,count);
 fs.closeSync(reader);
 await assert.rejects(writer.send({token:'one',retire:true}),error=>error.code==='EPIPE');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(failure.code,'EPIPE');
 writer.close();await assert.rejects(writer.send({token:'two'}),error=>error.code==='ERR_STREAM_DESTROYED');
});
test('ART native service failures retain the bounded actual exit diagnostic',async t=>{
 const directory=fixture(t),{nativeServiceError}=await import('../src/modules/android/art/composition.mjs');
 fs.writeFileSync(path.join(directory,'linkerconfig.log'),'old startup text\n'+'x'.repeat(16384)+'\noriginal ownership error\n');
 const error=nativeServiceError(directory,'linkerconfig',null,'SIGABRT');
 assert.match(error.message,/Android service linkerconfig stopped \(SIGABRT\)/);
 assert.ok(error.message.endsWith('original ownership error'));
 assert.ok(!error.message.includes('old startup text'));
 assert.ok(Buffer.byteLength(error.message)<8300);
 assert.equal(nativeServiceError(directory,'audio',7,null).message,'Android service audio stopped (7)');
});
test('ART native readiness preserves child failures, dependency exits and cancellation',async t=>{
 const {spawn}=require('node:child_process'),{once}=require('node:events');
 const {nativeServiceReady}=await import('../src/modules/android/art/composition.mjs');
 const directory=fixture(t),children=[];
 const child=(name,script)=>{const log=fs.openSync(path.join(directory,name+'.log'),'w');let p;try{p=spawn(process.execPath,['-e',script],{stdio:['pipe',log,log]});}finally{fs.closeSync(log);}p.ownerName=name;children.push(p);return p;};
 t.after(async()=>{await Promise.all(children.map(async p=>{if(p.exitCode!==null||p.signalCode!==null)return;const ended=once(p,'close');p.kill('SIGKILL');await ended;}));});
 const successful=child('wait-ready','process.stdin.once("data",()=>process.exit(0));');
 let complete=false;const ready=nativeServiceReady(directory,successful).then(()=>{complete=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(complete,false);successful.stdin.end('ready');await ready;
 const failed=child('wait-failed','console.error("original Binder transport failure");process.exit(15);');
 await assert.rejects(nativeServiceReady(directory,failed),/wait-failed stopped \(15\): original Binder transport failure/);
 const dependency=child('composer','process.stdin.once("data",()=>{console.error("original composer initialization failure");process.exit(23);});');
 const waiting=child('wait-composer','setInterval(()=>{},1000);');
 const dependencyReady=nativeServiceReady(directory,waiting,{dependency});dependency.stdin.end('stop');
 await assert.rejects(dependencyReady,/composer stopped \(23\): original composer initialization failure/);
 assert.equal(waiting.listenerCount('close'),0);assert.equal(dependency.listenerCount('close'),0);
 const first=child('ready-composer','setInterval(()=>{},1000);'),second=child('surfaceflinger','process.stdin.once("data",()=>{console.error("original SurfaceFlinger failure");process.exit(24);});');
 const both=nativeServiceReady(directory,waiting,{dependencies:[first,second]});second.stdin.end('stop');
 await assert.rejects(both,/surfaceflinger stopped \(24\): original SurfaceFlinger failure/);
 assert.equal(first.listenerCount('close'),0);assert.equal(second.listenerCount('close'),0);assert.equal(waiting.listenerCount('close'),0);
 const abort=new AbortController(),cancelled=nativeServiceReady(directory,waiting,{signal:abort.signal});
 const reason=Error('Explicit native launch cancellation');abort.abort(reason);
 await assert.rejects(cancelled,error=>error===reason);assert.equal(waiting.listenerCount('close'),0);
 const terminal=Error('Original presenter failure');let fail;const failure=new Promise((resolve,reject)=>{fail=reject;});
 const stopped=nativeServiceReady(directory,waiting,{failure});fail(terminal);
 await assert.rejects(stopped,error=>error===terminal);assert.equal(waiting.listenerCount('close'),0);
});
test('ART supplier keeps component identity and paths after relocation',async t=>{
 const root=fixture(t),inputs={};for(const name of componentNames){inputs[name]=path.join(root,'inputs',name);fs.mkdirSync(path.dirname(inputs[name]),{recursive:true});fs.writeFileSync(inputs[name],name);}
 fs.rmSync(inputs.image);fs.mkdirSync(inputs.image);fs.writeFileSync(path.join(inputs.image,'target'),'original image');fs.symlinkSync('target',path.join(inputs.image,'alias'));
 fs.rmSync(inputs.halManifests);fs.mkdirSync(inputs.halManifests);
 inputs.nativeBridge=path.join(root,'native-bridge.so');fs.writeFileSync(inputs.nativeBridge,'shared native bridge');
 inputs.linuxTranslate=path.join(root,'linux-translate');fs.writeFileSync(inputs.linuxTranslate,'matching original translator');
 inputs.ptyHolder=path.join(root,'aim-pty-holder');fs.writeFileSync(inputs.ptyHolder,'original terminal owner');
 inputs.platformPackages=path.join(root,'platform-packages.json');const platformPackages={schemaVersion:1,packages:[]};fs.writeFileSync(inputs.platformPackages,JSON.stringify(platformPackages));
 inputs.serviceWaiter=path.join(root,'service-wait');fs.writeFileSync(inputs.serviceWaiter,'original Binder-only readiness');
 inputs.hwuiLibrary=path.join(root,'libhwui.so');fs.writeFileSync(inputs.hwuiLibrary,'complete adapted Android graphics module');
 inputs.hwuiNotices=path.join(root,'hwui-notices');fs.mkdirSync(inputs.hwuiNotices);fs.writeFileSync(path.join(inputs.hwuiNotices,'NOTICE'),'original Android graphics notice');
 inputs.arm32Builtins=path.join(root,'arm32-builtins.so');fs.writeFileSync(inputs.arm32Builtins,'original shared ARM32 compiler runtime');
 inputs.nativeBridgeNotices=path.join(root,'bridge-notices');fs.mkdirSync(inputs.nativeBridgeNotices);fs.writeFileSync(path.join(inputs.nativeBridgeNotices,'libffi.txt'),'original libffi license');
 inputs.bootImage=path.join(root,'boot-image');fs.mkdirSync(path.join(inputs.bootImage,'framework/arm64'),{recursive:true});
 const bootImage={identity:'matching-content',location:'/system/framework/boot.art',files:['framework/arm64/boot.art'],bootClasspath:['/apex/com.android.art/javalib/core-oj.jar']};
 fs.writeFileSync(path.join(inputs.bootImage,'boot-image.json'),JSON.stringify(bootImage));fs.writeFileSync(path.join(inputs.bootImage,bootImage.files[0]),'matched compiled image');
 const {assembleArtSupplier,artSupplierComponents,imageContentIdentity}=await import('../src/modules/android/art/build.mjs');
 const payload=path.join(root,'payload'),output=path.join(payload,'art');
 assembleArtSupplier({output,inputs,bootClasspath:['/apex/com.android.art/javalib/core-oj.jar'],sourceVersion:'test-source'});
 const moved=path.join(root,'moved');fs.renameSync(payload,moved);
 assert.throws(()=>resolve({root:moved,profile:{}}),/not included/);
 const actual=resolve({root:moved,profile:{artExecutionVersion:1}});
 assert.deepEqual(actual.manifest.components,artSupplierComponents(inputs));
 assert.deepEqual(actual.manifest.platformSupplier.image,imageContentIdentity(inputs.image));
 assert.deepEqual(actual.manifest.platformSupplier.catalog,{sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(inputs.platformPackages)).digest('hex'),size:fs.statSync(inputs.platformPackages).size,mode:fs.statSync(inputs.platformPackages).mode&0o7777});
 const reused=path.join(root,'reused'),originalOpen=fs.openSync;
 fs.openSync=function(file,...args){if(typeof file==='string'&&file.startsWith(path.join(reused,'image')+path.sep))throw Error('Retained immutable image was hashed again');return originalOpen.call(fs,file,...args);};
 let retained;
 try{retained=assembleArtSupplier({output:reused,inputs:actual.components,bootClasspath:actual.bootClasspath,sourceVersion:'new-native-only',baseSupplier:{root:actual.root,manifest:actual.manifest}});}
 finally{fs.openSync=originalOpen;}
 assert.deepEqual(retained.platformSupplier,actual.manifest.platformSupplier,'Native-only assembly keeps the complete immutable image identity without rereading its files');
 const changedCatalog=path.join(root,'changed-catalog.json');fs.writeFileSync(changedCatalog,JSON.stringify({schemaVersion:1,packages:[{packageName:'android.example'}]}));
 const catalogOnly=assembleArtSupplier({output:path.join(root,'catalog-only'),inputs:{...actual.components,platformPackages:changedCatalog},bootClasspath:actual.bootClasspath,sourceVersion:'new-catalog',baseSupplier:{root:actual.root,manifest:actual.manifest}});
 assert.deepEqual(catalogOnly.platformSupplier.image,actual.manifest.platformSupplier.image);assert.notEqual(catalogOnly.platformSupplier.catalog.sha256,actual.manifest.platformSupplier.catalog.sha256);
 const changedImage=path.join(root,'changed-image');fs.cpSync(actual.components.image,changedImage,{recursive:true,verbatimSymlinks:true});fs.writeFileSync(path.join(changedImage,'target'),'changed image data');
 const imageOnly=assembleArtSupplier({output:path.join(root,'image-only'),inputs:{...actual.components,image:changedImage},bootClasspath:actual.bootClasspath,sourceVersion:'new-image',baseSupplier:{root:actual.root,manifest:actual.manifest}});
 assert.notEqual(imageOnly.platformSupplier.image.sha256,actual.manifest.platformSupplier.image.sha256,'A different image component cannot borrow the base identity');
 assert.deepEqual(JSON.parse(fs.readFileSync(actual.components.platformPackages)),platformPackages);
 assert.equal(actual.manifest.android.imageSha256,definition.android.imageSha256);
 assert.equal(fs.readFileSync(actual.components.linuxRun,'utf8'),'linuxRun');
 assert.equal(fs.readFileSync(actual.components.linuxTranslate,'utf8'),'matching original translator');
 assert.equal(fs.readFileSync(actual.components.ptyHolder,'utf8'),'original terminal owner');
 assert.equal(path.dirname(actual.components.ptyHolder),path.dirname(actual.components.linuxRun));
 assert.equal(actual.manifest.components.ptyHolder,'host/aim-pty-holder');
 assert.equal(fs.readFileSync(actual.components.serviceWaiter,'utf8'),'original Binder-only readiness');
 assert.equal(fs.readFileSync(actual.components.hwuiLibrary,'utf8'),'complete adapted Android graphics module');
 assert.equal(actual.manifest.components.hwuiLibrary,'guest/libhwui.so');
 assert.equal(fs.readFileSync(path.join(actual.components.hwuiNotices,'NOTICE'),'utf8'),'original Android graphics notice');
 assert.ok(actual.manifest.notices.some(row=>row.path==='licenses/hwui/NOTICE'));
 assert.ok(actual.manifest.notices.some(row=>row.path==='licenses/native-bridge/libffi.txt'));
 assert.equal(fs.readFileSync(actual.components.nativeBridge,'utf8'),'shared native bridge');
 assert.equal(fs.readFileSync(actual.components.arm32Builtins,'utf8'),'original shared ARM32 compiler runtime');
 assert.equal(fs.readFileSync(path.join(actual.components.nativeBridgeNotices,'libffi.txt'),'utf8'),'original libffi license');
 assert.deepEqual(actual.manifest.bootImage,bootImage);
 assert.equal(fs.readFileSync(path.join(actual.components.bootImage,bootImage.files[0]),'utf8'),'matched compiled image');
 assert.deepEqual(actual.manifest.android.architectures,[...definition.android.architectures,'armeabi-v7a','armeabi'],'The complete optional NativeBridge supplier declares its translated native ABI');
 assert.equal(fs.readlinkSync(path.join(actual.components.image,'alias')),'target');
 assert.equal(fs.readFileSync(path.join(actual.components.image,'alias'),'utf8'),'original image');
 assert.equal(actual.manifest.imageAcquisition.license.id,'android-sdk-arm-dbt-license');
 assert.ok(actual.components.linuxRun.startsWith(moved+path.sep));
 assert.ok(!fs.readFileSync(path.join(moved,'art/runtime.json'),'utf8').includes(root));
 const previous=structuredClone(actual.manifest);delete previous.components.ptyHolder;delete previous.components.hwuiLibrary;delete previous.components.hwuiNotices;delete previous.notices;
 fs.writeFileSync(path.join(moved,'art/runtime.json'),JSON.stringify(previous));
 assert.equal(resolve({root:moved,profile:{artExecutionVersion:1}}).components.ptyHolder,undefined);
 assert.equal(resolve({root:moved,profile:{artExecutionVersion:1}}).components.hwuiLibrary,undefined);
 fs.writeFileSync(path.join(moved,'art/runtime.json'),JSON.stringify(actual.manifest));
 const outside=path.join(root,'outside');fs.writeFileSync(outside,'other');fs.rmSync(actual.components.linuxRun);fs.symlinkSync(outside,actual.components.linuxRun);
 assert.throws(()=>resolve({root:moved,profile:{artExecutionVersion:1}}),/outside its installed runtime/);
});
test('ART image identity includes all bytes, links, paths and modes',async t=>{
 const root=fixture(t),image=path.join(root,'image');fs.mkdirSync(image);fs.mkdirSync(path.join(image,'empty'));
 fs.writeFileSync(path.join(image,'data'),'one');fs.symlinkSync('data',path.join(image,'alias'));
 const {imageContentIdentity}=await import('../src/modules/android/art/build.mjs');
 const base=imageContentIdentity(image);assert.equal(base.records,4);assert.equal(base.bytes,3);
 assert.deepEqual(imageContentIdentity(image),base);
 fs.writeFileSync(path.join(image,'data'),'two');assert.notEqual(imageContentIdentity(image).sha256,base.sha256);fs.writeFileSync(path.join(image,'data'),'one');
 fs.chmodSync(path.join(image,'data'),0o600);const privateMode=imageContentIdentity(image);fs.chmodSync(path.join(image,'data'),0o644);assert.notEqual(imageContentIdentity(image).sha256,privateMode.sha256);
 fs.chmodSync(path.join(image,'empty'),0o700);const directoryMode=imageContentIdentity(image);fs.chmodSync(path.join(image,'empty'),0o755);assert.notEqual(imageContentIdentity(image).sha256,directoryMode.sha256);
 fs.unlinkSync(path.join(image,'alias'));fs.symlinkSync('empty',path.join(image,'alias'));assert.notEqual(imageContentIdentity(image).sha256,base.sha256);
 fs.renameSync(path.join(image,'data'),path.join(image,'renamed'));assert.notEqual(imageContentIdentity(image).sha256,base.sha256);
});
test('ART guest command preserves original DEX VM and inherited process authority',async()=>{
 const {guestArguments,environment}=await import('../src/modules/android/art/layout.mjs');
 const supplier={manifest:{},components:{hostLibrary:'/runtime/art/host/native.dylib'},guestEntry:'/system/bin/app_process64',entry:'maclauncher.android.Art',bootClasspath:['/apex/com.android.art/javalib/core-oj.jar']};
 const options={supplier,binderName:'private.binder',pathMap:'/private/app/path-map',cache:'/private/app/cache',uid:10041,packageName:'org.example.game',processName:'org.example.game:worker',config:'/data/local/tmp/launch.json',graphics:'/runtime/native/angle',display:'/private/app/display.sock',byPid:'/private/app/by-pid',stdio:['ignore','ignore','pipe','pipe','ignore','pipe',42,43]};
 const args=guestArguments(options),identity=args[args.indexOf('--identity-text')+1];
 assert.match(identity,/uid\t10041\n/);assert.match(identity,/cap_effective\t0\n/);assert.equal(args[args.indexOf('--guest-fds')+1],'0,1,2,3,5,6,7');
 const detached=guestArguments({...options,stdio:['ignore','ignore','pipe','ignore','ignore','pipe','ignore',43]});assert.equal(detached[detached.indexOf('--guest-fds')+1],'0,1,2,5,7','service and disabled external-link channels publish only supplied descriptors');
 assert.ok(args.includes('/system/bin/app_process64'));assert.equal(args.at(-1),options.config);assert.ok(!args.some(value=>value.includes('converted.jar')));
 assert.ok(args.includes('-Ximage:/nonexistent/boot.art'));
 const imaged=guestArguments({...options,supplier:{...supplier,components:{...supplier.components,bootImage:'/runtime/art/boot-image'},manifest:{bootImage:{location:'/system/framework/boot.art'}}}});
 assert.ok(imaged.includes('-Ximage:/system/framework/boot.art'));assert.ok(!imaged.includes('-Ximage:/nonexistent/boot.art'));
 assert.ok(!args.some(value=>value.includes('NativeBridge')||value==='-Xforce-nb-testing'));
 const translated=guestArguments({...options,nativeAbi:'armeabi-v7a',supplier:{...supplier,components:{...supplier.components,nativeBridge:'/runtime/art/guest/libandroid-native-bridge.so'}}});
 assert.ok(translated.includes('-XX:NativeBridge=libandroid-native-bridge.so'));
 assert.ok(translated.includes('-Xforce-nb-testing'));
 assert.ok(translated.includes('/system/bin/app_process64'),'The executing ART and original Bionic runtime retain their actual width');
 assert.throws(()=>guestArguments({...options,nativeAbi:'armeabi-v7a'}),/does not include native translation/);
 assert.equal(environment(supplier).BOOTCLASSPATH,'/apex/com.android.art/javalib/core-oj.jar:/system/framework/services.jar:/system/framework/maclauncher.jar');
 assert.throws(()=>guestArguments({...options,uid:0}),/installed Android application identity/);
 // Resource initialization starts with only its bounded startup authority; the original application uid is not claimed early.
 const preinit=guestArguments({...options,supplier:{...supplier,manifest:{frameworkResourcePreinitVersion:1}}}),startup=preinit[preinit.indexOf('--identity-text')+1];
 assert.match(startup,/uid\t0\n/);assert.match(startup,/cap_effective\t450\n/);
 assert.throws(()=>guestArguments({...options,supplier:{...supplier,manifest:{frameworkResourcePreinitVersion:2}}}),/Unsupported Android resource initialization version/);
});
test('ART installed sources preserve canonical config and asset-pack split identities',async()=>{
 const {guestPackageSources}=await import('../src/modules/android/art/layout.mjs');
 assert.deepEqual(guestPackageSources('org.example.game',[
  '/private/prepared/base.apk','/private/prepared/split_config.arm64_v8a.apk',
  '/private/prepared/split_InstallPack.apk','/private/prepared/split_config.en.apk'
 ]),[
  '/data/app/org.example.game/base.apk','/data/app/org.example.game/split_config.arm64_v8a.apk',
  '/data/app/org.example.game/split_InstallPack.apk','/data/app/org.example.game/split_config.en.apk'
 ]);
 assert.deepEqual(guestPackageSources('org.example.single',['/private/input/game.apk']),['/data/app/org.example.single/base.apk']);
});
test('ART Rust projection preserves the resolved original lock and unchanged source mtimes',async t=>{
 const root=fixture(t),aim=path.join(root,'upstream'),output=path.join(root,'projection');fs.mkdirSync(aim);fs.writeFileSync(path.join(aim,'Cargo.lock'),'upstream v1\n');
 const {prepareHostSource}=await import('../src/modules/android/art/source.mjs');prepareHostSource({aim,output});
 const source=path.join(output,'src/bootstrap.rs'),before=fs.statSync(source,{bigint:true}).mtimeNs;
 fs.writeFileSync(path.join(output,'Cargo.lock'),'resolved original v1 plus owned crate\n');prepareHostSource({aim,output});
 assert.equal(fs.statSync(source,{bigint:true}).mtimeNs,before);assert.equal(fs.readFileSync(path.join(output,'Cargo.lock'),'utf8'),'resolved original v1 plus owned crate\n');
 fs.writeFileSync(path.join(aim,'Cargo.lock'),'upstream v2\n');prepareHostSource({aim,output});assert.equal(fs.readFileSync(path.join(output,'Cargo.lock'),'utf8'),'upstream v2\n');
});
test('ART pinned overlay includes its complete RGBX sources inside another Git checkout',{skip:!process.env.ANDROID_AIM_SOURCE||!process.env.KLEPTON_SOURCE},async t=>{
 const root=fixture(t),{execFileSync}=require('node:child_process');
 execFileSync('git',['init','--quiet',root]);
 const {prepareAimSource}=await import('../src/modules/android/art/source.mjs');
 const output=path.join(root,'build','upstream');
 prepareAimSource({source:path.resolve(process.env.ANDROID_AIM_SOURCE),output,klepton:path.resolve(process.env.KLEPTON_SOURCE),glesHeaders:process.env.ANDROID_GLES_HEADERS&&path.resolve(process.env.ANDROID_GLES_HEADERS)});
 assert.match(fs.readFileSync(path.join(output,'crates/aim-host-gpu/src/opaque.rs'),'utf8'),/pub fn create\(/);
 assert.match(fs.readFileSync(path.join(output,'hal/gles/src/configs.rs'),'utf8'),/pub unsafe fn query\(/);
 assert.match(fs.readFileSync(path.join(output,'crates/aim-host-gpu/src/lib.rs'),'utf8'),/mod opaque;/);
 assert.match(fs.readFileSync(path.join(output,'crates/aim-binder-host/src/socket_scm.rs'),'utf8'),/unixsock::bind_at\(&directory/);
 assert.match(fs.readFileSync(path.join(output,'crates/aim-linux-abi/src/sys/net/socket_scm.rs'),'utf8'),/super::Target::UnixAt/);
 assert.match(fs.readFileSync(path.join(output,'crates/aim-linux-abi/src/hostcall.rs'),'utf8'),/call\(0x10000 \+ func/);
 const wire=fs.readFileSync(path.join(output,'crates/aim-host-display/src/wire.rs'),'utf8');
 const operations=[...wire.matchAll(/pub const OP_\w+: u32 = (0x[0-9a-f]+|\d+);/g)].map(match=>Number(match[1]));
 assert.equal(new Set(operations).size,operations.length,'Owned display operations retain distinct upstream wire identities');
 assert.equal(fs.existsSync(path.join(root,'crates')),false);
});
test('ART app and provider mappings preserve the live native session',async t=>{
 const root=fs.realpathSync(fixture(t)),linker=path.join(root,'ld.config.txt');fs.writeFileSync(linker,'original generated namespaces');
 const {applicationLayout,publishPathMap}=await import('../src/modules/android/art/layout.mjs');
 const rows=['app','provider'].map(name=>applicationLayout({packageName:'org.example.'+name,dataRoot:path.join(root,name),sourceApks:[path.join(root,name,'base.apk')],nativeRoot:path.join(root,name,'lib')}));
 assert.equal(fs.readFileSync(linker,'utf8'),'original generated namespaces');
 assert.match(rows[0],/rw\t\/data\/user\/0\/org.example.app\t/);
 assert.match(rows[1],/ro\t\/data\/app\/org.example.provider\/base.apk\t/);
 assert.ok(rows.every(row=>!row.includes('/linkerconfig')&&!row.includes('/dev/')));
 const maps=rows.map((row,index)=>publishPathMap(root,'process-'+index,row));
 assert.ok(maps.every(file=>path.dirname(file)===root),'Transferred descriptors use the same native metadata owner');
 assert.notEqual(maps[0],maps[1]);
 maps.forEach((file,index)=>assert.equal(fs.readFileSync(file,'utf8'),rows[index]));
 const {guestNativeLibraryDirectory}=await import('../src/modules/android/art/layout.mjs');
 const translated=applicationLayout({packageName:'org.example.arm',dataRoot:path.join(root,'arm'),sourceApks:[path.join(root,'arm/base.apk')],nativeRoot:path.join(root,'arm/lib/armeabi-v7a'),nativeAbi:'armeabi-v7a'});
 assert.ok(translated.includes('ro\t/data/app/org.example.arm/lib/arm\t'+path.join(root,'arm/lib/armeabi-v7a')+'\n'));
 assert.ok(!translated.includes('/lib/arm64\t'));
 assert.equal(guestNativeLibraryDirectory('org.example.arm','armeabi'),'/data/app/org.example.arm/lib/arm');
 assert.equal(guestNativeLibraryDirectory('org.example.app','arm64-v8a'),'/data/app/org.example.app/lib/arm64');
});
test('original ART app enrollment preserves the native linker namespace owner',async t=>{
 const payload=process.env.ANDROID_ART_PAYLOAD,runner=process.env.ANDROID_ART_LINUX_RUN;
 if(process.platform!=='darwin'||!payload||!runner)return t.skip('Requires the matched ART payload and Linux runner');
 const {execFileSync}=require('node:child_process'),supplier=resolve({root:payload,profile:{artExecutionVersion:1}});
 const root=fixture(t),data=path.join(root,'app'),state=path.join(root,'session/native');fs.mkdirSync(state,{recursive:true});fs.mkdirSync(data);
 const retained=path.join(data,'files/retained-path'),sibling=path.join(root,'sibling/private');
 fs.mkdirSync(path.dirname(retained),{recursive:true});fs.writeFileSync(retained,'same private file');
 fs.mkdirSync(path.dirname(sibling),{recursive:true});fs.writeFileSync(sibling,'unrelated app');
 const {applicationLayout,layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const application=applicationLayout({packageName:'org.example.ownership',dataRoot:data,sourceApks:[path.join(root,'base.apk')],nativeRoot:path.join(root,'lib/arm64')});
 // Normal launch keeps host session state beside application data. App data
 // is enrolled first, then the native session creates its root-owned services.
 execFileSync(supplier.components.bootstrap,['initialize','10001',data]);
 const map=publishPathMap(state,'ownership',prepareMountParents(layout({supplier,state})+application,path.join(root,'parents')));
 const env={...environment(supplier),TMPDIR:root},base=['--inherit-env','--path-map',map,'--no-cache','--identity-text','service\tlinkerconfig\nuid\t0\ngid\t0\ngroups\t0\ncap_effective\t8388608\ncap_permitted\t8388608\ncap_bounding\t8388608\nseclabel\tu:r:init:s0\n'];
 const invoke=args=>execFileSync(runner,[...base,...args],{env,encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});
 assert.equal(invoke(['/system/bin/toybox','stat','-c','%u','/data/user/0/org.example.ownership','/linkerconfig']).trim(),'10001\n0');
 for(const file of [retained,'/data/user/0/org.example.ownership/files/retained-path'])assert.equal(invoke(['/system/bin/toybox','cat',file]),'same private file');
 assert.throws(()=>invoke(['/system/bin/toybox','cat',sibling]),/No such file|Permission denied/,'Mapping an app data directory must not expose its host siblings');
 invoke(['/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig']);
 assert.ok(fs.statSync(path.join(state,'run/linkerconfig/ld.config.txt')).size>0);
});
test('ART mount ancestors expose exact inputs without exposing private host siblings',async t=>{
 const root=fixture(t),image=path.join(root,'image'),host=path.join(root,'host'),state=path.join(root,'state');
 fs.mkdirSync(path.join(image,'system/lib64'),{recursive:true});fs.mkdirSync(host);fs.writeFileSync(path.join(host,'allowed'),'input');fs.writeFileSync(path.join(host,'private'),'unrelated');
 const {prepareMountParents}=await import('../src/modules/android/art/layout.mjs');
 const original='root\t/\t'+image+'\nro\t/system/lib64/owned/library.so\t'+path.join(host,'allowed')+'\nrw\t/private/tmp/service/binder\t'+path.join(host,'allowed')+'\n';
 const actual=prepareMountParents(original,state);assert.ok(actual.startsWith(original));
 const rows=actual.trim().split('\n').map(line=>line.split('\t'));
 const parent=rows.find(row=>row[1]==='/private/tmp/service');assert.ok(parent);assert.equal(parent[0],'ro');
 assert.deepEqual(fs.readdirSync(parent[2]),[]);assert.ok(parent[2].startsWith(state+path.sep));
 assert.equal(rows.some(row=>row[1]==='/system/lib64'),false,'Original directories retain their original owner');
 assert.equal(fs.existsSync(path.join(image,'system/lib64/owned')),false,'The pinned image stays unchanged');
});
test('original Bionic realpath retains each opened mount across descriptor lifetime',async t=>{
 const payload=process.env.ANDROID_ART_PAYLOAD,runner=process.env.ANDROID_ART_LINUX_RUN,clang=process.env.ANDROID_CLANG;
 if(process.platform!=='darwin'||!payload||!runner||!clang)return t.skip('Requires matched ART payload, Linux runner and Android Clang');
 const {execFileSync}=require('node:child_process'),supplier=resolve({root:payload,profile:{artExecutionVersion:1}});
 const root=fixture(t),data=path.join(root,'app'),state=path.join(data,'cache/art/native'),executable=path.join(root,'storage-proof');
 for(const folder of [state,path.join(data,'files')])fs.mkdirSync(folder,{recursive:true});
 execFileSync(clang,['--target=aarch64-linux-android35','tests/fixtures/android-art-storage/probe.c','-o',executable],{stdio:'pipe'});
 const {applicationLayout,layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const aliases=applicationLayout({packageName:'org.example.storage',dataRoot:data,sourceApks:[path.join(root,'base.apk')],nativeRoot:path.join(root,'lib')});
 execFileSync(supplier.components.bootstrap,['initialize','10001',data]);
 const map=publishPathMap(state,'storage',prepareMountParents(layout({supplier,state})+aliases+'ro\t/system/bin/storage-proof\t'+executable+'\n',path.join(root,'parents')));
 const output=execFileSync(runner,['--inherit-env','--path-map',map,'--no-cache','--identity-text','service\tstorage\nuid\t10001\ngid\t10001\ncap_effective\t0\ncap_permitted\t0\ncap_bounding\t0\n','/system/bin/storage-proof'],{env:{...environment(supplier),TMPDIR:root},encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 assert.match(output,/PASS exec opened namespace/);assert.match(output,/PASS original Bionic aliases, descriptor duplication, relative open, rename, fork and exec/);
});
test('original Bionic image names survive shared hardlink and translated-cache inodes',async t=>{
 const payload=process.env.ANDROID_ART_PAYLOAD,runner=process.env.ANDROID_ART_LINUX_RUN,translator=process.env.ANDROID_ART_LINUX_TRANSLATE,clang=process.env.ANDROID_CLANG;
 if(process.platform!=='darwin'||!payload||!runner||!translator||!clang)return t.skip('Requires matched ART payload, Linux tools and Android Clang');
 const {execFileSync}=require('node:child_process'),supplier=resolve({root:payload,profile:{artExecutionVersion:1}});
 const root=fixture(t,root=>{
  // AIM publishes read-only cache directories. Retire only this fixture's
  // private cache after its native processes have exited.
  const writable=directory=>{if(!fs.existsSync(directory))return;fs.chmodSync(directory,0o700);for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory())writable(path.join(directory,entry.name));};
  writable(path.join(root,'cache'));
 }),state=path.join(root,'session/native'),executable=path.join(root,'image-origins'),sources=path.join(root,'sources'),cache=path.join(root,'cache');
 fs.mkdirSync(state,{recursive:true});for(const name of ['system','apex'])fs.mkdirSync(path.join(sources,name),{recursive:true});
 execFileSync(clang,['--target=aarch64-linux-android35','tests/fixtures/android-art-storage/image-origins.c','-o',executable],{stdio:'pipe'});
 const library=path.join(sources,'system/libsame.so');
 execFileSync(clang,['--target=aarch64-linux-android35','-shared','-nostdlib','tests/fixtures/android-art-storage/image-library.S','-o',library],{stdio:'pipe'});
 fs.linkSync(library,path.join(sources,'apex/libsame.so'));
 assert.equal(fs.statSync(library).ino,fs.statSync(path.join(sources,'apex/libsame.so')).ino);
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const map=publishPathMap(state,'image-origins',prepareMountParents(layout({supplier,state})+'ro\t/system/bin/image-origins\t'+executable+'\nro\t/usr/share/maclauncher-image-names\t'+sources+'\n',path.join(root,'parents')));
 const base=['--inherit-env','--path-map',map,'--identity-text','service\timage-origins\nuid\t0\ngid\t0\ngroups\t0\ncap_effective\t0\ncap_permitted\t0\ncap_bounding\t0\n'];
 const invoke=options=>execFileSync(runner,[...base,...options,'/system/bin/image-origins'],{env:{...environment(supplier),TMPDIR:root},encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
 assert.match(invoke(['--no-cache']),/PASS original Bionic realpath and descriptor origins for shared immutable image\/cache bytes/);
 execFileSync(translator,['--cache',cache,'--jobs','1',sources],{stdio:'pipe',timeout:30000});
 const translated=fs.readdirSync(cache,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>path.join(cache,entry.name,'meta')).filter(file=>fs.existsSync(file)&&/^outcome=translated$/m.test(fs.readFileSync(file,'utf8')));
 assert.equal(translated.length,1,'Identical original code shares one translated cache entry');
 assert.match(invoke(['--cache',cache]),/PASS immutable image origins survive exec/);
});
test('concurrent ART processes retain their own sandbox and effect staging',async t=>{
 const root=fs.realpathSync(fixture(t)),directory=path.join(root,'session'),runtime=path.join(root,'runtime'),prepared=path.join(root,'prepared'),sharedGraphics=path.join(root,'graphics');
 for(const file of [directory,runtime,prepared,sharedGraphics])fs.mkdirSync(file);
 const effect=path.join(root,'effect.fx');fs.writeFileSync(effect,'// already prepared shader\n');
 const {prepareIsolation}=await import('../src/modules/android/art/isolation.mjs');
 const inputs={supplier:{components:{linuxRun:path.join(runtime,'linux-run'),binder:path.join(runtime,'binder'),bootstrap:path.join(runtime,'bootstrap'),presenter:path.join(runtime,'presenter'),image:runtime}},payload:{root:runtime},directory,prepared:{root:prepared},sharedGraphics,binderName:'fixture.binder',blockNetwork:true,graphics:{RESHADE_PREPARED_EFFECT:effect}};
 const data=[path.join(root,'data-a'),path.join(root,'data-b')];data.forEach(file=>fs.mkdirSync(file));
 const policies=await Promise.all(data.map((dataRoot,index)=>prepareIsolation({...inputs,dataRoot,policyDirectory:path.join(directory,'process-'+index),media:index?{}:{audioInputUid:'selected-mic',cameraInputUid:'selected-camera'}})));
 assert.notEqual(policies[0].prefix[1],policies[1].prefix[1]);assert.notEqual(policies[0].state,policies[1].state);
 for(let index=0;index<2;index++){
  const text=fs.readFileSync(policies[index].prefix[1],'utf8');
  for(const service of require('../src/modules/android/sandbox').webKitMachServices)
   assert.ok(text.includes('(global-name '+JSON.stringify(service)+')'),'Local WebKit service: '+service);
  assert.match(text,/\(deny network\*\)/,'Local WebKit service access retains internet isolation');
  if(index===0)assert.ok(text.includes(require('../src/modules/android/sandbox').captureCapabilities({audioInputUid:'selected-mic',cameraInputUid:'selected-camera'})));
  else assert.doesNotMatch(text,/device-microphone|device-camera/);
  assert.ok(text.includes('(subpath '+JSON.stringify(data[index])+')'));
  assert.ok(!text.includes('(subpath '+JSON.stringify(data[1-index])+')'));
  for(const code of [runtime,prepared])assert.ok(text.includes('(allow process-exec (subpath '+JSON.stringify(code)+'))'));
  for(const files of [data[index],sharedGraphics])assert.ok(!text.includes('(allow process-exec (subpath '+JSON.stringify(files)+'))'));
  assert.equal(fs.readFileSync(path.join(policies[index].state,'prepared.fx'),'utf8'),'// already prepared shader\n');
 }
});

test('ART image composition retains one profile cache across runner updates without granting it to applications',async t=>{
 const root=fs.realpathSync(fixture(t)),profile=path.join(root,'profile'),other=path.join(root,'other-profile');
 fs.mkdirSync(profile);fs.mkdirSync(other);
 const {compositionCache}=await import('../src/modules/android/art/composition-cache.mjs');
 const runners=[path.join(root,'linux-run'),path.join(root,'relocated-linux-run')];
 for(const file of runners)fs.writeFileSync(file,'same original translator');
 const supplier=file=>({components:{linuxRun:file}});
 const first=await compositionCache(profile,supplier(runners[0]));
 assert.equal(await compositionCache(profile,supplier(runners[1])),first,'relocation and unrelated runtime packaging reuse native work');
 assert.notEqual(await compositionCache(other,supplier(runners[0])),first,'profiles retain separate cache roots');
 fs.writeFileSync(runners[1],'changed graphics and thread implementation');
 assert.equal(await compositionCache(profile,supplier(runners[1])),first,'AIM owns entry invalidation; the complete runner is not a translation format');
 fs.unlinkSync(runners[1]);
 assert.equal(await compositionCache(profile,supplier(runners[1])),first,'cache selection does not read the executable');
 const cancelled=new AbortController();cancelled.abort();
 await assert.rejects(compositionCache(profile,supplier(runners[0]),cancelled.signal),{name:'AbortError'});
 assert.equal(fs.statSync(first).mode&0o077,0);

 const directory=path.join(root,'session'),runtime=path.join(root,'runtime'),prepared=path.join(root,'prepared'),sharedGraphics=path.join(root,'graphics'),dataRoot=path.join(root,'data');
 for(const file of [directory,runtime,prepared,sharedGraphics,dataRoot])fs.mkdirSync(file);
 const {prepareIsolation}=await import('../src/modules/android/art/isolation.mjs');
 const inputs={supplier:{components:{linuxRun:'/bin/cat',binder:path.join(runtime,'binder'),bootstrap:path.join(runtime,'bootstrap'),presenter:path.join(runtime,'presenter'),image:runtime}},payload:{root:runtime},directory,dataRoot,prepared:{root:prepared},sharedGraphics,binderName:'fixture.cache',blockNetwork:true};
 const helpers=await prepareIsolation({...inputs,policyDirectory:path.join(directory,'helpers'),compositionCache:first});
 const app=await prepareIsolation({...inputs,policyDirectory:path.join(directory,'app')});
 const helperPolicy=fs.readFileSync(helpers.prefix[1],'utf8'),appPolicy=fs.readFileSync(app.prefix[1],'utf8');
 assert.ok(helperPolicy.includes('(subpath '+JSON.stringify(first)+')'));
 assert.ok(!appPolicy.includes(first),'the application receives no shared-cache filesystem capability');
 if(process.platform==='darwin'){
  const {spawnSync}=require('node:child_process'),marker=path.join(first,'only-native-cache');fs.writeFileSync(marker,'native-only');
  const allowed=spawnSync(helpers.command,[...helpers.prefix,'/bin/cat',marker],{encoding:'utf8'});
  assert.ifError(allowed.error);assert.equal(allowed.status,0,allowed.stderr);assert.equal(allowed.stdout,'native-only');
  const denied=spawnSync(app.command,[...app.prefix,'/bin/cat',marker],{encoding:'utf8'});
  assert.ifError(denied.error);assert.notEqual(denied.status,0);assert.equal(denied.stdout,'');
 }
});

test('ART graphics selection retains Metal defaults and grants only the selected Vulkan closure',async t=>{
 const root=fs.realpathSync(fixture(t)),directory=path.join(root,'session'),runtime=path.join(root,'runtime'),prepared=path.join(root,'prepared'),sharedGraphics=path.join(root,'graphics'),dataRoot=path.join(root,'data'),drivers=path.join(root,'drivers');
 for(const folder of [directory,runtime,prepared,sharedGraphics,dataRoot,drivers])fs.mkdirSync(folder);
 const library=path.join(drivers,'libvulkan.dylib'),driver=path.join(drivers,'driver.dylib'),privateFile=path.join(drivers,'private');
 for(const file of [library,driver,privateFile])fs.writeFileSync(file,path.basename(file));
 const {prepareIsolation}=await import('../src/modules/android/art/isolation.mjs');
 const inputs={supplier:{components:{linuxRun:'/bin/cat',binder:path.join(runtime,'binder'),bootstrap:path.join(runtime,'bootstrap'),presenter:path.join(runtime,'presenter'),image:runtime}},payload:{root:runtime},directory,dataRoot,prepared:{root:prepared},sharedGraphics,binderName:'fixture.graphics',blockNetwork:true};
 const metal=await prepareIsolation({...inputs,policyDirectory:path.join(directory,'metal')});
 assert.equal(metal.environment.KL_ANGLE_BACKEND,'metal');assert.equal(metal.environment.KL_MVK_DYLIB,undefined);
 const processor=path.join(drivers,'core.dylib'),audio=path.join(drivers,'audio.dylib'),resources=path.join(root,'selected-shader');
 fs.writeFileSync(processor,'processor');fs.writeFileSync(audio,'audio');fs.mkdirSync(resources);
 const effect=path.join(resources,'effect.slangp');fs.writeFileSync(effect,'shaders=0');
 const graphics=await prepareIsolation({...inputs,policyDirectory:path.join(directory,'effects'),graphics:{
  DYLD_INSERT_LIBRARIES:processor+':'+audio,RESHADE_EFFECT:effect,RESHADE_RETROARCH_ROOT:resources}});
 assert.equal(graphics.environment.DYLD_INSERT_LIBRARIES,processor+':'+audio);
 const graphicsPolicy=fs.readFileSync(graphics.prefix[1],'utf8');
 for(const file of [processor,audio])assert.ok(graphicsPolicy.includes('(literal '+JSON.stringify(file)+')'));
 assert.ok(graphicsPolicy.includes('(subpath '+JSON.stringify(resources)+')'));
 assert.ok(!graphicsPolicy.includes('(subpath '+JSON.stringify(drivers)+')'));
 assert.ok(graphicsPolicy.includes('(literal "/usr/bin/env")'));
 const vulkan={backend:'kosmickrisp',library,driver,readable:[library,driver]};
 const selected=await prepareIsolation({...inputs,policyDirectory:path.join(directory,'selected'),angleBackend:'vulkan',vulkan});
 assert.equal(selected.environment.KL_ANGLE_BACKEND,'vulkan');assert.equal(selected.environment.KL_MVK_DYLIB,library);
 assert.equal(selected.environment.VK_DRIVER_FILES,selected.environment.VK_ICD_FILENAMES);
 const icd=selected.environment.VK_DRIVER_FILES;assert.ok(icd.startsWith(selected.state+path.sep));
 assert.equal(JSON.parse(fs.readFileSync(icd)).ICD.library_path,driver);
 const policy=fs.readFileSync(selected.prefix[1],'utf8');
 for(const file of vulkan.readable)assert.ok(policy.includes('(literal '+JSON.stringify(file)+')'));
 assert.ok(!policy.includes('(subpath '+JSON.stringify(drivers)+')'));assert.ok(!policy.includes(privateFile));
 if(process.platform==='darwin'){
  const {spawnSync}=require('node:child_process');
  const allowed=spawnSync(selected.command,[...selected.prefix,'/bin/cat',driver],{encoding:'utf8'});
  assert.ifError(allowed.error);assert.equal(allowed.status,0,allowed.stderr);assert.equal(allowed.stdout,path.basename(driver));
  const denied=spawnSync(selected.command,[...selected.prefix,'/bin/cat',privateFile],{encoding:'utf8'});
  assert.ifError(denied.error);assert.notEqual(denied.status,0);assert.equal(denied.stdout,'');
 }
 await assert.rejects(prepareIsolation({...inputs,angleBackend:'vulkan'}),/No Vulkan implementation is installed/);
});
