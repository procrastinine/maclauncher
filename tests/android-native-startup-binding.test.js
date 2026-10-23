const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('JNI configuration copies actual guest startup into the native core',t=>{
 const {JAVA_HOME:java,ANDROID_STARTUP_BINDING:binding,ANDROID_STARTUP_CORE:core,ANDROID_STARTUP_HOST_JAR:jar,ANDROID_STARTUP_FRAMEWORK:framework}=process.env;
 if(process.platform!=='darwin'||![java,binding,core,jar,framework].every(Boolean))return t.skip('Requires matching native components and complete Android framework');
 const parent=process.env.ANDROID_STARTUP_BINDING_OUTPUT,work=fs.realpathSync(fs.mkdtempSync(path.join(parent?path.resolve(parent):os.tmpdir(),'android-startup-binding-')));if(!parent)t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const fixture=path.resolve(__dirname,'fixtures/android-native/startup'),owned=path.join(work,'libnativebinding.dylib'),probe=path.join(work,'probe.dylib');fs.copyFileSync(binding,owned);fs.symlinkSync(core,path.join(work,'libklepton-jvm.dylib'));
 const env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|KL_|KLEPTON_|RESHADE_)/.test(key))delete env[key];
 const run=(p,a,e=env)=>{let r=spawnSync(p,a,{env:e,encoding:'utf8',timeout:15000,maxBuffer:2<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 const cp=[work,jar,framework].join(path.delimiter);run(java+'/bin/javac',['--release','21','-cp',cp,'-d',work,path.join(fixture,'StartupBindingProbe.java')]);run('clang',['-dynamiclib','-O2','-Wall','-Wextra','-Werror','-I'+java+'/include','-I'+java+'/include/darwin',path.join(fixture,'binding-probe.c'),'-o',probe]);
 const records=[];for(const mode of ['full','missing']){
  const current={...env};if(mode==='full')current.KL_ANDROID_NATIVE_STARTUP_ENVIRONMENT='1:'+Buffer.from('HOME=/guest/é🎮\n=value\0EMPTY=\0').toString('base64url');
  const result=run(java+'/bin/java',[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Xcheck:jni','-Xverify:all','-cp',cp,'maclauncher.android.bridge.StartupBindingProbe',core,owned,probe,work,mode],current);
  fs.writeFileSync(path.join(work,mode+'.stdout.log'),result.stdout);fs.writeFileSync(path.join(work,mode+'.stderr.log'),result.stderr);records.push({mode,pid:result.pid,status:result.status,signal:result.signal});assert.match(result.stdout,/PASS/);assert.doesNotMatch(result.stderr,/WARNING in native method|FATAL ERROR in native method/);
 }
 fs.writeFileSync(path.join(work,'PROCESS.json'),JSON.stringify({core,binding,jar,records})+'\n');t.diagnostic('Evidence '+work);
});
