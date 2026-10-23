const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const{spawnSync}=require('./helpers/android-java');
function run(program,args,options={}){const result=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20,...options});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);assert.doesNotMatch(result.stdout+result.stderr,/WARNING in native method|FATAL ERROR in native method/);return result.stdout;}
test('Complete AOSP graphics JNI uses Metal ANGLE and preserves NIO storage ownership',t=>{
 const runtime=process.env.MACLAUNCHER_ANDROID_RUNTIME;if(!runtime||process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires a built Android runtime on Apple Silicon');
 const home=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim();const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-graphics-framework-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const cp=path.join(runtime,'android-host.jar')+path.delimiter+path.join(runtime,'android-framework.jar');run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(__dirname,'fixtures/android-framework-services/NativeGlesProbe.java')]);
 assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-Xcheck:jni','-cp',temporary+path.delimiter+cp,'NativeGlesProbe',path.resolve(runtime,'native/libklepton-graphics.dylib'),path.resolve(runtime,'native/angle')]),/PASS upstream complete EGL/);
});

test('Original OpenGL utilities share the NDK Bitmap owner and complete ETC1 algorithms',t=>{
 const runtime=process.env.MACLAUNCHER_ANDROID_RUNTIME;if(!runtime||process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires a built Android runtime on Apple Silicon');
 const home=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim(),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-opengl-utilities-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const cp=path.join(runtime,'android-host.jar')+path.delimiter+path.join(runtime,'android-framework.jar');run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(__dirname,'fixtures/android-framework-services/NativeGlesProbe.java')]);
 // Original publisher Bitmap initialization uses the ordinary native-runtime
 // mode, as in NativeGraphicsProbe; the GLES-only test above retains CheckJNI.
 assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'NativeGlesProbe',path.resolve(runtime,'native/libklepton-graphics.dylib'),path.resolve(runtime,'native/angle'),'utilities']),/PASS original OpenGL utilities/);
});

test('Original input objects use publisher native event storage and the complete AOSP keyboard map',t=>{
 const runtime=process.env.MACLAUNCHER_ANDROID_RUNTIME;if(!runtime||process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires a built Android runtime on Apple Silicon');
 const home=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim();const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-input-framework-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const cp=path.join(runtime,'android-host.jar')+path.delimiter+path.join(runtime,'android-framework.jar');run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.resolve('src/modules/android/native/java/maclauncher/android/framework/FrameworkResources.java'),path.join(__dirname,'fixtures/android-framework-services/NativeInputProbe.java')]);
 const identities=path.join(temporary,'ids');fs.mkdirSync(identities,{mode:0o700});
 assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-cp',temporary+path.delimiter+cp,'NativeInputProbe',path.resolve(runtime),path.join(temporary,'data')],{env:{...process.env,KL_ANDROID_ID_DIRECTORY:identities}}),/PASS raw input native motion/);
});
