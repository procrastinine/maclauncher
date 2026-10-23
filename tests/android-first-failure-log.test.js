const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('shared bounded failure reports retain original throwable/cleanup with closed guest stderr',t=>{
 const java=process.env.JAVA_HOME,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(process.platform!=='darwin'||!java||!runtime)return t.skip('Requires original framework runtime and Java21');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-first-failure-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:2<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 const fixture=path.resolve('tests/fixtures/android-native'),library=path.join(root,'close-stdio.dylib');
 run('clang',['-dynamiclib','-O2','-Wall','-Wextra','-Werror','-I'+path.join(java,'include'),'-I'+path.join(java,'include/darwin'),fixture+'/first-failure-stdio.c','-o',library]);
 const classpath=root+path.delimiter+path.resolve(runtime,'android-host.jar');
 run(java+'/bin/javac',['--release','21','-cp',classpath,'-d',root,path.resolve('src/modules/android/native/java/maclauncher/android/FirstFailure.java'),fixture+'/FirstFailureProbe.java',fixture+'/FirstFailureClosedProbe.java',path.resolve('tests/fixtures/android-framework-services/NativeResourceSupport.java')]);
 for(const mode of[[],['workers']]){
  const r=run(java+'/bin/java',['-cp',classpath,'maclauncher.android.FirstFailureProbe',...mode]);assert.match(r.stdout,/PASS /);t.diagnostic(r.stdout.trim());
 }
 const r=run(java+'/bin/java',['-cp',classpath,'maclauncher.android.FirstFailureClosedProbe',library]);
 if(process.env.ANDROID_FIRST_FAILURE_OUTPUT){fs.mkdirSync(process.env.ANDROID_FIRST_FAILURE_OUTPUT,{recursive:true});fs.writeFileSync(path.join(process.env.ANDROID_FIRST_FAILURE_OUTPUT,'stdout.log'),r.stdout);fs.writeFileSync(path.join(process.env.ANDROID_FIRST_FAILURE_OUTPUT,'stderr.log'),r.stderr);}
 assert.match(r.stdout,/PASS original JVM Android logger/);assert.match(r.stderr,/AndroidHost.*\[android-host\] Failure:/);assert.match(r.stderr,/original JVM failure after guest stderr close/);assert.match(r.stderr,/FirstFailureClosedProbe.main/);
 t.diagnostic(r.stdout.trim());
});
