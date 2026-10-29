const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync,javaHome,runtimeRoot}=require('./helpers/android-java');
const root=path.resolve(__dirname,'../src/modules/android/native');
const fixture=path.join(__dirname,'fixtures/android-host-callbacks');
function run(program,args,expected=0){const result=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,expected,result.stdout+result.stderr);return result.stdout+result.stderr;}
test('Native host callback ABI is generated from actual declarations and rejects stale contracts',t=>{
 if(process.platform!=='darwin')return t.skip('macOS JNI build');
 const home=javaHome();if(!home||!runtimeRoot())return t.skip('Requires JDK 21 and a built Android runtime (KLEPTON_NATIVE_RUNTIME)');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-host-callbacks-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const asm=path.join(root,'tools/asm-9.10.1.jar'),classes=path.join(temp,'classes'),header=path.join(temp,'host-callbacks.h');
 run(path.join(home,'bin/javac'),['--release','21','-cp',asm,'-d',classes,path.join(root,'framework/HostCallbacks.java'),path.join(fixture,'CallbackOwner.java')]);
 const generate=contract=>run(path.join(home,'bin/java'),['-cp',classes+path.delimiter+asm,'HostCallbacks',contract,header,classes]);
 generate(path.join(fixture,'contract.tsv'));
 assert.doesNotMatch(fs.readFileSync(header,'utf8'),/\bjmethodID\b|\bjclass\b|\bCall\w*Method/);
 const flags=['-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),'-I'+temp];
 const library=path.join(temp,'libcallbacks.dylib');
 run('clang',['-dynamiclib',...flags,path.join(fixture,'callbacks.c'),path.join(temp,'host-callbacks.c'),'-o',library]);
 const result=run(path.join(home,'bin/java'),['-Xcheck:jni','-cp',classes,'callbacks.CallbackOwner',library]);
 assert.match(result,/PASS typed callback/);assert.doesNotMatch(result,/WARNING in native method|FATAL ERROR in native method/);
 const badReceiver=path.join(temp,'bad-receiver.c');
 fs.writeFileSync(badReceiver,'#include "host-callbacks.h"\nvoid wrong(JNIEnv*env,KLHostCallbacks*c,KLHost_callbacks_CallbackOwner_Other receiver){kl_host_value(env,c,receiver);}\n');
 assert.match(run('clang',['-fsyntax-only',...flags,badReceiver],1),/incompatible type/);
 fs.writeFileSync(badReceiver,'#include "host-callbacks.h"\nvoid wrong(JNIEnv*env,KLHostCallbacks*c,KLHost_callbacks_CallbackOwner_Other argument){kl_host_capture(env,c,argument,1); }\n');
 assert.match(run('clang',['-fsyntax-only',...flags,badReceiver],1),/incompatible type/,'Static Java object arguments must reject unrelated typed owners');
 const contract=fs.readFileSync(path.join(fixture,'contract.tsv'),'utf8');
 for(const [label,text,expected]of[
  ['descriptor',contract.replace('value\t()I','value\t()J'),/declaration is unavailable/],
  ['method',contract.replace('value\t()I','missing\t()I'),/declaration is unavailable/],
  ['staticness',contract.replace('\tstatic','\tinstance'),/staticness changed/],
  ['owner',contract.replaceAll('callbacks/CallbackOwner$Other','callbacks/Missing'),/declaring class is unavailable/]
 ]){const file=path.join(temp,label+'.tsv');fs.writeFileSync(file,text);assert.match(run(path.join(home,'bin/java'),['-cp',classes+path.delimiter+asm,'HostCallbacks',file,header,classes],1),expected);}
});
test('Owned window and scheduler call sites cannot select raw Java method IDs or invocation families',()=>{
 for(const file of ['native-host.c','window-session.mm','scheduler.c']){
  const source=fs.readFileSync(path.join(root,file),'utf8');
  assert.doesNotMatch(source,/\bjmethodID\b|\bGet\w*MethodID\b|\bCall\w*Method(?:A|V)?\b|\bRegisterNatives\b/,file);
  assert.match(source,/#include "host-callbacks.h"/,file);
 }
 const host=fs.readFileSync(path.join(root,'native-host.c'),'utf8');
 assert.match(host,/done:;[\s\S]*report_pending\(env,callbacks\);[\s\S]*klj_session_begin_close[\s\S]*kl_host_finish\([\s\S]*klj_session_quiesce/,'Close the original display/task owner while its presenter and clock remain live');
 assert.match(host,/kl_host_failure_report\(env,callbacks,kl_host_bind_KLHost_java_lang_Throwable\(env,callbacks,failure\)\);[\s\S]*ExceptionClear\(env\);\s*\(\*env\)->Throw\(env,failure\)/,'Diagnostic callback preserves the original pending throwable');
 const session=fs.readFileSync(path.join(root,'window-session.mm'),'utf8');
 assert.match(session,/~Owner\(\)\{kl_host_callbacks_release\(env,callbacks\);\}/);
 assert.match(session,/if\(status==1\)\{current=nullptr;delete s;\}/);
 for(const file of ['native-host.c','scheduler.c'])assert.doesNotMatch(fs.readFileSync(path.join(root,file),'utf8'),/kl_host_callbacks_release\s*\(/,'Borrowers must not destroy session bindings');

});
test('Session retirement preserves live owners while cancellation is incomplete and releases in order',t=>{
 if(process.platform!=='darwin')return t.skip('macOS native build');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-callback-retirement-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const executable=path.join(temp,'session');
 run('clang',['-std=c11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-I'+root,path.join(root,'session-core.c'),path.join(__dirname,'fixtures/android-window-session/session-core-test.c'),'-o',executable]);
 assert.match(run(executable,[]),/PASS .* lifecycle\/partial-failure\/owner\/three-branch\/drain\/committed-extent/);
});

test('Native display mailbox feeds Java and NDK while UI is blocked, then retires both transports',t=>{
 if(process.platform!=='darwin')return t.skip('macOS native dispatcher');
 const home=javaHome();if(!home||!runtimeRoot())return t.skip('Requires JDK 21 and a built Android runtime (KLEPTON_NATIVE_RUNTIME)');
 const framework=require('./helpers/android-java').frameworkArguments('javac',[])[1],runtime=path.dirname(framework);
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-display-transport-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const classes=path.join(temp,'classes'),asm=path.join(root,'tools/asm-9.10.1.jar');
 run(path.join(home,'bin/javac'),['--release','21','-cp',asm,'-h',temp,'-d',classes,path.join(root,'framework/HostCallbacks.java'),path.join(root,'java/maclauncher/android/bridge/FrameWakeup.java')]);
 run(path.join(home,'bin/java'),['-cp',classes+path.delimiter+asm,'HostCallbacks',path.join(root,'host-callbacks.tsv'),path.join(temp,'host-callbacks.h'),path.join(runtime,'android-host.jar'),framework]);
 const executable=path.join(temp,'scheduler-feed');
 const scheduler=process.env.KLEPTON_SCHEDULER_SOURCE||path.join(root,'scheduler.c');
 run('clang',['-std=c11','-Wall','-Wextra','-Werror','-Wno-unused-parameter','-I'+path.join(fixture,'scheduler'),'-I'+root,'-I'+temp,'-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),scheduler,path.join(fixture,'scheduler/feed.c'),'-o',executable]);
 assert.match(run(executable,[]),/PASS native display mailbox reaches Java and NDK during blocked UI/);
});
