const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const{spawnSync,javaHome,runtimeRoot}=require('./helpers/android-java');
const{spawnSync:spawnNative}=require('node:child_process');
const source=path.resolve(__dirname,'../src/modules/android/native'),fixtures=path.join(__dirname,'fixtures/android-window-session');
function run(program,args,spawn=spawnSync){const r=spawn(program,args,{encoding:'utf8',timeout:20000,maxBuffer:4<<20});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);assert.doesNotMatch(r.stdout+r.stderr,/FATAL ERROR in native method|WARNING in native method/);return r.stdout;}
test('An early launch failure exits without initializing Android again during cleanup',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;if(!runtime)return t.skip('Requires a built Android runtime');
 const home=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-host-early-exit-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const cp=[temp,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temp,path.join(source,'java/maclauncher/android/Host.java')]);
 const result=spawnSync(path.join(home,'bin/java'),['-cp',cp,'maclauncher.android.Host','--invalid'],{encoding:'utf8',timeout:10000,maxBuffer:1<<20});
 assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,1);
 assert.match(result.stderr,/IllegalArgumentException: Use --config/);
 assert.doesNotMatch(result.stderr,/Exception in thread|NoClassDefFoundError|UnsatisfiedLinkError|Secondary failure/);
});
test('WindowSession retains live callbacks and producers until the native session retires',t=>{
 if(process.platform!=='darwin')return t.skip('Requires macOS and a JDK');
 const home=javaHome(),runtime=runtimeRoot();if(!home||!runtime)return t.skip('Requires JDK 21 and a built Android runtime (KLEPTON_NATIVE_RUNTIME)');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-host-retirement-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 // Compile against the complete supplied API closure. Attachment/orientation
 // signatures retain their real types while this probe opens no physical UI.
 const cp=[temp,path.join(runtime,'android-host.jar'),path.join(runtime,'android-framework.jar')].join(path.delimiter);
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temp,path.join(source,'java/maclauncher/android/bridge/WindowSession.java'),path.join(fixtures,'HostTeardownProbe.java')],spawnNative);
 const lib=path.join(temp,'teardown.dylib');run('clang',['-std=c11','-Wall','-Wextra','-Werror','-dynamiclib','-I'+source,'-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(source,'session-core.c'),path.join(fixtures,'teardown-jni.c'),'-o',lib],spawnNative);
 assert.match(run(path.join(home,'bin/java'),['-Xcheck:jni','-Xverify:all','-cp',cp,'maclauncher.android.HostTeardownProbe',lib],spawnNative),/PASS native session retirement/);
});
test('Host validates arguments before startup and nests physical presentation lifetimes',()=>{
 const host=fs.readFileSync(path.join(source,'java/maclauncher/android/Host.java'),'utf8');
 const validation=host.indexOf('throw new IllegalArgumentException("Use --config'),startup=host.indexOf('RuntimeBootstrap.initialize(');
 assert.ok(validation>=0&&startup>validation,'invalid arguments fail before startup');
 const body=host.slice(host.indexOf('private static void run('),host.indexOf('private static Throwable keep('));
 const sequence=['RuntimeBootstrap.initialize(','HostActivity.openWindow(','HostActivity.attach(','windowSession.attachActivity(','HostActivity.start(','windowSession.present(','finally{','HostRemoteServices.shutdown()','authority.close()','finish(cleanup,task,providers,null,mainLooper,previous,windowSession)'];let previous=-1;
 for(const call of sequence){const index=body.indexOf(call);assert.ok(index>previous,'Presentation lifetime order: '+call);previous=index;}
 const retirement=host.slice(host.indexOf('private static Throwable retire('));previous=-1;
 for(const call of ['task.finish()','finishPresentation()','HostWindowManager.shutdown()','HostSurfaceTexture.shutdown()','session.stopCallbacks(','session.close()','NativeSurface.shutdownDisplayCallbacks()','HostDisplayEvents.hostShutdown()','HostDisplay.hostShutdown()','HostFileObserver.shutdown()','HostContextServices.retireApplication(','DynamicDex.hostShutdown()','HostLooper.close(looper)','HostContextServices.retireContext(','WindowSession.shutdownApplication()']){
  const index=retirement.indexOf(call);assert.ok(index>previous,'Retirement lifetime order: '+call);previous=index;
 }
 assert.match(retirement,/session\.stopCallbacks\([^\n]*\);\}\s*catch\(Throwable error\)\{return keep\(first,error\);\}/,'failed callback retirement retains dependent resources');
 assert.match(retirement,/session\.close\(\);\}catch\(Throwable error\)\{return keep\(first,error\);\}/,'failed producer retirement retains dependent resources');
 const services=fs.readFileSync(path.join(source,'java/maclauncher/android/framework/HostContextServices.java'),'utf8');
 assert.match(services,/retireContext\(Throwable first,Looper looper,AutoCloseable loader\)[\s\S]*HostLooper\.retireCallbacks\(looper\)[\s\S]*FrameworkResources::shutdown[\s\S]*loader\.close\(\)/,'context retirement drains callbacks before resources and loaders');
 assert.doesNotMatch(host,/NativeSurface\.statistics\(\)/,'Borrowed buffer counts are test diagnostics, not application shutdown failures');
});
