const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');

test('VP8 and VP9 use shared MediaCodec ownership, original NDK APIs and NV12 Surface output',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,headers=process.env.ANDROID_NDK_HEADERS;
  if(process.platform!=='darwin'||!runtime||!headers)return t.skip('Requires macOS, KLEPTON_NATIVE_RUNTIME and ANDROID_NDK_HEADERS');
  const home=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim();
  if(!home)return t.skip('Requires Java development headers');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-media-vpx-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const run=(command,args,env)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:60000,env:env||process.env});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const source=path.resolve(__dirname,'../src/modules/android/native'),fixtures=path.join(__dirname,'fixtures/android-native');
  const include=path.join(temporary,'include/media');fs.mkdirSync(include,{recursive:true});
  fs.cpSync(path.join(path.resolve(headers),'media'),include,{recursive:true});
  const codecHeader=path.join(include,'NdkMediaCodec.h'),text=fs.readFileSync(codecHeader,'utf8');
  if(text.includes('#include <android/api-level.h>')&&!text.includes('#if defined(__ANDROID__)'))fs.writeFileSync(codecHeader,text.replace('#include <android/api-level.h>','#if defined(__ANDROID__)\n#include <android/api-level.h>\n#endif'));
  // A focused native closure shares the selected immutable images using COW;
  // it does not duplicate complete runtime/dependency trees.
  const media=process.env.ANDROID_MEDIA_LIBRARY||path.join(runtime,'native/libandroid-media.dylib');
  const binder=process.env.ANDROID_BINDER_LIBRARY||path.join(runtime,'native/libandroid-binder-rpc.dylib');
  for(const file of [media,binder,path.join(runtime,'native/libklepton-jvm.dylib')])fs.copyFileSync(file,path.join(temporary,path.basename(file)),fs.constants.COPYFILE_FICLONE);
  const encoded=JSON.parse(fs.readFileSync(path.join(fixtures,'vpx-frames.json'),'utf8'));
  for(const [name,hex] of Object.entries(encoded.frames))fs.writeFileSync(path.join(temporary,name),Buffer.from(hex,'hex'));
  const binary=path.join(temporary,'probe');run('clang++',['-std=c++23','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-I'+path.join(temporary,'include'),'-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),'-I'+path.join(source,'media-foundation'),'-I'+source,path.join(fixtures,'media-vpx.cpp'),path.join(temporary,'libandroid-media.dylib'),path.join(temporary,'libklepton-jvm.dylib'),'-framework','CoreVideo','-framework','Foundation','-Wl,-rpath,'+temporary,'-o',binary]);
  const result=run(binary,[temporary]);assert.match(result,/PASS native VP8\/VP9 media integration/);t.diagnostic(result.trim());
});
