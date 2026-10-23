const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('Native Choreographer deadlines retain the display clock domain after Mac sleep',t=>{
 if(process.platform!=='darwin')return t.skip('macOS native clock and ALooper');
 const source=path.resolve(__dirname,'../src/modules/android/native');
 let runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(!runtime){const entry=require('../src/modules/android/distribution-supplementals.json')[0];runtime=path.resolve(__dirname,'../src/resources/native-runtimes',entry.directoryRelative);}
 const native=path.resolve(runtime,'native');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-ndk-choreographer-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const executable=path.join(temporary,'choreographer');
 function run(command,args){const result=spawnSync(command,args,{encoding:'utf8',timeout:10000,maxBuffer:1<<20});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
 // The canonical core build force-includes this same clock owner. Retain that
 // context here; omitting it is not a valid negative for an installed runtime.
 const object=path.join(temporary,'choreographer.o');
 run('clang',['-std=c11','-O2','-Wall','-Wextra','-Werror','-I'+source,'-include',path.join(source,'native-clock/clock-domain.h'),'-c',path.join(source,'ndk-choreographer.c'),'-o',object]);
 run('clang',['-std=c11','-O2','-Wall','-Wextra','-Werror',object,path.join(__dirname,'fixtures/android-window-session/ndk-choreographer-domain.c'),path.join(native,'libklepton-jvm.dylib'),'-Wl,-rpath,'+native,'-o',executable]);
 assert.match(run(executable,[]),/PASS native Choreographer uptime, delayed\/reposted callbacks, original ALooper delivery and retirement/);
});

test('Native Choreographer uses the original Java HandlerThread queue owner',async t=>{
 if(process.platform!=='darwin')return t.skip('macOS native Java queue');
 let runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(!runtime){const entry=require('../src/modules/android/distribution-supplementals.json')[0];runtime=path.resolve(__dirname,'../src/resources/native-runtimes',entry.directoryRelative);}
 runtime=path.resolve(runtime);const java=require('./helpers/android-java');
 const home=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim();
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-java-queue-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const identityVersion=JSON.parse(fs.readFileSync(path.join(runtime,'runtime.json'),'utf8')).profile.processIdentityVersion||0;
 const identities=await require('../src/modules/android/process-channel').processNamespace(temporary,identityVersion);
 const fixture=path.join(__dirname,'fixtures/android-window-session'),cp=[temporary,path.join(runtime,'android-host.jar'),path.join(runtime,'android-framework.jar')].join(path.delimiter);
 function run(program,args){const r=java.spawnSync(program,args,{env:{...process.env,...identities.environment},encoding:'utf8',timeout:15000,maxBuffer:2<<20});assert.equal(r.error,undefined,(r.error?.message||'')+'\n'+r.stdout+r.stderr);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;}
 const native=path.join(temporary,'queue.dylib');run('clang',['-std=c11','-dynamiclib','-Wall','-Wextra','-Werror','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(fixture,'ndk-choreographer-queue.c'),'-o',native]);
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixture,'RuntimeFixture.java'),path.join(fixture,'NdkChoreographerQueueProbe.java')]);
 assert.match(run(path.join(home,'bin/java'),['-Xcheck:jni','-cp',cp,'NdkChoreographerQueueProbe',runtime,path.join(temporary,'data'),native]),/PASS native Choreographer callbacks share original Java HandlerThread ALooper/);
});
