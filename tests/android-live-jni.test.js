const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Live named-image JNI lookup retains explicit native registration and retries only library/class changes',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME,binding=process.env.KLEPTON_NATIVE_BINDING,jar=process.env.KLEPTON_NATIVE_HOST_JAR,prepared=process.env.ANDROID_LIVE_JNI_PREPARED==='1';
 if(process.platform!=='darwin'||process.arch!=='arm64'||![runtime,home,binding,jar].every(Boolean))return t.skip('Requires Apple Silicon Android runtime, binding, host JAR and Java21');
 const parent=process.env.ANDROID_LIVE_JNI_OUTPUT,root=fs.mkdtempSync(path.join(parent?path.resolve(parent):os.tmpdir(),'android-live-jni-'));if(!parent)t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const fixture=path.resolve(__dirname,'fixtures/android-native/live-jni'),view=root+'/runtime';fs.mkdirSync(view);fs.mkdirSync(root+'/native');fs.mkdirSync(root+'/host');fs.mkdirSync(root+'/guest');
 function linkTree(src,dst){fs.mkdirSync(dst,{recursive:true});for(const e of fs.readdirSync(src,{withFileTypes:true})){const from=path.join(src,e.name),to=path.join(dst,e.name);if(e.isDirectory())linkTree(from,to);else if(e.isSymbolicLink())fs.symlinkSync(fs.readlinkSync(from),to);else fs.linkSync(from,to);}}
 linkTree(path.resolve(runtime),view);
 const replace=(src,dst)=>{fs.unlinkSync(dst);fs.linkSync(path.resolve(src),dst);};replace(binding,view+'/native/libnativebinding.dylib');replace(jar,view+'/android-host.jar');
 if(process.env.KLEPTON_NATIVE_CORE)replace(process.env.KLEPTON_NATIVE_CORE,view+'/native/libklepton-jvm.dylib');
 const cp=[view+'/android-host.jar',view+'/android-framework.jar'].join(path.delimiter);
 const run=(file,args,env)=>spawnSync(file,args,{env,encoding:'utf8',timeout:25000,maxBuffer:2<<20});const pass=(file,args,env)=>{const r=run(file,args,env);assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 require('./fixtures/android-native/live-jni/make-elf.cjs')(root+'/native/liblive-jni.so');
 pass(home+'/bin/javac',['--release','21','-cp',cp,'-d',root+'/host',fixture+'/LiveNativeProbe.java',path.resolve(__dirname,'fixtures/android-window-session/RuntimeFixture.java')]);
 if(prepared)pass(home+'/bin/javac',['--release','21','-cp',cp,'-d',root+'/host',path.resolve(process.env.KLEPTON_NATIVE_SOURCE||'src/modules/android/native','java/maclauncher/android/bridge/GuestNativeEntry.java')]);
 pass(home+'/bin/javac',['--release','21','-cp',cp,'-d',root+'/guest',fixture+'/Probe.java',fixture+'/Parent.java',fixture+'/Delayed.java',fixture+'/Disposable.java']);pass(home+'/bin/jar',['--create','--file',root+'/guest.jar','-C',root+'/guest','.']);
 pass('/usr/bin/clang',['-dynamiclib','-O1','-Wall','-Wextra','-Werror','-I'+home+'/include','-I'+home+'/include/darwin',fixture+'/owner.c','-o',root+'/owner.dylib']);
 const env={...process.env,...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment,DYLD_FRAMEWORK_PATH:view+'/native'};
 const args=['-Xcheck:jni','-Xverify:all','-Xlog:class+unload=info','-cp',root+'/host'+path.delimiter+cp,'LiveNativeProbe',view,view+'/native/libnativebinding.dylib',root+'/owner.dylib',root+'/native',root+'/guest.jar',root+'/data'];
 if(prepared)args.push('prepared');
 else if(process.env.ANDROID_LIVE_JNI_EXPECT_BASELINE==='1')args.push('baseline');
 if(process.env.ANDROID_LIVE_JNI_REGRESSION)args.push('regression='+process.env.ANDROID_LIVE_JNI_REGRESSION);
 const result=run(home+'/bin/java',args,env);fs.writeFileSync(root+'/stdout.log',result.stdout??'');fs.writeFileSync(root+'/stderr.log',result.stderr??'');
 fs.writeFileSync(root+'/PROCESS.json',JSON.stringify({pid:result.pid,status:result.status,signal:result.signal,prepared,regression:process.env.ANDROID_LIVE_JNI_REGRESSION||null})+'\n');
 assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);
 if(process.env.ANDROID_LIVE_JNI_EXPECT_BASELINE==='1'){assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,/UnsatisfiedLinkError:.*owned.live.Probe.value/);}
 else if(process.env.ANDROID_LIVE_JNI_EXPECT_REGRESSION){assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,process.env.ANDROID_LIVE_JNI_EXPECT_REGRESSION==='prefix'?/automatic lookup replaced a successful explicit prefix/:/subclass unload lost explicit parent registration/);}
 else{assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS real ELF mutable JNI names/);if(process.env.ANDROID_LIVE_JNI_REGRESSION!=='prefix')assert.match(result.stdout,/unloading class owned\.live\.Disposable\b/);assert.doesNotMatch(result.stderr,/WARNING in native method|FATAL ERROR in native method/);}
 t.diagnostic('Evidence '+root);
});
