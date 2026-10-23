const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('native runtime receives the inspected ApplicationInfo target SDK before image loading',{timeout:30000},t=>{
  const {JAVA_HOME:java,KLEPTON_NATIVE_RUNTIME:runtime,KLEPTON_NATIVE_CORE:core,KLEPTON_NATIVE_BINDING:binding,KLEPTON_HOST_CONTEXT_SOURCE:source,KLEPTON_ORIGINAL_FRAMEWORK:framework}=process.env;
  if(process.platform!=='darwin'||![java,runtime,core,binding,source,framework].every(Boolean))return t.skip('Requires matching native components and the original full Android framework archive');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-linker-target-sdk-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const ownedBinding=path.join(root,'libnativebinding.dylib');fs.copyFileSync(binding,ownedBinding);fs.symlinkSync(core,path.join(root,'libklepton-jvm.dylib'));
  const cp=[path.join(runtime,'android-host.jar'),framework].join(path.delimiter);
  function run(program,args){const r=spawnSync(program,args,{encoding:'utf8',timeout:15000,maxBuffer:2<<20});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(r.signal,null);return r;}
  run(java+'/bin/javac',['--release','21','-cp',cp,'-d',root,source,'tests/fixtures/android-linker-target-sdk/TargetSdkProbe.java']);
  const probe=path.join(root,'probe.dylib');
  run('/usr/bin/clang',['-dynamiclib','-O2','-Wall','-Wextra','-Werror','-I'+java+'/include','-I'+java+'/include/darwin','tests/fixtures/android-linker-target-sdk/native.c','-o',probe]);
  const result=run(java+'/bin/java',['-Xcheck:jni','-Xverify:all','-cp',root+path.delimiter+cp,'maclauncher.android.bridge.TargetSdkProbe',core,ownedBinding,probe,root]);
  assert.match(result.stdout,/PASS actual ApplicationInfo target SDK before native image configuration/);
  assert.doesNotMatch(result.stderr,/WARNING in native method|FATAL ERROR in native method/);
});
