const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Shared Android native handles cannot revive another owner after allocator reuse',t=>{
  const home=process.env.JAVA_HOME;if(process.platform!=='darwin'||!home)return t.skip('Requires macOS and Java 21');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-handle-lifetime-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const source=path.resolve(__dirname,'../src/modules/android/native'),fixture=path.join(__dirname,'fixtures/android-framework-services');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:1<<20});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);assert.doesNotMatch(result.stderr,/WARNING in native method|FATAL ERROR in native method/);return result.stdout;};
  run(path.join(home,'bin/javac'),['--release','21','-d',tmp,path.join(source,'java/maclauncher/android/framework/HostNativeHandle.java'),path.join(fixture,'NativeHandleLifetimeProbe.java')]);
  const library=path.join(tmp,'handles.dylib');run('clang',['-dynamiclib','-Wall','-Wextra','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),'-DANDROID_HANDLE_SOURCE='+JSON.stringify(path.join(source,'framework-native-handle.c')),path.join(fixture,'native-handle-lifetime.c'),'-o',library]);
  assert.match(run(path.join(home,'bin/java'),['-Xcheck:jni','-cp',tmp,'NativeHandleLifetimeProbe',library]),/PASS forced native allocation reuse/);
});
