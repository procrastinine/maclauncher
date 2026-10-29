const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');

test('Raw AOSP Parcel and Bundle preserve byte storage, typed values and real local references',t=>{
  if(process.platform!=='darwin')return t.skip('Requires the included file descriptor adapter');
  const runtime=require('./helpers/android-java').runtimeRoot();
  if(!runtime)return t.skip('Requires a built Android runtime (KLEPTON_NATIVE_RUNTIME)');
  const home=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim();
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-parcel-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const cp=['android-host.jar','android-framework.jar'].map(name=>path.join(runtime,name)).join(path.delimiter);
  const env={...process.env,TMPDIR:temp};
  for(const key of Object.keys(env))if(/^(DYLD_|KLEPTON_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
  const run=(file,args)=>{const result=spawnSync(file,args,{env,encoding:'utf8',timeout:20000,maxBuffer:1024*1024});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;};
  run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temp,path.join(__dirname,'fixtures/android-framework-services/RawParcelProbe.java'),path.join(__dirname,'fixtures/android-native/BundleGuestValue.java')]);
  const output=run(path.join(home,'bin/java'),['-Xcheck:jni','-Xverify:all','-Djava.awt.headless=true','-cp',temp+path.delimiter+cp,'maclauncher.android.RawParcelProbe',path.join(runtime,'native/libklepton-jvm.dylib'),path.join(temp,'descriptor.txt'),temp]);
  assert.match(output,/PASS \d+ raw AOSP Parcel, Bundle, typed serialization, local Binder and real descriptor checks/);
  assert.doesNotMatch(output,/FATAL ERROR in native method/);
  const warnings=output.split('\n').filter(line=>line.startsWith('WARNING'));
  assert.equal(warnings.length,7,warnings.join('\n'));
  assert.ok(warnings.every(line=>line==='WARNING in native method: JNI call made without checking exceptions when required to from CallStaticObjectMethodV'));
});
