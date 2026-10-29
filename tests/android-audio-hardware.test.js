const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('native audio hardware and committed stream progress do not wait for paced writers',async t=>{
 if(process.platform!=='darwin')return t.skip('Requires the native compiler');
 const native=path.resolve(process.env.ANDROID_NATIVE_SOURCE||'src/modules/android/native'),source=fs.readFileSync(path.join(native,'audio-pause-overlay.c'),'utf8');
 const vendor=process.env.KLEPTON_SOURCE;if(!vendor)return t.skip('Requires the pinned original Klepton mixer source');
 const body=(text,signature)=>{const begin=text.indexOf(signature);assert.ok(begin>=0,signature);let at=text.indexOf('{',begin),depth=1;for(at++;depth&&at<text.length;at++){if(text[at]==='{')depth++;else if(text[at]==='}')depth--;}assert.equal(depth,0);return text.slice(begin,at);};
 const block=name=>source.split('/* '+name+'_BEGIN */')[1].split('/* '+name+'_END */')[0];
 const code=['klj_audio_hardware_info','klj_audio_capture_hardware_info'].map(name=>body(source,'int '+name+'(')).join('\n');
 const aaudio=fs.readFileSync(path.join(native,'aaudio-overlay.c'),'utf8'),begin=aaudio.indexOf('static int64_t owned_get_frames_read(');assert.ok(begin>=0);
 const progress=aaudio.slice(begin,aaudio.indexOf('\n}',begin)+2);
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'audio-hardware-'));t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
 const pin=JSON.parse(fs.readFileSync(path.join(native,'source-pins.json'))).klepton,original=spawnSync('git',['-C',vendor,'show',pin+':runtime/media/kl_audio.c'],{encoding:'utf8'});assert.equal(original.status,0,original.stderr);assert.equal(fs.readFileSync(path.join(vendor,'runtime/media/kl_audio.c'),'utf8'),original.stdout,'Mixer bytes match their exact Git pin');
 const {prepareNativeSurfaceSources}=await import(require('node:url').pathToFileURL(path.join(native,'native-surface-sources.mjs')));prepareNativeSurfaceSources(vendor,out);
 const projected=fs.readFileSync(path.join(out,'audio-source.c'),'utf8'),mixer=[body(projected,'static int src_slot('),body(projected,'static size_t convert('),body(projected,'size_t kl_audio_write_src(').replace('size_t kl_audio_write_src(','static size_t owned_original_write_src(')].join('\n');
 const input=path.join(out,'control.c');fs.writeFileSync(input,fs.readFileSync(path.join(__dirname,'fixtures/android-native/audio-hardware/control.c.in'),'utf8').replace('/* ORIGINAL_QUERIES */',code).replace('/* ORIGINAL_PROGRESS */',progress).replace('/* ORIGINAL_PROGRESS_STATE */',block('SOURCE_PROGRESS_STATE')).replace('/* ORIGINAL_MIXER */',mixer).replace('/* ORIGINAL_PROGRESS_OPERATIONS */',block('SOURCE_PROGRESS_OPERATIONS')));
 for(const [exe,args]of[['xcrun',['clang','-std=c11','-Wall','-Wextra','-Werror','-I'+native,input,'-o',path.join(out,'control')]],[path.join(out,'control'),[]]]){const r=spawnSync(exe,args,{encoding:'utf8',timeout:10000});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.equal(r.signal,null);}
});
