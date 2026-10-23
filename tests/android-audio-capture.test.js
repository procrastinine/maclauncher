const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('original microphone conversion and physical lifetime have one shared owner',t=>{
 if(process.platform!=='darwin'||!process.env.ANDROID_CAPTURE_BUILD)return t.skip('Requires the generated original capture supplier');
 const build=path.resolve(process.env.ANDROID_CAPTURE_BUILD),root=path.resolve(__dirname,'../src/modules/android/native');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-audio-capture-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const capture=path.join(temporary,'capture');
 run('clang',['-std=c11','-arch','arm64','-mmacosx-version-min=13.0','-Wall','-Wextra','-Werror','-I'+root,path.join(__dirname,'fixtures/android-audio/CaptureProbe.c'),path.join(build,'audio-capture.o'),'-o',capture]);
 assert.match(run(capture,[]),/PASS original shared capture conversion, fractional carry, anti-alias state, format, exact bounds and physical lifetime/);
 const platform=path.join(temporary,'media');
 const device=path.join(temporary,'audio-device.o');run('clang',['-std=c11','-fblocks','-arch','arm64','-mmacosx-version-min=13.0','-I'+root,'-c',path.join(root,'audio-device.c'),'-o',device]);
 run('clang++',['-std=c++20','-arch','arm64','-mmacosx-version-min=13.0','-I'+root,path.join(__dirname,'fixtures/android-audio/MediaPlatformProbe.cpp'),path.join(build,'audio-capture.o'),path.join(build,'media-platform.o'),device,'-framework','Foundation','-framework','AVFoundation','-framework','CoreMedia','-framework','CoreVideo','-framework','CoreAudio','-o',platform]);
 assert.match(run(platform,[]),/PASS shared complete media family, actual device inventory, selection privacy and idempotent retirement without implicit capture/);
});

test('ART media JNI transports the complete shared family without implicit capture',t=>{
 const build=process.env.ANDROID_CAPTURE_BUILD,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!build||!home)return t.skip('Requires the generated capture supplier and Java SDK');
 const native=path.resolve(__dirname,'../src/modules/android/native'),art=path.resolve(__dirname,'../src/modules/android/art/native'),fixtures=path.join(__dirname,'fixtures/android-media-inputs');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-media-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;};
 const objects=[];for(const source of [path.join(art,'media-jni.c'),path.join(art,'media-host.c'),path.join(native,'audio-device.c'),path.join(fixtures,'art-media-transport.c')]){
  const object=path.join(temporary,path.basename(source)+'.o');objects.push(object);
  run('clang',['-std=c11','-fblocks','-arch','arm64','-mmacosx-version-min=13.0','-Wall','-Wextra','-Werror','-I'+native,'-I'+art,'-I'+home+'/include','-I'+home+'/include/darwin','-Dklj_art_host=klj_art_media_test_call','-include',path.join(fixtures,'art-media-transport.h'),'-c',source,'-o',object]);
 }
 const library=path.join(temporary,'media.dylib');run('clang++',['-dynamiclib','-arch','arm64','-mmacosx-version-min=13.0',...objects,path.join(build,'audio-capture.o'),path.join(build,'media-platform.o'),'-framework','Foundation','-framework','AVFoundation','-framework','CoreMedia','-framework','CoreVideo','-framework','CoreAudio','-o',library]);
 run(path.join(home,'bin/javac'),['-d',temporary,path.join(native,'java/maclauncher/android/media/MediaInputs.java'),path.join(fixtures,'ArtMediaTransportProbe.java')]);
 const result=run(path.join(home,'bin/java'),['-Xcheck:jni','-Dklepton.audio='+library,'-cp',temporary,'ArtMediaTransportProbe']);
 assert.match(result,/PASS complete ART media JNI packet family/);assert.doesNotMatch(result,/WARNING.*JNI|FATAL ERROR/);
});
