const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('original ART audio-HAL input transport uses the shared selected capture owner',t=>{
 if(process.platform!=='darwin')return t.skip('Requires native Mac audio interfaces');
 const root=path.resolve(__dirname,'../src/modules/android/native'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-input-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const binary=path.join(temporary,'input'),run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('clang',['-std=c11','-fblocks','-arch','arm64','-mmacosx-version-min=13.0','-Wall','-Wextra','-Werror','-I'+root,path.join(__dirname,'fixtures/android-audio/ArtInputRingProbe.c'),path.join(root,'audio-device.c'),path.join(root,'audio-pcm.c'),path.join(root,'../art/native/host-packets.c'),'-framework','CoreAudio','-framework','CoreFoundation','-o',binary]);
 assert.match(run(binary,[]),/PASS original ART input ring, explicit selection, exact I16\/float frames, restart and retirement/);
});
