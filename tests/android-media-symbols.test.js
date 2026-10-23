const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');

test('Original media dispatch replaces synthetic owners and preserves only typed Mac codec devices',async t=>{
 const klepton=process.env.KLEPTON_SOURCE,av=process.env.ANDROID_AV_SOURCE,jdk=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||![klepton,av,jdk].every(Boolean))return t.skip('Requires pinned Klepton/AV sources and Java headers');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-media-symbols-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const root=path.resolve(__dirname,'../src/modules/android/native');
 const {prepareMediaSymbolSources,retireMediaDispatch}=await import(path.join(root,'media-symbol-sources.mjs'));
 const {retireAudioDispatch}=await import(path.join(root,'native-surface-sources.mjs'));
 const files=prepareMediaSymbolSources(klepton,temporary);
 const shim=retireMediaDispatch(retireAudioDispatch(fs.readFileSync(path.join(klepton,'runtime/libc/kl_shim.c'),'utf8'),'shim'),'shim');
 assert.doesNotMatch(shim,/kl_mediandk_lookup/);
 for(const file of ['runtime/jni/kl_jni_services.c','runtime/jni/kl_jni_ue4.c'])assert.doesNotMatch(fs.readFileSync(files[file],'utf8'),/kl_mediaplayer_|kl_avdec_|klj_MP14_/);
 const run=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8',timeout:60000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const library=path.join(temporary,'media-foundation');fs.mkdirSync(library);
 const core=path.join(library,'libklepton-jvm.dylib');
 const includes=['','jni','libc','gfx','xr','media','guest','diag'].map(name=>'-I'+path.join(klepton,'runtime',name));
 for(const file of ['runtime/jni/kl_jni_services.c','runtime/jni/kl_jni_ue4.c'])run('clang',['-std=gnu11','-fsyntax-only',...includes,files[file]]);
 const frameworks=['Foundation','CoreVideo','CoreMedia','VideoToolbox'].flatMap(name=>['-framework',name]);
 // Build only real production device/registry units. No Android framework
 // symbols, object layouts, service doubles or substitute JNI are provided.
 run('clang',['-std=gnu11','-mmacosx-version-min=13.0','-dynamiclib','-Wno-deprecated-declarations','-I'+temporary,...includes,files['runtime/media/kl_vtdec.c'],path.join(klepton,'runtime/kl_env.c'),path.join(root,'native-import-registry.c'),...frameworks,'-Wl,-install_name,@rpath/libklepton-jvm.dylib','-o',core]);
 const {buildMediaDevice}=await import(path.join(root,'media-foundation/build.mjs'));
 const built=buildMediaDevice({avSource:av,output:library,jdk,processLibrary:core});
 const binary=path.join(temporary,'probe');run('clang',['-Wall','-Wextra','-Werror',path.join(__dirname,'fixtures/android-native/media-device-registration.c'),'-o',binary]);
 assert.match(run(binary,[core,built.library]),/PASS typed media device imports and original framework ownership/);
});
