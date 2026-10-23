const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');

test('Original complete NDK configuration and assets share Java resources and physical file windows',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,headers=process.env.ANDROID_NDK_PUBLIC_HEADERS;
 if(process.platform!=='darwin'||!runtime||!headers)return t.skip('Requires a built Android runtime and original native public headers');
 const run=(file,args)=>{const r=spawnSync(file,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const home=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim();
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-ndk-assets-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const library=path.resolve(process.env.ANDROID_NDK_ASSETS_LIBRARY||path.join(runtime,'native/libandroid-ndk-graphics.dylib'));
 const platform=path.resolve(process.env.ANDROID_NDK_PLATFORM_LIBRARY||path.join(runtime,'native/libklepton-jvm.dylib'));
 const declarations=fs.readFileSync(path.join(headers,'android/configuration.h'),'utf8');
 const scalars=[...declarations.matchAll(/int32_t\s+AConfiguration_get(\w+)\(AConfiguration\*\s*\w+\)/g)].map(m=>m[1]).filter(name=>declarations.includes('AConfiguration_set'+name+'('));
 assert.ok(scalars.length>=20);
 fs.writeFileSync(path.join(tmp,'configuration-scalar-checks.inc'),scalars.map(name=>`AConfiguration_set${name}(copy,2);CHECK(AConfiguration_get${name}(copy)==2);`).join('\n'));
 const symbols=new Set(run('nm',['-gjU',library]).trim().split('\n'));
 for(const file of ['configuration.h','asset_manager.h','asset_manager_jni.h']){
  const source=fs.readFileSync(path.join(headers,'android',file),'utf8');
  const APIs=[...source.matchAll(/^[\w *]+\b(A(?:Configuration|Asset)\w+)\([^;]*\)\s*(?:__\w+\([^;]*\)\s*)*;/gm)].map(m=>m[1]);
  assert.ok(APIs.length,file);for(const name of APIs)assert.ok(symbols.has('_'+name),name);
 }
 const fixture=path.resolve('tests/fixtures/android-native'),probe=path.join(tmp,'probe.dylib');
 run('clang',['-dynamiclib','-Wl,-headerpad_max_install_names','-std=gnu11','-mmacosx-version-min=13.0','-I'+path.resolve(headers),'-I'+tmp,'-I'+home+'/include','-I'+home+'/include/darwin',fixture+'/ndk-assets-test.c',library,'-Wl,-rpath,'+path.dirname(library),'-o',probe]);
 run('install_name_tool',['-change','@rpath/libandroid-ndk-graphics.dylib',library,probe]);
 const cp=['android-host.jar','android-framework.jar'].map(file=>path.resolve(runtime,file)).join(path.delimiter);
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',tmp,fixture+'/NdkAssetsProbe.java',path.resolve('tests/fixtures/android-framework-services/NativeResourceSupport.java')]);
 assert.match(run(home+'/bin/java',['-Xverify:all','-Dandroid.test.runtime='+path.resolve(runtime),'-cp',tmp+path.delimiter+cp,'NdkAssetsProbe',tmp,library,probe,platform]),/PASS original NDK configuration family and shared APK\/loose\/OBB asset ownership/);
});
