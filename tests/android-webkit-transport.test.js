const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process'),{once}=require('node:events');

test('both VMs use the shared WebKit JNI family and owner-thread callback transport',async t=>{
 const {JAVA_HOME:jdk,ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:clang,ANDROID_R8:r8}=process.env;
 if(process.platform!=='darwin'||![jdk,payload,runner,clang,r8].every(Boolean))return t.skip('Requires the Mac WebKit owner, original ART supplier/runner, Android Clang, Java and R8');
 const root=fs.mkdtempSync('/private/tmp/ml-webkit-'),native=path.resolve('src/modules/android/native'),art=path.resolve('src/modules/android/art/native'),fixture=path.resolve('tests/fixtures/android-webkit-transport');
 let server;
 t.after(async()=>{if(server){if(server.exitCode==null&&server.signalCode==null){server.kill('SIGTERM');await Promise.race([once(server,'exit'),new Promise(r=>setTimeout(r,2000))]);if(server.exitCode==null&&server.signalCode==null){server.kill('SIGKILL');await once(server,'exit');}}for(const stream of server.stdio)stream?.destroy();}fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 const run=(command,args,options={})=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:90000,maxBuffer:8<<20,...options}),output=(r.stdout||'')+(r.stderr||'');if(r.status!==0)console.error(output.slice(-20000),r.error||r.signal||'');assert.equal(r.status,0,output.slice(-20000)+'\n'+(r.error||r.signal||''));return r.stdout;};
 const {prepareWebkitCallbacks}=await import('../src/modules/android/native/webkit-jni-source.mjs');prepareWebkitCallbacks(root);
 const {prepareNetworkPolicy}=await import('../src/modules/android/native/network-policy-source.mjs');prepareNetworkPolicy(root);
 const includes=['-I'+native,'-I'+root,'-I'+jdk+'/include','-I'+jdk+'/include/darwin'];
 run('clang',['-c','-fblocks',...includes,path.join(native,'network-policy.c'),'-o',path.join(root,'policy.o')]);
 const serverFile=path.join(root,'server');run('clang++',['-O2','-std=c++20','-fobjc-arc','-Wno-deprecated-declarations','-Wno-trigraphs',...includes,path.join(fixture,'server.mm'),path.join(art,'webkit-server.mm'),...['webkit-platform.mm','webkit-binding.mm'].map(f=>path.join(native,f)),path.join(root,'policy.o'),'-framework','AppKit','-framework','WebKit','-framework','UniformTypeIdentifiers','-framework','Carbon','-o',serverFile]);
 const classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 run(path.join(jdk,'bin/javac'),['--release','21','-cp',path.join(payload,'android-framework.jar'),'-d',classes,path.join(fixture,'BrowserTransportProbe.java'),path.join(native,'java/maclauncher/android/FirstFailure.java')]);
 run(path.join(jdk,'bin/jar'),['cf',path.join(root,'probe.jar'),'-C',classes,'.']);
 run(path.join(jdk,'bin/java'),['-cp',r8,'com.android.tools.r8.D8','--min-api','35','--output',dex,path.join(root,'probe.jar')]);
 const callbackHeader=path.join(root,'jni'),headerClasses=path.join(root,'jni-classes');fs.mkdirSync(callbackHeader);fs.mkdirSync(headerClasses);
 run(path.join(jdk,'bin/javac'),['--release','21','-cp',[path.join(payload,'android-host.jar'),path.join(payload,'android-framework.jar')].join(path.delimiter),'-d',headerClasses,'-h',callbackHeader,path.join(native,'java/maclauncher/android/web/WebKitNative.java')]);
 const sources=[path.join(fixture,'client.cpp'),path.join(native,'webkit-jni.cpp'),path.join(art,'webkit-client.cpp')];
 const library=path.join(root,'client.dylib');run('clang++',['-O2','-std=c++20','-dynamiclib',...includes,'-I'+callbackHeader,...sources,'-o',library]);
 const imageRoot=path.join(payload,'art'),manifest=JSON.parse(fs.readFileSync(path.join(imageRoot,'runtime.json'))),components=Object.fromEntries(Object.entries(manifest.components).map(([k,v])=>[k,path.join(imageRoot,v)]));
 // A core-only native/VM proof consumes the matching original image directly;
 // it does not boot an app or substitute any framework class.
 components.frameworkJar??=path.join(components.image,'system/framework/framework.jar');
 const supplier={components,manifest,bootClasspath:manifest.bootClasspath};
 const guest=path.join(root,'client.so'),driver=clang.endsWith('++')?clang:clang+'++';
 const guestInputs=process.env.ANDROID_ART_GUEST_INPUTS?JSON.parse(fs.readFileSync(process.env.ANDROID_ART_GUEST_INPUTS)):{compiler:driver,binderFlags:[],includeDirectories:[],sourceRoot:process.cwd()};
 const platformConfig=path.join(path.dirname(path.dirname(driver)),'sysroot/usr/include/c++/v1/__config_site');
 const guestFlags=[...guestInputs.binderFlags,...guestInputs.includeDirectories.map(file=>'-I'+file),...includes,'-I'+callbackHeader,'-fPIC','-fexceptions','-std=c++20'];
 if(!process.env.ANDROID_ART_GUEST_INPUTS){
  // The NDK headers use a different libc++ namespace from the original image.
  // Retain the supplier configuration, selecting its platform ABI namespace.
  const config=fs.readFileSync(platformConfig,'utf8');assert.match(config,/#define _LIBCPP_ABI_NAMESPACE __ndk1/);
  const header=path.join(root,'platform-libcxx-config.h');fs.writeFileSync(header,config.replace('#define _LIBCPP_ABI_NAMESPACE __ndk1','#define _LIBCPP_ABI_NAMESPACE __1'));
  guestFlags.push('-include',header);
 }
 // Original platform libc++ uses its own ABI namespace. Compile against the
 // exact canonical guest supplier headers/flags, rather than NDK C++ headers.
 const socket=path.join(root,'browser.sock');server=spawn(serverFile,[socket],{stdio:['ignore','pipe','pipe','pipe']});
 let output='';server.stdout.on('data',bytes=>output+=bytes);server.stderr.on('data',bytes=>output+=bytes);
 const end=Date.now()+15000;while(!output.includes('READY')&&Date.now()<end){if(server.exitCode!=null)assert.fail(output);await new Promise(r=>setTimeout(r,10));}assert.match(output,/READY/);
 const data=path.join(root,'data');fs.mkdirSync(data);const registration=Buffer.from(JSON.stringify({token:'fixture-capability',root:data,guest:'/data/user/0/probe',network:false})),frame=Buffer.alloc(4+registration.length);frame.writeUInt32LE(registration.length);registration.copy(frame,4);
 await new Promise((resolve,reject)=>server.stdio[3].write(frame,error=>error?reject(error):resolve()));
 const secondData=path.join(root,'other-data');fs.mkdirSync(secondData);
 const secondRegistration=Buffer.from(JSON.stringify({token:'second-capability',root:secondData,guest:'/data/user/0/other',network:false})),secondFrame=Buffer.alloc(4+secondRegistration.length);secondFrame.writeUInt32LE(secondRegistration.length);secondRegistration.copy(secondFrame,4);
 await new Promise((resolve,reject)=>server.stdio[3].write(secondFrame,error=>error?reject(error):resolve()));
 const queueProbe=path.join(root,'queue-owner');run('clang++',['-O2','-std=c++20',...includes,path.join(fixture,'queue-owner.cpp'),'-o',queueProbe]);
 assert.match(run(queueProbe,[socket]),/PASS asynchronous callback preserves the shared physical queue/);
 const expected=/PASS shared WebKit transport: VM callbacks, Unicode, reentry, resources, dialogs, pixels, cookies, storage and retirement/;
 const hotspot=run(path.join(jdk,'bin/java'),['-Xcheck:jni','-cp',classes,'BrowserTransportProbe',library,socket,'fixture-capability']);assert.match(hotspot,expected);console.log('HotSpot: '+hotspot.match(expected)[0]);
 const guestObjects=sources.map((file,index)=>{const object=path.join(root,'guest-'+index+'.o');run(guestInputs.compiler,[...guestFlags,'-c',file,'-o',object],{cwd:guestInputs.sourceRoot});return object;});
 run(driver,['-shared','-nostdlib++',...guestObjects,'-L'+path.join(components.image,'system/lib64'),'-l:libc++.so','-o',guest]);
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs'),state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'webkit-proof',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/fixture\t'+root+'\n'+'rw\t/dev/socket/browser\t'+socket+'\n',path.join(root,'mounts')));
 for(const directory of ['dev/__properties__','dev/socket','dev/pts'])fs.mkdirSync(path.join(state,'run',directory),{recursive:true});
 const env=environment(supplier);delete env.CLASSPATH;
 const boot=[...['core-oj','core-libart','okhttp','bouncycastle','apache-xml'].map(name=>'/apex/com.android.art/javalib/'+name+'.jar'),'/apex/com.android.i18n/javalib/core-icu4j.jar'].join(':');env.BOOTCLASSPATH=boot;
 const args=['--inherit-env','--path-map',map,'--no-cache'];
 run(runner,[...args,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
 const artOutput=run(runner,[...args,'/apex/com.android.art/bin/dalvikvm64','-Xbootclasspath:'+boot,'-Xbootclasspath-locations:'+boot,'-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','-cp','/data/local/tmp/fixture/dex/classes.dex','BrowserTransportProbe','/data/local/tmp/fixture/client.so','/dev/socket/browser','fixture-capability'],{env});assert.match(artOutput,expected);console.log('ART: '+artOutput.match(expected)[0]);
 // Exercise the original Bionic loader mutex directly. A constructor retires
 // an active reader while dlopen holds the mutex; another exits the process
 // from that constructor, running the real global DSO destructor path.
 const shutdownObjects=['shutdown-client.cpp','shutdown-constructor.cpp','shutdown-main.cpp'].map(file=>{const object=path.join(root,file+'.o');run(guestInputs.compiler,[...guestFlags,'-I'+art,'-c',path.join(fixture,file),'-o',object],{cwd:guestInputs.sourceRoot});return object;});
 const shutdownLibraries=['shutdown-client.so','shutdown-constructor.so'];
 for(let i=0;i<shutdownLibraries.length;i++)run(driver,['-shared','-nostdlib++','-Wl,-z,nodelete',shutdownObjects[i],'-L'+path.join(components.image,'system/lib64'),'-l:libc++.so','-ldl','-o',path.join(root,shutdownLibraries[i])]);
 run(driver,['-nostdlib++',shutdownObjects[2],'-L'+path.join(components.image,'system/lib64'),'-l:libc++.so','-ldl','-o',path.join(root,'shutdown-main')]);
 for(const mode of ['explicit','constructor','exit']){
  const output=run(runner,[...args,'/data/local/tmp/fixture/shutdown-main','/data/local/tmp/fixture/shutdown-client.so','/data/local/tmp/fixture/shutdown-constructor.so','/dev/socket/browser',mode],{env,timeout:10000});
  assert.match(output,mode==='exit'?/PASS original loader constructor reached process exit/:new RegExp('PASS original Bionic WebKit '+mode+': callback owner, worker state and descriptors retired'));console.log(output.trim());
 }
 assert.doesNotMatch(output,/Callback transport:|Invalid browser|Invalid nested/);
});
