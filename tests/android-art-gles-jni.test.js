const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync,spawn}=require('node:child_process'),{once}=require('node:events');
const {componentSupplier}=require('./helpers/android-art-supplier');
test('Original ART GLES JNI reads native RGB8 textures through the same EGL context',{timeout:45000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,JAVA_HOME:java,ANDROID_CLANG:clang,ANDROID_R8:r8}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,java,clang,r8].every(Boolean))return t.skip('Requires an ART supplier, Android Clang, JDK and D8');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-gles-jni-'));let binder;t.after(async()=>{if(binder&&binder.exitCode===null&&binder.signalCode===null){const closed=once(binder,'close'),timer=setTimeout(()=>{try{process.kill(-binder.pid,'SIGKILL');}catch{}},1500);try{process.kill(-binder.pid,'SIGTERM');await closed;}finally{clearTimeout(timer);}}
  // Original AIM publishes immutable translated-code directories. Only this
  // fixture's retired private directory becomes writable for removal.
  const writable=directory=>{fs.chmodSync(directory,0o700);for(const item of fs.readdirSync(directory,{withFileTypes:true}))if(item.isDirectory())writable(path.join(directory,item.name));};writable(root);fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
 const retained=process.env.ANDROID_ART_GLES_JNI_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 const run=(command,args,env=process.env,capture=false)=>{const r=spawnSync(command,args,{env,encoding:'utf8',timeout:30000,maxBuffer:4<<20});if(capture&&retained){fs.writeFileSync(path.join(retained,'stdout.log'),r.stdout||'');fs.writeFileSync(path.join(retained,'stderr.log'),r.stderr||'');}assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,(r.stdout+r.stderr).slice(-16000));return r.stdout+r.stderr;};
 const supplier=componentSupplier(path.resolve(payload)),c=supplier.components,fixture=path.resolve('tests/fixtures/android-art'),classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 run(path.join(java,'bin/javac'),['--release','21','-cp',path.join(payload,'android-framework.jar'),'-d',classes,path.join(fixture,'ArtGlesReadbackProbe.java')]);run(path.join(java,'bin/jar'),['cf',path.join(root,'probe.jar'),'-C',classes,'.']);
 run(path.join(java,'bin/java'),['-cp',r8,'com.android.tools.r8.D8','--min-api','36','--lib',path.join(payload,'android-framework.jar'),'--output',dex,path.join(root,'probe.jar')]);
 run(clang,['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror','-Wl,--no-undefined',path.join(fixture,'ArtGlesReadbackProbe.c'),'-lEGL','-lGLESv3','-o',path.join(root,'probe.so')]);
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs'),state=path.join(root,'state');fs.mkdirSync(state);
 const properties=path.join(root,'properties');run(c.bootstrap,[c.image,properties]);
 const mounts=[['ro','/data/local/tmp/gles-jni',root],['ro','/vendor/lib64/egl/libGLES_aim.so',c.glesLibrary],['ro','/system/lib64/libandroid-log-stderr.so',c.logLibrary],['ro','/system/lib64/libbinder.so',c.binderLibrary],['ro','/dev/__properties__',properties]];
 const map=publishPathMap(state,'gles-jni',prepareMountParents(layout({supplier,state})+mounts.map(row=>row.join('\t')+'\n').join(''),path.join(root,'mounts')));
 const env={...environment(supplier),...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment,LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so',KL_ANGLE_BACKEND:'metal',DYLD_FRAMEWORK_PATH:path.join(payload,'native')};
 env.CLASSPATH='/data/local/tmp/gles-jni/dex/classes.dex';env.BOOTCLASSPATH=env.BOOTCLASSPATH.replace('/system/framework/maclauncher.jar','/data/local/tmp/gles-jni/dex/classes.dex:/system/framework/maclauncher.jar');const binderName='maclauncher.android.gles-jni.'+require('node:crypto').randomUUID();binder=spawn(c.binder,['--host-module',c.hostLibrary,'--service',binderName],{env,stdio:'ignore',detached:true});run(c.bootstrap,['wait-binder',binderName],env);
 const base=['--inherit-env','--guest-fds','0,1,2','--binder',binderName,'--path-map',map,'--cache',path.join(root,'cache'),'--gpu',path.join(payload,'native/angle'),'--host-module',c.hostLibrary];
 run(c.linuxRun,[...base,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],env);
 const output=run(c.linuxRun,[...base,'/system/bin/app_process64','-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','/system/bin','ArtGlesReadbackProbe','/data/local/tmp/gles-jni/probe.so'],env,true);
 assert.match(output,/PASS original ART JNI reads native RGB8 texture extent2 /);assert.match(output,/PASS original ART JNI reads native RGB8 texture extent1024 /);t.diagnostic(output.split('\n').filter(line=>/CONTEXT |PASS original ART JNI/.test(line)).join('\n'));
});
