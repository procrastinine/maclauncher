const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('./helpers/android-java');
const source=path.resolve(__dirname,'../src/modules/android/native');
const fixtures=path.join(__dirname,'fixtures/android-window-session');
const env={...process.env};
for(const key of Object.keys(env))if(/^(DYLD_|KLEPTON_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
function run(exe,args,status=0){const r=spawnSync(exe,args,{env,encoding:'utf8',timeout:20000,maxBuffer:4<<20});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,status,r.stdout+r.stderr);assert.doesNotMatch(r.stderr,/FATAL ERROR in native method/);return r;}
const home=process.env.JAVA_HOME||(process.platform==='darwin'?spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim():null);
const runtimeArg=process.env.KLEPTON_NATIVE_RUNTIME||process.env.MACLAUNCHER_ANDROID_RUNTIME;
const runtime=runtimeArg?path.resolve(runtimeArg):null;
const nativeOptions={skip:process.platform==='darwin'?false:'Requires macOS development tools'};
const javaOptions={skip:home&&runtime&&process.platform==='darwin'?false:'Requires Java 21 and KLEPTON_NATIVE_RUNTIME'};
let temporary,classes,cp;
test.before(()=>{temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-window-session-'));});
test.after(()=>{if(temporary)fs.rmSync(temporary,{recursive:true,force:true});});
function java(name,args=[],status=0,properties=[]){return run(path.join(home,'bin/java'),['-Xcheck:jni','-Xverify:all','-Xmx256m','-Djava.awt.headless=true',
 '-Dklepton.bridge='+path.join(runtime,'native/libklepton-jvm.dylib'),'-Dklepton.audio='+path.join(runtime,'native/libklepton-audio.dylib'),'-Dklepton.graphics='+path.join(runtime,'native/libklepton-graphics.dylib'),
 ...properties,'-cp',cp,name,...args],status);}
function prepare(){
 if(classes)return;classes=path.join(temporary,'classes');fs.mkdirSync(classes);
 const framework=['android-host.jar','android-framework.jar'].map(name=>path.join(runtime,name)).join(path.delimiter);cp=classes+path.delimiter+framework;
 const names=fs.readdirSync(fixtures).filter(name=>name.endsWith('.java'));
 run(path.join(home,'bin/javac'),['--release','21','-cp',framework,'-d',classes,...names.map(name=>path.join(fixtures,name)),path.join(fixtures,'../android-native/ResourceFixtureData.java')]);

}
// Session-core cancellation/reverse-release/committed-extent assertions live in
// android-host-callbacks.test.js, alongside the generated table lifetime check.
test('Android window placement fits logical content and decorations inside the usable display',nativeOptions,()=>{
 const executable=path.join(temporary,'window-placement');run('clang',['-std=c11','-Wall','-Wextra','-Werror','-I'+source,path.join(fixtures,'window-placement-test.c'),'-o',executable]);assert.match(run(executable,[]).stdout,/PASS logical window placement/);
});
test('Android display tick mailbox coalesces concurrent publications and rejects conversion overflow',nativeOptions,()=>{
 const executable=path.join(temporary,'tick-mailbox');run('clang++',['-std=c++17','-Wall','-Wextra','-Werror','-pthread','-I'+source,path.join(fixtures,'tick-mailbox-test.cpp'),'-o',executable]);assert.match(run(executable,[]).stdout,/PASS 1000000 source ticks/);
});
test('Android native clocks preserve domain brackets and absolute deadlines',nativeOptions,()=>{
 const extra=[],bionic=process.env.ANDROID_BIONIC_SOURCE;
 if(bionic){
  // Compile the unchanged original caller with only its scalar clockid_t ABI
  // and kernel entry represented on Darwin; retain its actual errno restorer.
  const caller=path.join(temporary,'bionic-cpu-clock.cpp'),object=path.join(temporary,'bionic-cpu-clock.o');
  fs.writeFileSync(caller,'#include "native-clock/clock-domain.h"\nextern "C" int klj_original_clock_getcpuclockid(pid_t,int *);\nstatic int klj_original_clock_getres(int id,struct timespec *out){return klj_clock_resolution(id,out);}\n#define clockid_t int\n#define clock_getres klj_original_clock_getres\n#define clock_getcpuclockid klj_original_clock_getcpuclockid\n#include '+JSON.stringify(path.resolve(bionic,'libc/bionic/clock_getcpuclockid.cpp'))+'\n');
  run('clang++',['-std=c++17','-Wall','-Wextra','-Werror','-I'+source,'-I'+path.resolve(bionic,'libc'),'-I'+path.resolve(bionic,'libc/platform'),'-c',caller,'-o',object]);extra.push('-DKLJ_ORIGINAL_BIONIC_CPU',object,'-lc++');
 }
 const executable=path.join(temporary,'clock-deadline');run('clang',['-std=c11','-Wall','-Wextra','-Werror','-I'+source,path.join(fixtures,'clock-deadline-test.c'),path.join(source,'thread-identity.c'),...extra,'-o',executable]);assert.match(run(executable,[]).stdout,/PASS clock domains, strict native brackets, encoded process\/thread PROF\/VIRT\/SCHED/);
});
for(const [name,description,success] of [
 ['ChoreographerProbe','AOSP Choreographer retains original callback scheduling and native source retirement',/PASS .* Choreographer lifecycle checks/],
 ['WakeRetirementProbe','Native display wake retirement waits for synchronous signaling and releases ownership',/PASS concurrent registration\/shutdown/],
 ['DisplayProbe','AOSP display clients publish committed snapshots and retire original listener delegates',/PASS .* display snapshot\/listener\/thread\/retention/]
])test(description,javaOptions,()=>{prepare();assert.match(java(name,[runtime,path.join(temporary,name)]).stdout,success);});
test('AOSP SystemClock uses native uptime and continuous domains',javaOptions,()=>{
 prepare();const clock=path.join(temporary,'clock.dylib');run('clang',['-std=c11','-Wall','-Wextra','-Werror','-dynamiclib','-I'+source,'-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(fixtures,'clock-domain-jni.c'),path.join(runtime,'native/libklepton-jvm.dylib'),'-Wl,-rpath,'+path.join(runtime,'native'),'-o',clock]);
 assert.match(java('ClockProbe',[runtime,path.join(temporary,'clock-data')],0,['-Dclock.probe='+clock]).stdout,/JAVA_CLOCK_PASS checks=140002/);
});
