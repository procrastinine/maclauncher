const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('Dynamic JNI ownership publishes without guest-loader locks and permits worker class definition during JNI_OnLoad',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime||!home)return t.skip('Requires Apple Silicon, Java 21 and KLEPTON_NATIVE_RUNTIME');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-dynamic-native-'));t.after(()=>fs.rmSync(tmp,{force:true,recursive:true}));
 const source=path.resolve(__dirname,'../src/modules/android/native'),fixture=path.join(__dirname,'fixtures/android-dynamic-native');
 const cp=[path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:1024*1024});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,[result.signal,result.stdout,result.stderr].filter(Boolean).join('\n'));return result;};
 fs.mkdirSync(tmp+'/native');fs.mkdirSync(tmp+'/empty');
 require('./fixtures/android-dynamic-native/make-elf.cjs')(tmp+'/native/libdynamic.so');
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',tmp+'/host',...['GuestNativeLoader','DynamicGuestNativeLoader','NativeBinding','GuestNativeEntry'].map(name=>source+'/java/maclauncher/android/bridge/'+name+'.java'),...['HostDigests','DynamicDex','framework/HostDexFiles','framework/HostPackages'].map(name=>source+'/java/maclauncher/android/'+name+'.java'),fixture+'/DynamicNativeProbe.java',fixture+'/../android-window-session/RuntimeFixture.java']);
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',tmp+'/module',...['NativeChild','Marker','Late'].map(name=>fixture+'/'+name+'.java')]);
 run(home+'/bin/jar',['--create','--file',tmp+'/app.jar','-C',tmp+'/empty','.']);run(home+'/bin/jar',['--create','--file',tmp+'/module.jar','-C',tmp+'/module','.']);
 run('clang',['-dynamiclib','-I'+home+'/include','-I'+home+'/include/darwin',fixture+'/native.c','-o',tmp+'/probe.dylib']);
 const result=run(home+'/bin/java',['-Xcheck:jni','-Xverify:all','-cp',tmp+'/host'+path.delimiter+cp,'DynamicNativeProbe',path.resolve(runtime,'native/libklepton-jvm.dylib'),path.resolve(process.env.KLEPTON_NATIVE_BINDING||path.join(runtime,'native/libnativebinding.dylib')),tmp+'/probe.dylib',tmp+'/native',tmp+'/app.jar',tmp+'/module.jar']);
 assert.match(result.stdout,/PASS actual dynamic JNI owner/);assert.doesNotMatch(result.stderr,/WARNING in native method|FATAL ERROR in native method/);
});
