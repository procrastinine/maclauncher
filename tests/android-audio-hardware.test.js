const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('native audio hardware queries report adopted PCM only while its owner is live',t=>{
 if(process.platform!=='darwin')return t.skip('Requires the native compiler');
 const native=path.resolve(process.env.ANDROID_NATIVE_SOURCE||'src/modules/android/native'),source=fs.readFileSync(path.join(native,'audio-pause-overlay.c'),'utf8');
 const code=['klj_audio_hardware_info','klj_audio_capture_hardware_info'].map(name=>{const begin=source.indexOf('int '+name+'(');assert.ok(begin>=0);return source.slice(begin,source.indexOf('\n}',begin)+2);}).join('\n');
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'audio-hardware-'));t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
 const input=path.join(out,'control.c');fs.writeFileSync(input,fs.readFileSync(path.join(__dirname,'fixtures/android-native/audio-hardware/control.c.in'),'utf8').replace('/* ORIGINAL_QUERIES */',code));
 for(const [exe,args]of[['xcrun',['clang','-std=c11','-Wall','-Wextra','-Werror','-I'+native,input,'-o',path.join(out,'control')]],[path.join(out,'control'),[]]]){const r=spawnSync(exe,args,{encoding:'utf8',timeout:10000});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.equal(r.signal,null);}
});
