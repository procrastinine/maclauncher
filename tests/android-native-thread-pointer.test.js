const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Every original JVM native entry initializes its retained Android thread pointer',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,core=process.env.KLEPTON_NATIVE_CORE,java=process.env.JAVA_HOME,clang=process.env.ANDROID_CLANG;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![runtime,core,java,clang].every(Boolean))return t.skip('Requires an Apple Silicon Android native runtime, changed core, NDK Clang and Java21');
 const parent=process.env.ANDROID_THREAD_TEST_OUTPUT,root=fs.mkdtempSync(path.join(parent?path.resolve(parent):os.tmpdir(),'android-jni-thread-pointer-'));
 if(!parent)t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(file,args,env)=>spawnSync(file,args,{encoding:'utf8',timeout:20000,maxBuffer:2<<20,env});
 const pass=(file,args,env)=>{const r=run(file,args,env);assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 const fixture=path.resolve('tests/fixtures/android-native'),guest=root+'/libjni-thread-pointer.so',classpath=[path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
 pass(clang,['-O2','-shared','-fPIC','-fno-stack-protector','-Wall','-Wextra','-Werror',fixture+'/jni-thread-pointer.c','-o',guest]);
 pass(java+'/bin/javac',['--release','21','-cp',classpath,'-d',root,fixture+'/JniThreadPointerProbe.java']);
 const env={...process.env,...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment,DYLD_FRAMEWORK_PATH:path.resolve(runtime,'native')};
 const args=selected=>{
  // The delivered binding uses @loader_path for its single core owner. Copy
  // that unchanged binding beside the selected core to test a real closure.
  const directory=root+'/'+(path.resolve(selected)===path.resolve(core)?'new':'old');fs.mkdirSync(directory);
  fs.symlinkSync(path.resolve(selected),directory+'/libklepton-jvm.dylib');fs.copyFileSync(path.resolve(runtime,'native/libnativebinding.dylib'),directory+'/libnativebinding.dylib',fs.constants.COPYFILE_FICLONE);
  return ['-Xcheck:jni','-Xverify:all','-cp',root+path.delimiter+classpath,'JniThreadPointerProbe',directory+'/libklepton-jvm.dylib',directory+'/libnativebinding.dylib',guest];
 };
 if(process.env.KLEPTON_NATIVE_OLD_CORE){const old=run(java+'/bin/java',args(process.env.KLEPTON_NATIVE_OLD_CORE),env);fs.writeFileSync(root+'/old.log',old.stdout+old.stderr);assert.ifError(old.error);assert.equal(old.status,1,old.stdout+old.stderr);assert.match(old.stderr,/Constructor\/JNI_OnLoad\/JNI thread pointer is uninitialized/);}
 const result=pass(java+'/bin/java',args(core),env);fs.writeFileSync(root+'/new.log',result.stdout+result.stderr);
 assert.match(result.stdout,/PASS original ELF constructor, JNI_OnLoad, main\/four fresh registered JNI threads and retirement retain Android TP and canary/);
 assert.doesNotMatch(result.stderr,/WARNING in native method|FATAL ERROR in native method/);t.diagnostic('Evidence '+root);
});
