const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('Android identities and priorities share live process-owned thread lifetimes',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(process.platform!=='darwin'||!runtime)return t.skip('Requires macOS Mach policies and the built Android signal owner');
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const home=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim();
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-priority-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const source=path.resolve(__dirname,'../src/modules/android/native'),fixture=path.join(__dirname,'fixtures/android-process-priority');
 const core=path.resolve(runtime,'native/libklepton-jvm.dylib');
 // Identity and targeted signal delivery must link the same changed owner;
 // using signal delivery from an older core would inspect another TID table.
 run('clang',['-std=gnu11','-dynamiclib','-Wall','-Wextra','-Werror','-I'+source,'-I'+home+'/include','-I'+home+'/include/darwin',fixture+'/priority.c',source+'/thread-identity.c',source+'/signal-bridge.c',core,'-Wl,-rpath,'+path.dirname(core),'-o',tmp+'/priority.dylib']);
 run(home+'/bin/javac',['--release','21','-d',tmp,fixture+'/PriorityProbe.java']);
 const ids=require('./helpers/android-java').processNamespace(tmp).KL_ANDROID_ID_DIRECTORY;
 assert.match(run(home+'/bin/java',['-Xcheck:jni','-cp',tmp,'PriorityProbe',tmp+'/priority.dylib',ids]),/PASS owned-thread Mach priority/);
});
test('Built runtime has one identity across original Java, thread owner, guest libc and raw syscall',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;if(process.platform!=='darwin'||!runtime)return t.skip('Requires built Android runtime');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'android-thread-runtime-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:10000});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const binary=dir+'/runtime';run('clang',['-Wall','-Wextra','-Werror',path.join(__dirname,'fixtures/android-process-priority/runtime.c'),'-o',binary]);
 const ids=require('./helpers/android-java').processNamespace(dir).KL_ANDROID_ID_DIRECTORY;
 assert.match(run(binary,[path.resolve(runtime),ids]),/PASS built runtime original Java, thread owner, guest libc and raw syscall share thread identities/);
});
test('Original ServiceThread can initialize its requested background priority',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android runtime and Java21');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'android-service-priority-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const env={...process.env,...require('./helpers/android-java').processNamespace(dir)};
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,env});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const source=path.resolve(__dirname,'../src/modules/android/native'),fixture=path.join(__dirname,'fixtures/android-process-priority'),core=path.resolve(runtime,'native/libklepton-jvm.dylib');
 const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
 // The changed JNI boundary delegates to the same built core thread owner as
 // the original Process.myTid/getThreadPriority used by ServiceThread.
 run('clang',['-std=gnu11','-dynamiclib','-Wall','-Wextra','-Werror','-I'+source,'-I'+home+'/include','-I'+home+'/include/darwin',fixture+'/priority.c',core,'-Wl,-rpath,'+path.dirname(core),'-o',dir+'/priority.dylib']);
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',dir,fixture+'/ServiceThreadPriorityProbe.java',path.join(__dirname,'fixtures/android-window-session/RuntimeFixture.java')]);
 const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');
 assert.match(run(home+'/bin/java',[...frameworkJvmOptions,'-cp',dir+path.delimiter+cp,'ServiceThreadPriorityProbe',path.resolve(runtime),dir+'/data',dir+'/priority.dylib']),/PASS original ServiceThread background priority and Looper lifecycle/);
});
