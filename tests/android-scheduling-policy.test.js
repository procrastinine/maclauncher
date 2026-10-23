const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('Original scheduling policy is published once and unsupported requests return without polling',{timeout:30000},t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-scheduling-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const ids=path.join(root,'ids');fs.mkdirSync(ids,{mode:0o700});
 const native=path.resolve('src/modules/android/native'),fixtures=path.resolve('tests/fixtures/android-platform-service');
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,env:{...process.env,KL_ANDROID_ID_DIRECTORY:ids}});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const core=path.resolve(runtime,'native/libklepton-jvm.dylib'),library=path.join(root,'scheduling.dylib');
 run('clang',['-std=gnu11','-dynamiclib','-Wall','-Wextra','-Werror','-I'+native,'-I'+home+'/include','-I'+home+'/include/darwin',fixtures+'/scheduling-policy.c',core,'-Wl,-rpath,'+path.dirname(core),'-o',library]);
 const cp=['android-host.jar','android-framework.jar'].map(file=>path.resolve(runtime,file)).join(path.delimiter);
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',root,native+'/java/com/android/server/HostSchedulingPolicy.java',fixtures+'/SchedulingPolicyProbe.java',path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')]);
 const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');
 assert.match(run(home+'/bin/java',[...frameworkJvmOptions,'-Xcheck:jni','-cp',root+path.delimiter+cp,'SchedulingPolicyProbe',path.resolve(runtime),root+'/data',library,ids]),/PASS original scheduling service publication, native lease queries and prompt negative replies/);
});
