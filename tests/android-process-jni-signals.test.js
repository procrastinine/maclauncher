const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('Process JNI signal variants use the shared retained Android child owner',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,jdk=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!jdk)return t.skip('Requires the native runtime and Java headers');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-process-jni-signals-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const root=path.resolve('src/modules/android/native'),core=path.resolve(runtime,'native/libklepton-jvm.dylib');
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:15000});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const binary=path.join(directory,'probe'),namespace=path.join(directory,'ids');fs.mkdirSync(namespace,{mode:0o700});
 run('clang',['-std=gnu11','-Wall','-Wextra','-Werror','-I'+root,'-I'+path.join(jdk,'include'),'-I'+path.join(jdk,'include/darwin'),path.resolve('tests/fixtures/android-native/process-jni-signals.c'),core,'-Wl,-rpath,'+path.dirname(core),'-o',binary]);
 assert.match(run(binary,[namespace,path.resolve(runtime,'native/libnativebinding.dylib')]),/PASS Process JNI signal variants share native child leases, delivery and retirement/);
});
