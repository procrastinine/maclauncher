const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const source=path.resolve(__dirname,'../src/modules/android/native');
const fixtures=path.join(__dirname,'fixtures/android-native');
function run(command,args,env=process.env){const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,env});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
test('Guest mutex registry retires actual host objects and protects in-flight references',t=>{
 if(process.platform!=='darwin')return t.skip('Requires Darwin pthread ownership');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-mutex-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const binary=path.join(temporary,'registry');
 run('clang',['-std=c11','-Wall','-Wextra','-Werror','-I'+source,path.join(fixtures,'pthread-registry.c'),'-o',binary]);
 assert.match(run(binary,[]),/PASS mutex registry retires 102400 owners/);
});
test('Built guest pthread preserves mutex types, condition waits and concurrent ownership',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime)return t.skip('Requires an Apple Silicon Android runtime');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-pthread-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const binary=path.join(temporary,'ownership');
 run('clang',['-std=c11','-Wall','-Wextra','-Werror',path.join(fixtures,'pthread-ownership.c'),'-o',binary]);
 const ids=path.join(temporary,'ids');fs.mkdirSync(ids,{mode:0o700});
 assert.match(run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib'),fs.realpathSync(ids)]),/PASS native mutex types, sleeping condition waits, collision deletion, cancellation and concurrent publication/);
});
test('Guest native threads retain a JVM-compatible stack reserve',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime)return t.skip('Requires an Apple Silicon Android runtime');
 const home=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim();
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-jni-stack-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const library=path.join(temporary,'stack.dylib');
 run('clang',['-dynamiclib','-std=c11','-Wall','-Wextra','-Werror','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(fixtures,'guest-thread-stack.c'),'-o',library]);
 run(path.join(home,'bin/javac'),['--release','21','-d',temporary,path.join(fixtures,'GuestThreadStackProbe.java')]);
 assert.match(run(path.join(home,'bin/java'),['-Xcheck:jni','-cp',temporary,'GuestThreadStackProbe',library,path.resolve(runtime,'native/libklepton-jvm.dylib')],{...process.env,...require('./helpers/android-java').processNamespace(temporary)}),/PASS guest native stack reserves support JVM attachment and startup handshakes/);
});
