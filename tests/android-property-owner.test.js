const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('AOSP property handles retain the original process-lifetime native owner identity',t=>{
  const home=process.env.JAVA_HOME;if(process.platform!=='darwin'||!home)return t.skip('Requires macOS and Java21');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-property-owner-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.resolve(__dirname,'../src/modules/android/native'),fixture=path.join(__dirname,'fixtures/android-framework-services');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:1<<20});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);assert.doesNotMatch(result.stderr,/WARNING in native method|FATAL ERROR in native method/);return result.stdout;};
  const library=path.join(root,'properties.dylib');
  run('clang',['-dynamiclib','-Wall','-Wextra','-Werror','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),'-DANDROID_PROPERTY_SOURCE='+JSON.stringify(path.join(source,'framework-properties.c')),path.join(fixture,'native-property-owner.c'),'-o',library]);
  run(path.join(home,'bin/javac'),['--release','21','-d',root,path.join(fixture,'NativePropertyOwnerProbe.java')]);
  assert.match(run(path.join(home,'bin/java'),['-Xcheck:jni','-cp',root,'NativePropertyOwnerProbe',library]),/PASS original property owner/);
});
