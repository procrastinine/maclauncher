const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Android registration preserves its VM owner across failed hooks without publishing stale image ranges',t=>{
  const home=process.env.JAVA_HOME;if(process.platform!=='darwin'||!home)return t.skip('Requires macOS and Java21');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-registration-life-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.resolve(__dirname,'../src/modules/android/native'),fixture=path.join(__dirname,'fixtures/android-native');
  fs.writeFileSync(path.join(root,'registration-instrumented.c'),require('./helpers/android-native-faults').registrationSource());
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:1<<20});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);assert.doesNotMatch(result.stderr,/WARNING in native method|FATAL ERROR in native method/);return result.stdout;};
  const library=path.join(root,'lifetime.dylib');
  run('clang',['-dynamiclib','-Wall','-Wextra','-Werror','-Wno-unused-parameter','-I'+root,'-I'+source,'-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(fixture,'registration-lifetime-probe.c'),'-o',library]);
  run(path.join(home,'bin/javac'),['--release','21','-d',root,path.join(fixture,'RegistrationLifetimeProbe.java')]);
  assert.match(run(path.join(home,'bin/java'),['-Xcheck:jni','-Xverify:all','-cp',root,'RegistrationLifetimeProbe',library]),/PASS registration lifetime/);
});
