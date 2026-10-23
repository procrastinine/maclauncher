const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('Audio recovery rechecks device health and serializes competing owners',async t=>{
 if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires Apple Silicon native audio');
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,vendor=process.env.KLEPTON_SOURCE;
 if(!runtime||!vendor||!fs.existsSync(path.join(vendor,'runtime/media/kl_audio.c')))return t.skip('Requires KLEPTON_NATIVE_RUNTIME and KLEPTON_SOURCE with the pinned Klepton sources');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-audio-recovery-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const source=path.resolve(__dirname,'../src/modules/android/native');
 const {prepareNativeSurfaceSources}=await import(require('node:url').pathToFileURL(path.join(source,'native-surface-sources.mjs')));
 prepareNativeSurfaceSources(vendor,temporary);
 const binary=path.join(temporary,'probe'),native=path.resolve(runtime,'native');
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:10000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('clang',['-std=gnu11','-O1','-ffunction-sections','-fdata-sections','-Wl,-dead_strip','-Wl,-rpath,'+native,'-I'+source,...['runtime','runtime/media','runtime/libc'].map(part=>'-I'+path.join(vendor,part)),'-DKLEPTON_AUDIO_PAUSE_SOURCE='+JSON.stringify(path.join(temporary,'audio-source.c')),path.join(__dirname,'fixtures/android-audio/AudioRecoveryProbe.c'),'-framework','AudioToolbox','-framework','CoreAudio',path.join(native,'libklepton-jvm.dylib'),'-o',binary]);
 assert.match(run(binary,[]),/PASS audio recovery serializes owners/);
});
