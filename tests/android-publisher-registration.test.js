const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Original image registration preserves framework overrides for publisher, guest and translated closures without changing application loaders',async t=>{
  const home=process.env.JAVA_HOME;if(process.platform!=='darwin'||!home)return t.skip('Requires macOS and Java21');
  const ndk=process.env.ANDROID_NDK_HEADERS;if(!ndk)return t.skip('Requires ANDROID_NDK_HEADERS for the original Android logger ABI');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-publisher-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.resolve(__dirname,'../src/modules/android/native'),fixture=path.join(__dirname,'fixtures/android-framework-services');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:1<<20});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);assert.doesNotMatch(result.stderr,/WARNING in native method|FATAL ERROR in native method/);return result.stdout;};
  run(path.join(home,'bin/javac'),['--release','21','-d',root,path.join(fixture,'JvmNativeMemory.java'),path.join(fixture,'NativePublisherProbe.java')]);
  // The registration owner includes the logger ABI the native build derives from the NDK header.
  (await import('../src/modules/android/native/android-log-source.mjs')).prepareAndroidLogAbi({include:ndk,output:root});
  const includes=['-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),'-I'+root];
  const publisher=path.join(root,'publisher.dylib'),platform=path.join(root,'platform.dylib');
  run('clang',['-dynamiclib','-std=c11','-Wall','-Wextra',...includes,path.join(fixture,'native-publisher.c'),'-o',publisher]);
  run('clang',['-dynamiclib','-std=c11','-Wall','-Wextra',...includes,path.join(source,'framework-native-registration.c'),path.join(source,'loader-native-registration.c'),path.join(fixture,'native-publisher-platform.c'),'-o',platform]);
  assert.match(run(path.join(home,'bin/java'),['-Xcheck:jni','-cp',root,'NativePublisherProbe',platform,publisher]),/PASS publisher initializer/);
});
