const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {linkBinary}=require('./helpers/android-arm32-binary');
const {componentSupplier}=require('./helpers/android-art-supplier');
// These component proofs use the pinned ART/libcore image, not application
// framework overlays or unrelated GUI/service supplier components.
function coreSupplier(payload){
 const supplier=componentSupplier(payload);
 supplier.components.frameworkJar=path.join(supplier.components.image,'system/framework/framework.jar');
 return supplier;
}

test('original ART executes the shared ARM32 CPU with guest JNI callbacks and retirement',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_ARM32_CPU_LIBRARY:cpu,ANDROID_CLANG:clang,JAVA_HOME:java,ANDROID_R8:r8}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,cpu,clang,java,r8].every(Boolean))return t.skip('Requires Apple Silicon, the ART payload/runner, shared ARM32 CPU library, Android Clang, Java and R8');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-arm32-'));
 t.after(()=>{const writable=directory=>{fs.chmodSync(directory,0o700);for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory())writable(path.join(directory,entry.name));};writable(root);fs.rmSync(root,{recursive:true,force:true});});
 const fixture=path.join(__dirname,'fixtures/android-art-arm32'),native=path.resolve(__dirname,'../src/modules/android/art/native');
 const run=(program,args,options={})=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024,...options});assert.equal(result.status,0,program+' '+args.join(' ')+'\n'+(result.stdout+result.stderr).slice(-18000)+'\n'+(result.error||result.signal||''));return result.stdout;};
 const host=path.join(root,'host.dylib'),guest=path.join(root,'guest.so'),binary=path.join(root,'guest.bin');
 run('clang',['-c','-fPIC','-I'+native,path.join(fixture,'host.c'),'-o',path.join(root,'host.o')]);
 run('clang++',['-std=c++20','-O2','-dynamiclib','-I'+native,path.join(native,'arm32-host.cpp'),path.join(root,'host.o'),cpu,'-Wl,-rpath,'+path.dirname(cpu),'-o',host]);
 run(clang,['--target=aarch64-linux-android35','-shared','-fPIC','-O2','-I'+native,path.join(fixture,'guest-jni.c'),'-o',guest]);
 run(clang,['--target=armv7a-linux-androideabi21','-mthumb','-mfloat-abi=softfp','-ffreestanding','-fPIC','-O2','-c',path.join(fixture,'guest.c'),'-o',path.join(root,'guest.o')]);
 linkBinary(run,path.join(path.dirname(clang),'ld.lld'),[path.join(root,'guest.o')],['wide','callback'],[],binary);
 const classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 run(path.join(java,'bin/javac'),['--release','8','-d',classes,path.join(fixture,'ArtArm32Probe.java')]);
 run(path.join(java,'bin/jar'),['cf',path.join(root,'probe.jar'),'-C',classes,'.']);
 run(path.join(java,'bin/java'),['-cp',r8,'com.android.tools.r8.D8','--min-api','35','--output',dex,path.join(root,'probe.jar')]);
 fs.copyFileSync(path.join(dex,'classes.dex'),path.join(root,'probe.dex'));
 const supplier=coreSupplier(payload),{layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'cpu-proof',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/fixture\t'+root+'\n',path.join(root,'mounts')));
 for(const child of ['dev/__properties__','dev/socket','dev/pts'])fs.mkdirSync(path.join(state,'run',child),{recursive:true});
 const base=['--inherit-env','--path-map',map,'--cache',path.join(root,'cache'),'--host-module',host];
 const env=environment(supplier);delete env.CLASSPATH;
 const boot=[...['core-oj','core-libart','okhttp','bouncycastle','apache-xml'].map(name=>'/apex/com.android.art/javalib/'+name+'.jar'),'/apex/com.android.i18n/javalib/core-icu4j.jar'].join(':');env.BOOTCLASSPATH=boot;
 run(runner,[...base,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
 const output=run(runner,[...base,'/apex/com.android.art/bin/dalvikvm64','-Xbootclasspath:'+boot,'-Xbootclasspath-locations:'+boot,'-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','-cp','/data/local/tmp/fixture/probe.dex','ArtArm32Probe','/data/local/tmp/fixture/guest.so','/data/local/tmp/fixture/guest.bin'],{env});
 assert.match(output,/PASS original ART \+ shared ARM32 CPU: wide arguments, JNI callback, GC, exception, thread retirement/);
});

test('original ART NativeBridge metadata drives the same ARM32 JNI and ELF owners',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_ARM32_CPU_LIBRARY:cpu,ANDROID_CLANG:clang,JAVA_HOME:java,ANDROID_R8:r8,ANDROID_ART_SOURCE:art,ANDROID_ART_FFI:ffi,ANDROID_NINJA:ninja,ANDROID_PYTHON:python}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,cpu,clang,java,r8,art,ffi,ninja,python].every(Boolean))return t.skip('Requires the original ART image/source, shared CPU, Android compiler/libffi, Java, R8, Ninja and Python');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-jni-'));
 t.after(()=>{const writable=directory=>{fs.chmodSync(directory,0o700);for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory())writable(path.join(directory,entry.name));};writable(root);fs.rmSync(root,{recursive:true,force:true});});
 const fixture=path.join(__dirname,'fixtures/android-art-arm32'),native=path.resolve(__dirname,'../src/modules/android/art/native'),shared=path.resolve(native,'../../native/arm32');
 const run=(program,args,options={})=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024,...options});assert.equal(result.status,0,program+' '+args.join(' ')+'\n'+(result.stdout+result.stderr).slice(-18000)+'\n'+(result.error||result.signal||''));return result.stdout;};
 const supplier=coreSupplier(payload),image=supplier.components.image;
 const host=path.join(root,'host.dylib'),guest=path.join(root,'libsharedjni.so'),binary=path.join(root,'liboriginal32.so');
 run('clang',['-c','-fPIC','-I'+native,path.join(fixture,'host.c'),'-o',path.join(root,'host.o')]);
 run('clang++',['-std=c++20','-O2','-dynamiclib','-I'+native,path.join(native,'arm32-host.cpp'),path.join(root,'host.o'),cpu,'-Wl,-rpath,'+path.dirname(cpu),'-o',host]);
 const {generateJni}=await import('../src/modules/android/native/arm32/jni-generate.mjs');
 const bin=path.dirname(clang),ndk=path.resolve(bin,'../../../../..');
 const {buildArtArm32Jni}=await import('../src/modules/android/art/build-arm32.mjs');
 const adapter=await buildArtArm32Jni({output:path.join(root,'jni-supplier'),ndk,ffi:{include:path.join(ffi,'include'),archive:path.join(ffi,'lib/libffi.a')},ninja,python});
 run(clang,['--target=armv7a-linux-androideabi21','-mthumb','-mfloat-abi=softfp','-ffreestanding','-fno-builtin','-fPIC','-O2','-shared','-nostdlib','-Wl,--no-undefined','-Wl,--hash-style=both',path.join(fixture,'shared-jni-guest.c'),'-o',binary]);
 run(path.join(bin,'clang++'),['--target=aarch64-linux-android35','-std=c++20','-shared','-fPIC','-O2','-g',...adapter.linkFlags,'-I'+native,'-I'+shared,'-I'+path.join(art,'libnativebridge/include'),path.join(fixture,'shared-jni.cpp'),adapter.archive,...adapter.dependencies,'-Wl,--no-undefined','-Wl,-soname,libsharedjni.so','-o',guest]);
 const classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 run(path.join(java,'bin/javac'),['--release','8','-d',classes,path.join(fixture,'ArtSharedJniProbe.java')]);
 run(path.join(java,'bin/jar'),['cf',path.join(root,'probe.jar'),'-C',classes,'.']);
 run(path.join(java,'bin/java'),['-cp',r8,'com.android.tools.r8.D8','--min-api','35','--output',dex,path.join(root,'probe.jar')]);
 fs.copyFileSync(path.join(dex,'classes.dex'),path.join(root,'probe.dex'));
 const jvmGenerated=path.join(root,'jvm-generated');generateJni({jdk:java,output:jvmGenerated});
 const jvmLibrary=path.join(root,'libsharedjni.dylib');
 run('clang++',['-std=c++20','-O2','-dynamiclib','-I'+shared,'-I'+jvmGenerated,'-I'+path.join(java,'include'),'-I'+path.join(java,'include/darwin'),path.join(shared,'jni-bridge.cpp'),path.join(fixture,'shared-jni.cpp'),cpu,'-lffi','-Wl,-rpath,'+path.dirname(cpu),'-o',jvmLibrary]);
 assert.match(run(path.join(java,'bin/java'),['-Xcheck:jni','-cp',classes,'ArtSharedJniProbe',jvmLibrary,binary]),/PASS shared ARM32 JNI/);
 t.diagnostic('The same source and ARM32 ELF passed the original JVM JNI/metadata path');
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const publicLibraries=path.join(root,'public.libraries.txt');
 fs.writeFileSync(publicLibraries,fs.readFileSync(path.join(image,'system/etc/public.libraries.txt'),'utf8')+'\nlibsharedjni.so\n');
 const map=publishPathMap(state,'jni-proof',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/fixture\t'+root+'\nro\t/system/lib64/libsharedjni.so\t'+guest+'\nro\t/system/etc/public.libraries.txt\t'+publicLibraries+'\n',path.join(root,'mounts')));
 for(const child of ['dev/__properties__','dev/socket','dev/pts'])fs.mkdirSync(path.join(state,'run',child),{recursive:true});
 const base=['--inherit-env','--path-map',map,'--cache',path.join(root,'cache'),'--host-module',host];
 const env=environment(supplier);delete env.CLASSPATH;env.LD_LIBRARY_PATH='/data/local/tmp/fixture';
 const boot=[...['core-oj','core-libart','okhttp','bouncycastle','apache-xml'].map(name=>'/apex/com.android.art/javalib/'+name+'.jar'),'/apex/com.android.i18n/javalib/core-icu4j.jar'].join(':');env.BOOTCLASSPATH=boot;
 run(runner,[...base,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
 const output=run(runner,[...base,'/apex/com.android.art/bin/dalvikvm64','-XX:NativeBridge=libsharedjni.so','-Xforce-nb-testing','-Xbootclasspath:'+boot,'-Xbootclasspath-locations:'+boot,'-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','-cp','/data/local/tmp/fixture/probe.dex','ArtSharedJniProbe','/system/lib64/libsharedjni.so','/data/local/tmp/fixture/liboriginal32.so'],{env});
 assert.match(output,/PASS shared ARM32 JNI, ELF, references, A\/V calls, closures, GC, exceptions and thread retirement: Dalvik/);
});

test('shared ARM32 native imports call the original Bionic implementation',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_ARM32_CPU_LIBRARY:cpu,ANDROID_CLANG:clang,ANDROID_ART_ARM32_NATIVE:archive,ANDROID_ART_FFI:ffi}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,cpu,clang,archive,ffi].every(Boolean))return t.skip('Requires the original image, ARM32 CPU/native adapter, Android compiler and libffi');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-imports-'));
 t.after(()=>{const writable=directory=>{fs.chmodSync(directory,0o700);for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory())writable(path.join(directory,entry.name));};writable(root);fs.rmSync(root,{recursive:true,force:true});});
 const fixture=path.join(__dirname,'fixtures/android-art-arm32'),native=path.resolve(__dirname,'../src/modules/android/art/native'),shared=path.resolve(native,'../../native/arm32');
 const run=(program,args,options={})=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024,...options});assert.equal(result.status,0,program+' '+args.join(' ')+'\n'+(result.stdout+result.stderr).slice(-18000)+'\n'+(result.error||result.signal||''));return result.stdout;};
 const host=path.join(root,'host.dylib'),guest=path.join(root,'imports'),binary=path.join(root,'liboriginal32.so');
 run('clang',['-c','-fPIC','-I'+native,path.join(fixture,'host.c'),'-o',path.join(root,'host.o')]);
 run('clang++',['-std=c++20','-O2','-dynamiclib','-I'+native,path.join(native,'arm32-host.cpp'),path.join(root,'host.o'),cpu,'-Wl,-rpath,'+path.dirname(cpu),'-o',host]);
 run(clang,['--target=armv7a-linux-androideabi21','-mthumb','-mfloat-abi=softfp','-fPIC','-fno-builtin','-O2','-shared','-nostdlib','-Wl,--hash-style=both',path.join(fixture,'imports-guest.c'),'-o',binary]);
 const groupA=path.join(root,'libgroup-a.so'),groupB=path.join(root,'libgroup-b.so');
 const groupFlags=['--target=armv7a-linux-androideabi21','-mthumb','-mfloat-abi=softfp','-fPIC','-O2','-shared','-nostdlib','-Wl,--hash-style=both'];
 run(clang,[...groupFlags,path.join(fixture,'group-b.c'),'-Wl,-soname,libgroup-b.so','-o',groupB]);
 run(clang,[...groupFlags,path.join(fixture,'group-a.c'),groupB,'-Wl,-soname,libgroup-a.so','-o',groupA]);
 run(clang,[...groupFlags,path.join(fixture,'group-b.c'),groupA,'-Wl,-soname,libgroup-b.so','-o',groupB]);
 const registry=path.join(root,'registry.o');
 run(clang,['--target=aarch64-linux-android35','-std=c11','-O2','-fPIC','-c',path.join(shared,'../library-registry.c'),'-o',registry]);
 run(path.join(path.dirname(clang),'clang++'),['--target=aarch64-linux-android35','-std=c++20','-O2','-g','-static-libstdc++','-I'+shared,path.join(fixture,'imports.cpp'),path.join(shared,'../library-group.cpp'),registry,archive,path.join(ffi,'lib/libffi.a'),'-Wl,--no-undefined','-o',guest]);
 const supplier=coreSupplier(payload),{layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'imports-proof',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/fixture\t'+root+'\n',path.join(root,'mounts')));
 const base=['--inherit-env','--path-map',map,'--cache',path.join(root,'cache'),'--host-module',host];
 const env=environment(supplier);delete env.CLASSPATH;
 const output=run(runner,[...base,'/data/local/tmp/fixture/imports','/data/local/tmp/fixture/liboriginal32.so','/data/local/tmp/fixture/libgroup-a.so','/data/local/tmp/fixture/libgroup-b.so'],{env});
 assert.match(output,/PASS shared ARM32 imports into original Bionic/);
  assert.match(output,/PASS shared argument span: calls=20000 words=9/);
  t.diagnostic(output.split('\n').find(line=>line.includes('PASS shared argument span')));
 assert.match(output,/PASS shared ARM32 cyclic ELF group/);
});

