const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process'),{once}=require('node:events');
const fixture=path.resolve('tests/fixtures/android-audio'),java=path.resolve('src/modules/android/native/java/maclauncher/android/media');
test('both VM bindings query the executing audio owner for native-only stream activity',async t=>{
 const {KLEPTON_NATIVE_RUNTIME:runtime,JAVA_HOME:jdk,ANDROID_AUDIO_LIBRARY:audio,ANDROID_ART_PLATFORM_LIBRARY:platform,ANDROID_ART_PAYLOAD:payload,ANDROID_ART_GUEST_INPUTS:inputs,ANDROID_R8:r8}=process.env;
 if(process.platform!=='darwin'||![runtime,jdk,audio,platform,payload,inputs,r8].every(Boolean))return t.skip('Requires the complete Android suppliers and changed audio/ART platform components');
 const retained=process.env.ANDROID_AUDIO_TEST_OUTPUT,root=fs.mkdtempSync(path.join(retained?path.resolve(retained):os.tmpdir(),'android-stream-activity-'));
 if(!retained)t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50}));
 const options=JSON.parse(fs.readFileSync(inputs)),run=(program,args,extra={})=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:3<<20,...extra});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout+r.stderr;};
 const cp=['android-host.jar','android-framework.jar'].map(f=>path.resolve(runtime,f)).join(path.delimiter),classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 run(path.join(jdk,'bin/javac'),['--release','21','-cp',cp,'-d',classes,...['HostAudioManager.java','AudioHost.java'].map(f=>path.join(java,f)),path.join(fixture,'StreamActivityProbe.java')]);
 const delivered=path.join(root,'native');fs.mkdirSync(delivered);
 const copy=(source,target)=>fs.copyFileSync(source,target,fs.constants.COPYFILE_FICLONE);
 for(const name of ['libandroid-media.dylib','libandroid-binder-rpc.dylib'])copy(path.resolve(runtime,'native',name),path.join(delivered,name));
 fs.cpSync(path.resolve(runtime,'native/codecs'),path.join(delivered,'codecs'),{recursive:true,mode:fs.constants.COPYFILE_FICLONE});
 const core=path.join(delivered,'libklepton-jvm.dylib'),audioComponent=path.join(delivered,'libklepton-audio.dylib'),helper=path.join(root,'activity.dylib');
 copy(path.resolve(process.env.ANDROID_CORE_LIBRARY||path.join(runtime,'native/libklepton-jvm.dylib')),core);copy(path.resolve(audio),audioComponent);
 run('clang++',['-dynamiclib','-O2','-std=c++17','-I'+path.join(jdk,'include'),'-I'+path.join(jdk,'include/darwin'),'-I'+path.resolve('src/modules/android/native'),path.join(fixture,'StreamActivityProbe.cpp'),core,'-Wl,-rpath,'+path.dirname(core),'-o',helper]);
 const cleanEnv={...process.env};for(const key of Object.keys(cleanEnv))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete cleanEnv[key];
 const jvm=require('./helpers/android-java').spawnSync(path.join(jdk,'bin/java'),['-Xverify:all','-cp',classes+path.delimiter+cp,'maclauncher.android.media.StreamActivityProbe',audioComponent,core,helper],{encoding:'utf8',timeout:30000,maxBuffer:3<<20,env:cleanEnv});
 fs.writeFileSync(path.join(root,'jvm.log'),jvm.stdout+jvm.stderr);assert.ifError(jvm.error);assert.equal(jvm.status,0,jvm.stdout+jvm.stderr);assert.match(jvm.stdout,/PASS native stream activity binding/);
 const jar=path.join(root,'probe.jar');run(path.join(jdk,'bin/jar'),['cf',jar,'-C',classes,'.']);
 run(path.join(jdk,'bin/java'),['-cp',path.resolve(r8),'com.android.tools.r8.D8','--min-api','36','--lib',path.resolve(runtime,'android-framework.jar'),'--classpath',path.resolve(runtime,'android-host.jar'),'--output',dex,jar]);
 const c=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload)).components,object=path.join(root,'activity.o'),library=path.join(root,'activity.so');
 const includes=[...options.includeDirectories,path.join(options.output,'source/adapter'),path.join(options.output,'source/binder/include'),path.join(options.output,'source/binder')];
 run(options.compiler,[...options.binderFlags,...includes.flatMap(p=>['-isystem',p]),'-std=c++20','-fPIC','-c',path.join(fixture,'StreamActivityProbe.cpp'),'-o',object],{cwd:options.sourceRoot});
 run(options.linkCompiler,['-shared','-nostdlib++','-Wl,--no-undefined',object,...[path.dirname(c.binderLibrary),path.join(c.image,'system/lib64'),...(options.libraryDirectories||[])].map(p=>'-L'+p),'-laudioclient','-l:audiopolicy-aidl-cpp.so','-lbinder','-lutils','-l:libc++.so','-o',library],{cwd:options.sourceRoot});
 const {layout,environment,prepareMountParents,publishPathMap}=await import('../src/modules/android/art/layout.mjs'),supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const state=path.join(root,'state'),properties=path.join(root,'properties');fs.mkdirSync(state);run(c.bootstrap,[c.image,properties]);
 const text=[['ro','/system/lib64/libart-platform.so',path.resolve(platform)],['ro','/system/lib64/audio-activity-probe.so',library],['ro','/system/framework/audio-activity.dex',path.join(dex,'classes.dex')],['ro','/dev/__properties__',properties],['ro','/system/lib64/libandroid-log-stderr.so',c.logLibrary]].map(row=>row.join('\t')).join('\n')+'\n'+layout({supplier,state});
 const map=publishPathMap(state,'audio',prepareMountParents(text,path.join(root,'mounts'))),env={...environment(supplier),...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment,TMPDIR:root,LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so'};
 // The fixture carries changed owned classes and the probe, ahead of the
 // unchanged complete hooks archive. The original framework stays intact.
 env.BOOTCLASSPATH='/system/framework/audio-activity.dex:'+env.BOOTCLASSPATH;
 env.CLASSPATH='/system/framework/audio-activity.dex:'+env.CLASSPATH;
 const name='maclauncher.audio-activity.'+crypto.randomUUID(),binder=spawn(c.binder,['--host-module',c.hostLibrary,'--service',name],{env,stdio:'ignore',detached:true});
 try{
  run(c.bootstrap,['wait-binder',name],{env});const args=['--inherit-env','--guest-fds','0,1,2','--binder',name,'--path-map',map,'--cache',path.join(root,'cache'),'--host-module',c.hostLibrary];
  run(c.linuxRun,[...args,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
  const output=run(c.linuxRun,[...args,'--identity-text','service\taudio-query\nuid\t10021\ngid\t10021\ncap_effective\t0\ncap_permitted\t0\ncap_bounding\t0\n','/system/bin/app_process64','-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','/system/bin','maclauncher.android.media.StreamActivityProbe','/system/lib64/libart-platform.so','/system/lib64/libart-platform.so','/system/lib64/audio-activity-probe.so'],{env});
  fs.writeFileSync(path.join(root,'art.log'),output);assert.match(output,/PASS native stream activity binding/);
 }finally{
  if(binder.exitCode===null&&binder.signalCode===null){const closed=once(binder,'close'),timer=setTimeout(()=>{try{process.kill(-binder.pid,'SIGKILL');}catch{}},2000);try{process.kill(-binder.pid,'SIGTERM');await closed;}finally{clearTimeout(timer);}}
 }
 t.diagnostic('Evidence '+root);
});
