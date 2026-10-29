const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {componentSupplier}=require('./helpers/android-art-supplier');

test('original ART boot AOT dispatch retains null handling and the application SIGSEGV chain',{timeout:60000},async t=>{
  // The Android API jars are delivered with the common runtime, separately from ART.
  const {ANDROID_ART_PAYLOAD:payload,KLEPTON_NATIVE_RUNTIME:common,JAVA_HOME:java,ANDROID_CLANG:clang,ANDROID_R8:r8}=process.env;
  if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,common,java,clang,r8].every(Boolean))return t.skip('Requires the ART supplier, common runtime, Android Clang, Java and R8');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-managed-null-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const retained=process.env.ANDROID_MANAGED_FAULT_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
  const run=(command,args,{capture=false,...options}={})=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024,...options});if(capture&&retained){fs.writeFileSync(path.join(retained,'stdout.log'),r.stdout||'');fs.writeFileSync(path.join(retained,'stderr.log'),r.stderr||'');}assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,(r.stdout+r.stderr).slice(-14000));return r.stdout+r.stderr;};
  const supplier=componentSupplier(path.resolve(payload)),fixture=path.resolve('tests/fixtures/android-test'),classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
  run(path.join(java,'bin/javac'),['--release','21','-cp',path.join(common,'android-framework.jar'),'-d',classes,path.join(fixture,'ManagedNullSignalProbe.java')]);
  run(path.join(java,'bin/jar'),['cf',path.join(root,'probe.jar'),'-C',classes,'.']);
  run(path.join(java,'bin/java'),['-cp',r8,'com.android.tools.r8.D8','--min-api','36','--lib',path.join(common,'android-framework.jar'),'--output',dex,path.join(root,'probe.jar')]);
  run(clang,['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror','-Wl,--no-undefined',path.join(fixture,'managed-null-signal.c'),'-o',path.join(root,'probe.so')]);
  const {layout,prepareMountParents,publishPathMap,environment,runtimeBootClasspath}=await import('../src/modules/android/art/layout.mjs');
  const state=path.join(root,'state');fs.mkdirSync(state);
  const map=publishPathMap(state,'managed-null-proof',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/managed-null\t'+root+'\n',path.join(root,'mounts')));
  const base=['--inherit-env','--path-map',map,'--no-cache','--host-module',supplier.components.hostLibrary],env=environment(supplier);
  Object.assign(env,(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment);
  delete env.CLASSPATH;env.BOOTCLASSPATH=runtimeBootClasspath(supplier.manifest.bootClasspath).join(':');
  run(supplier.components.linuxRun,[...base,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
  const output=run(supplier.components.linuxRun,[...base,'/apex/com.android.art/bin/dalvikvm64','-Xusejit:false','-Ximage:/system/framework/boot.art','-cp','/data/local/tmp/managed-null/dex/classes.dex','ManagedNullSignalProbe','/data/local/tmp/managed-null/probe.so','/data/local/tmp/managed-null/dex/classes.dex'],{env,capture:true});
  assert.match(output,/PASS original AOT NotificationChannel dispatch, null handling and application SIGSEGV chain/);
  const dispatch=[...output.matchAll(/PASS original JNI AOT dispatch NotificationChannel\.setVibrationPattern (non-null|null) entry=(0x[0-9a-f]+) mapping=\/system\/framework\/arm64\/boot-framework\.oat/g)];
  assert.deepEqual(dispatch.map(match=>match[1]),['non-null','null'],'Both original JNI invocations must use executable boot-image AOT');
  assert.equal(dispatch[0][2],dispatch[1][2],'The original AOT dispatch entry must remain stable across the null invocation');
});