test('original ART System.load uses the shared production NativeBridge loader',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_ARM32_CPU_LIBRARY:cpu,ANDROID_CLANG:clang,JAVA_HOME:java,ANDROID_R8:r8,ANDROID_ART_NATIVE_BRIDGE:bridge,ANDROID_ARM32_BUILTINS:builtins,ANDROID_WILHELM_SOURCE:wilhelm}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,cpu,clang,java,r8,bridge,builtins,wilhelm].every(Boolean))return t.skip('Requires the original image, shared CPU/NativeBridge, original OpenSL source, Android compiler, Java and R8');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-nativebridge-'));
 t.after(()=>{const writable=directory=>{fs.chmodSync(directory,0o700);for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory())writable(path.join(directory,entry.name));};writable(root);fs.rmSync(root,{recursive:true,force:true});});
 const fixture=path.join(__dirname,'fixtures/android-art-arm32'),native=path.resolve(__dirname,'../src/modules/android/art/native');
 const run=(program,args,options={})=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024,...options});assert.equal(result.status,0,program+' '+args.join(' ')+'\n'+(result.stdout+result.stderr).slice(-18000)+'\n'+(result.error||result.signal||'')+'\n'+(fs.existsSync(path.join(root,'binder.log'))?fs.readFileSync(path.join(root,'binder.log'),'utf8'):''));return result.stdout+result.stderr;};
 const supplier=coreSupplier(payload),selectedHost=supplier.components.hostLibrary;
 const host=path.join(root,'host.dylib'),binary=path.join(root,'liboriginal32.so');
 run(clang,['--target=aarch64-linux-android35','-O2','-D_GNU_SOURCE','-I'+native,path.join(fixture,'process-identity-probe.c'),'-o',path.join(root,'process-identity')]);
 run('clang',['-c','-fPIC','-DANDROID_IDENTITY_PROOF','-DANDROID_PACKAGED_HOST='+JSON.stringify(selectedHost),'-I'+path.resolve(native,'../../native'),'-I'+native,path.join(fixture,'host.c'),'-o',path.join(root,'host.o')]);
 const shared=path.resolve(native,'../../native'),identities=['process-ids.c','thread-identity.c'].map(file=>{
  const object=path.join(root,file+'.o');run('clang',['-std=c11','-O2','-fPIC','-I'+shared,'-c',path.join(shared,file),'-o',object]);return object;
 });
 // Keep the existing identity assertion at entry, while the selected host
 // supplies the production dispatcher, scoped packet resolver and ARM32 owner.
 run('clang',['-dynamiclib',path.join(root,'host.o'),selectedHost,'-Wl,-rpath,'+path.dirname(selectedHost),'-o',host]);
 const peerClient=path.join(root,'transport-peer');run('clang',['-std=c11','-O2','-I'+shared,path.join(fixture,'transport-peer.c'),...identities,'-o',peerClient]);
 const groupA=path.join(root,'libgroup-a.so'),groupB=path.join(root,'libgroup-b.so');
 const flags=['--target=armv7a-linux-androideabi35','-mthumb','-mfloat-abi=softfp','-fPIC','-fno-builtin','-O2','-shared','-nostdlib','-Wl,--hash-style=both'];
 run(clang,[...flags,path.join(fixture,'group-b.c'),'-Wl,-soname,libgroup-b.so','-o',groupB]);
 run(clang,[...flags,path.join(fixture,'group-a.c'),groupB,'-Wl,-soname,libgroup-a.so','-o',groupA]);
 run(clang,[...flags,path.join(fixture,'group-b.c'),groupA,'-Wl,-soname,libgroup-b.so','-o',groupB]);
 const late=path.join(root,'liblate.so');
 run(clang,[...flags,path.join(fixture,'group-late.c'),groupA,'-Wl,-soname,liblate.so','-Wl,--no-undefined','-o',late]);
 const interfaceOwner=path.join(root,'libinterface-owner.so');
 const interfaceObjects={};
 const iidSources=['OpenSLES_IID.cpp','sl_iid.cpp','xa_iid.cpp'].map(file=>{
  const target=path.join(root,file),source=fs.readFileSync(path.join(wilhelm,'src',file),'utf8');
  // These constant-only original units need public type declarations, not
  // the service implementation's aggregate private include.
  fs.writeFileSync(target,source.replace('#include "sles_allinclusive.h"','#include <SLES/OpenSLES.h>\n#include <SLES/OpenSLES_Android.h>\n#include <OMXAL/OpenMAXAL.h>\n#include <OMXAL/OpenMAXAL_Android.h>\n#include "MPH.h"\nextern const struct SLInterfaceID_ SL_IID_array[MPH_MAX];'));
  return target;
 });
 for(const abi of ['aarch64-linux-android35','armv7a-linux-androideabi35']){
  interfaceObjects[abi]=iidSources.map(file=>{
   const object=path.join(root,abi+'-'+path.basename(file)+'.o');
   run(path.join(path.dirname(clang),'clang++'),['--target='+abi,'-fPIC','-O2','-DANDROID','-DLI_API=__attribute__((visibility("default")))','-I'+path.join(wilhelm,'src'),'-c',file,'-o',object]);return object;
  });
 }
 const localInterface=(target,abi,id)=>run(clang,['--target='+abi,'-shared','-fPIC','-O2','-DINTERFACE_OWNER='+id,path.join(fixture,'interface-owner.c'),...interfaceObjects[abi],'-Wl,-soname,libinterface-owner.so','-o',target]);
 localInterface(interfaceOwner,'aarch64-linux-android35',1);
 // The translated dependency is resolved by its SONAME to the matching
 // native ELF in the same class-loader namespace, exactly like platform NDKs.
 const interfaceLink=path.join(root,'interface-link.so');
 localInterface(interfaceLink,'armv7a-linux-androideabi35',1);
 run(clang,[...flags,'-DNATIVE_BRIDGE_DEPENDENCIES','-Wl,--no-undefined','-Wl,-rpath,$ORIGIN/plugins',path.join(fixture,'shared-jni-guest.c'),groupA,groupB,interfaceLink,'-lc','-ldl','-lstdc++','-landroid','-o',binary]);
 const classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 run(path.join(java,'bin/javac'),['--release','8','-d',classes,path.join(fixture,'ArtSharedJniProbe.java'),path.join(fixture,'NativeBridgeProbe.java')]);
 run(path.join(java,'bin/jar'),['cf',path.join(root,'probe.jar'),'-C',classes,'.']);
 run(path.join(java,'bin/java'),['-cp',r8,'com.android.tools.r8.D8','--min-api','35','--output',dex,path.join(root,'probe.jar')]);
 fs.copyFileSync(path.join(dex,'classes.dex'),path.join(root,'probe.dex'));
 const contents=path.join(root,'apk'),libraries=path.join(contents,'lib/armeabi-v7a');fs.mkdirSync(libraries,{recursive:true});
 fs.copyFileSync(path.resolve(__dirname,'fixtures/android-framework-services/manifests/window.xml.bin'),path.join(contents,'AndroidManifest.xml'));
 fs.copyFileSync(path.join(dex,'classes.dex'),path.join(contents,'classes.dex'));
 fs.mkdirSync(path.join(contents,'assets/Scenes'),{recursive:true});
 fs.writeFileSync(path.join(contents,'assets/Scenes/mixed-name.scene'),Buffer.from(Array.from({length:8193},(_,i)=>i%251)));
 for(const file of [binary,groupA,groupB])fs.copyFileSync(file,path.join(libraries,path.basename(file)));
 fs.mkdirSync(path.join(libraries,'plugins'));fs.copyFileSync(late,path.join(libraries,'plugins/liblate.so'));
 fs.copyFileSync(interfaceOwner,path.join(libraries,'libinterface-owner.so'));
 const secondLibraries=path.join(root,'second-libraries');fs.cpSync(libraries,secondLibraries,{recursive:true});
 localInterface(path.join(secondLibraries,'libinterface-owner.so'),'aarch64-linux-android35',2);
 run(path.join(java,'bin/jar'),['cf',path.join(root,'application.apk'),'-C',contents,'.']);
 const metadata=require('../src/modules/android/apk').inspectApk(path.join(root,'application.apk'),{requireLauncher:false,nativeArchitectures:['armeabi-v7a']});
 assert.deepEqual(metadata.architectures,['armeabi-v7a']);assert.deepEqual(metadata.limitations,[]);
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 supplier.components.nativeBridge=path.resolve(bridge);supplier.components.arm32Builtins=path.resolve(builtins);
 const state=path.join(root,'state');fs.mkdirSync(state);
 const properties=path.join(root,'properties');run(supplier.components.bootstrap,[supplier.components.image,properties]);
 const map=publishPathMap(state,'nativebridge-proof',prepareMountParents(layout({supplier,state})+'ro\t/dev/__properties__\t'+properties+'\nro\t/data/local/tmp/fixture\t'+root+'\nro\t/system/lib64/libandroid-log-stderr.so\t'+supplier.components.logLibrary+'\n',path.join(root,'mounts')));
 for(const child of ['dev/__properties__','dev/socket','dev/pts'])fs.mkdirSync(path.join(state,'run',child),{recursive:true});
 const binderName='maclauncher.android.nativebridge.'+require('node:crypto').randomUUID();
 const env=environment(supplier);delete env.CLASSPATH;env.LD_LIBRARY_PATH='/system/lib64';
 env.KL_ANDROID_ID_DIRECTORY=path.join(root,'ids');fs.mkdirSync(env.KL_ANDROID_ID_DIRECTORY,{mode:0o700});
 const binderLog=fs.openSync(path.join(root,'binder.log'),'w');
 const binder=require('node:child_process').spawn(process.env.ANDROID_ART_BINDER||supplier.components.binder,[...(process.env.ANDROID_ART_BINDER?['--host-module',host]:[]),'--service',binderName],{env,stdio:['ignore',binderLog,binderLog],detached:true});fs.closeSync(binderLog);
 t.after(async()=>{if(binder.exitCode===null&&binder.signalCode===null){const closed=require('node:events').once(binder,'close');process.kill(-binder.pid,'SIGTERM');await closed;}});
 run(supplier.components.bootstrap,['wait-binder',binderName]);
 const base=['--inherit-env','--binder',binderName,'--path-map',map,'--cache',path.join(root,'cache'),'--host-module',host];
 const boot=[...['core-oj','core-libart','okhttp','bouncycastle','apache-xml'].map(name=>'/apex/com.android.art/javalib/'+name+'.jar'),'/apex/com.android.i18n/javalib/core-icu4j.jar'].join(':');env.BOOTCLASSPATH=boot;
 run(runner,[...base,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
 const identityOutput=run(peerClient,[runner,...base,'/data/local/tmp/fixture/process-identity','3'],{env});
 assert.match(identityOutput,/PASS original process\/thread identity, procfs, fork, zombie observation and wait retirement/);
 assert.match(identityOutput,/PASS incoming kernel credentials retain physical UID and logical Android PID/);
 env.LD_PRELOAD='/system/lib64/libandroid-log-stderr.so';env.CLASSPATH='/data/local/tmp/fixture/probe.dex';env.BOOTCLASSPATH=supplier.bootClasspath.join(':');
 const assetArguments=[];if(process.env.ANDROID_ART_ASSET_APK){fs.copyFileSync(process.env.ANDROID_ART_ASSET_APK,path.join(root,'assets.apk'));assetArguments.push('/data/local/tmp/fixture/assets.apk');}
 const output=run(runner,[...base,'/system/bin/app_process64','-XX:NativeBridge=libandroid-native-bridge.so','-Xforce-nb-testing','-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','/system/bin','NativeBridgeProbe','/data/local/tmp/fixture/application.apk','/data/local/tmp/fixture/apk/lib/armeabi-v7a','original32','/data/local/tmp/fixture/second-libraries',...assetArguments],{env});
 assert.match(output,/PASS original AssetManager ARM32 open\/read\/length\/seek: [1-9]/);
 t.diagnostic(output.split('\n').filter(line=>line.includes('PASS original AssetManager')).join('\n'));
 const physical=output.match(/SHARED_IDENTITY logical=(\d+) physical=(\d+)/),guest=output.match(/ORIGINAL_IDENTITY pid=(\d+) tid=(\d+)/);
 assert.ok(physical&&guest,'Both sides must report actual original identity');assert.equal(guest[1],physical[1]);assert.equal(guest[2],physical[1]);assert.notEqual(physical[1],physical[2]);
 assert.match(output,/PASS original ART System.load, class-loader namespace, JNI_OnLoad and shared ARM32 JNI/);
 assert.match(output,/PASS local original OpenSL interface owner=1/);assert.match(output,/PASS local original OpenSL interface owner=2/);
 assert.match(output,/PASS original tagged OpenSL locator\/format and retained object identity owner=1/);
 assert.match(output,/PASS original tagged OpenSL locator\/format and retained object identity owner=2/);
});
