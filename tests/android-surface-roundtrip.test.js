const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('ANativeWindow_toSurface shares the original consumer through native reference retirement',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, Java21 and KLEPTON_NATIVE_RUNTIME');
 const source=path.resolve(__dirname,'../src/modules/android/native'),fixtures=path.join(__dirname,'fixtures/android-native'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-surface-roundtrip-'));
 t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const env={...process.env},run=(exe,args)=>{const r=spawnSync(exe,args,{env,encoding:'utf8',timeout:20000,maxBuffer:4<<20});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout+r.stderr;};
 const handles=path.join(tmp,'handles.o'),library=path.join(tmp,'surface-roundtrip.dylib'),includes=['-I'+source,'-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin')];
 run('clang',['-std=c11','-O2','-mmacosx-version-min=13.0',...includes,'-c',path.join(source,'framework-native-handle.c'),'-o',handles]);
 run('clang++',['-std=c++17','-O2','-fobjc-arc','-mmacosx-version-min=13.0','-dynamiclib',...includes,path.join(fixtures,'surface-roundtrip.mm'),handles,path.resolve(runtime,'native/libklepton-graphics.dylib'),'-Wl,-rpath,'+path.resolve(runtime,'native'),'-framework','Foundation','-framework','IOSurface','-o',library]);
 const cp=[tmp,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',tmp,path.join(source,'java/maclauncher/android/framework/HostSurface.java'),path.join(source,'java/maclauncher/android/framework/HostNativeHandle.java'),path.join(source,'java/maclauncher/android/bridge/NativeSurface.java'),path.join(fixtures,'SurfaceRoundTripProbe.java')]);
 const result=run(path.join(home,'bin/java'),['-Xverify:all','-Xcheck:jni','-cp',cp,'SurfaceRoundTripProbe',path.resolve(runtime),path.join(tmp,'data'),library]);
 assert.match(result,/PASS original ANativeWindow\/Surface roundtrip/);
 assert.doesNotMatch(result,/FATAL ERROR in native method/);
});
