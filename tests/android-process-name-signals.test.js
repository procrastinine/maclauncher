const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('Android names and thread signals share the existing process and live-thread owners',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,jdk=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!jdk)return t.skip('Requires the native runtime and JDK');
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-process-name-signals-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const native=path.resolve(__dirname,'../src/modules/android/native'),core=path.resolve(runtime,'native/libklepton-jvm.dylib');
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:15000});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const binary=path.join(output,'probe');
 run('clang',['-std=gnu11','-Wall','-Wextra','-Werror','-I'+native,'-I'+path.join(jdk,'include'),'-I'+path.join(jdk,'include/darwin'),path.join(__dirname,'fixtures/android-native/process-name-signals.c'),...['process-identity.c','thread-identity.c','signal-bridge.c'].map(f=>path.join(native,f)),core,'-Wl,-rpath,'+path.dirname(core),'-o',binary]);
 assert.match(run(binary,[]),/PASS Android process-name data and live-thread signal ownership/);
});
