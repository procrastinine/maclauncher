const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('native storage images share actual ANGLE pixels and retain sibling lifetime',t=>{
 const provider=process.env.ANDROID_ANGLE_PROVIDER,headers=process.env.ANDROID_ANGLE_HEADERS;
 if(process.platform!=='darwin'||!provider||!headers)return t.skip('Requires macOS and the actual ANGLE provider');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-image-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const binary=path.join(root,'probe');
 run('clang++',['-std=c++20','-fobjc-arc','-I'+headers,'-Isrc/modules/android/native','tests/fixtures/android-egl-window/NativeImageProbe.mm','-framework','Foundation','-framework','Metal','-framework','IOSurface','-o',binary]);
 assert.match(run(binary,[path.resolve(provider)]),/PASS actual ANGLE native storage images, alpha, pixels and sibling lifetime/);
});
test('EGL window identity survives buffer resizing and all swap entrypoints use presentation',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires macOS IOSurface');
 const source=path.resolve(__dirname,'../src/modules/android/native'),headers=process.env.ANDROID_GLES_HEADERS||path.resolve(__dirname,'../src/external/maclauncher-android/src/external/android-gles-headers');
 if(!fs.existsSync(headers+'/include/EGL/egl.h'))return t.skip('Requires pinned EGL headers');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-egl-window-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {generateEglSurfaceForward}=await import('../src/modules/android/native/egl-surface-forward.mjs');
 const {prepareGlesGuestAbi}=await import('../src/modules/android/native/gles-guest-abi.mjs');const abi=prepareGlesGuestAbi(headers,root);
 const methods=generateEglSurfaceForward(headers,path.join(root,'egl-surface-forward.h'));assert.ok(methods.includes('eglQuerySurface'));assert.ok(methods.includes('eglSwapBuffersWithDamageEXT'));
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:30000});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const home=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim();
 run('clang++',['-std=c++20','-fobjc-arc','-I'+source,'-I'+root,'-I'+headers+'/include','-I'+home+'/include','-I'+home+'/include/darwin','-framework','IOSurface','-framework','CoreFoundation',path.join(__dirname,'fixtures/android-egl-window/WindowSurfaceProbe.mm'),abi,'-o',root+'/probe']);
 assert.match(run(root+'/probe',[]),/PASS persistent EGL identity/);
});

test('Opaque Android EGL configurations use actual ANGLE RGBX rendering',async t=>{
 if(process.platform!=='darwin'||!process.env.KLEPTON_NATIVE_RUNTIME)return t.skip('Requires macOS and KLEPTON_NATIVE_RUNTIME');
 const source=path.resolve(__dirname,'../src/modules/android/native'),headers=process.env.ANDROID_GLES_HEADERS||path.resolve(__dirname,'../src/external/maclauncher-android/src/external/android-gles-headers');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-egl-rgb-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {generateEglSurfaceForward}=await import('../src/modules/android/native/egl-surface-forward.mjs');generateEglSurfaceForward(headers,path.join(root,'egl-surface-forward.h'));
 const {prepareGlesGuestAbi}=await import('../src/modules/android/native/gles-guest-abi.mjs');const abi=prepareGlesGuestAbi(headers,root);
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:30000});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const home=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim();
 run('clang++',['-std=c++20','-fobjc-arc','-I'+source,'-I'+root,'-I'+headers+'/include','-I'+home+'/include','-I'+home+'/include/darwin','-framework','IOSurface','-framework','CoreFoundation',path.join(__dirname,'fixtures/android-egl-window/OpaqueConfigProbe.mm'),abi,'-o',root+'/probe']);
 assert.match(run(root+'/probe',[path.resolve(process.env.KLEPTON_NATIVE_RUNTIME,'native/angle')]),/PASS RGB config selection, stable identity and actual ANGLE opaque rendering/);
});

test('RGB565 default framebuffers retain native channel precision and MSAA',t=>{
 const provider=process.env.ANDROID_ANGLE_PROVIDER||(process.env.KLEPTON_NATIVE_RUNTIME&&path.resolve(process.env.KLEPTON_NATIVE_RUNTIME,'native/angle'));
 if(process.platform!=='darwin'||!provider)return t.skip('Requires macOS and an adapted ANGLE provider');
 const source=path.resolve(__dirname,'../src/modules/android/native'),headers=process.env.ANDROID_GLES_HEADERS||path.resolve(__dirname,'../src/external/maclauncher-android/src/external/android-gles-headers');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-egl-rgb565-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:30000});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('clang++',['-std=c++20','-fobjc-arc','-I'+headers+'/include','-framework','Foundation','-framework','IOSurface',path.join(__dirname,'fixtures/android-egl-window/Rgb565Probe.mm'),'-o',root+'/probe']);
 assert.match(run(root+'/probe',[path.resolve(provider)]),/PASS actual ANGLE RGB565 default framebuffer, packed IOSurface, alpha and MSAA/);
});
