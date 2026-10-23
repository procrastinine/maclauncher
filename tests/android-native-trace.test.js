const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');

test('complete original ATrace module uses the shared original host sink and resolver',async t=>{
  if(process.platform!=='darwin'||process.arch!=='arm64'||!process.env.AOSP_FRAMEWORK_SOURCE||!process.env.AOSP_NATIVE_SOURCE||!process.env.AOSP_SYSTEM_CORE_SOURCE)return t.skip('Requires pinned AOSP sources and Apple Silicon');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-trace-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const {prepareNativeTrace}=await import('../src/modules/android/native/binder-rpc/tracing-sources.mjs');
  const {exportSources}=await import('../src/modules/android/native/binder-rpc/build.mjs');
  const pins=require('../src/modules/android/native/source-pins.json'),source=path.join(output,'source'),sources=[],flags=[];
  const prepared=prepareNativeTrace({frameworkSource:process.env.AOSP_FRAMEWORK_SOURCE,nativeSource:process.env.AOSP_NATIVE_SOURCE,pins,source,output,sources,flags,exportSources});
  exportSources(process.env.AOSP_SYSTEM_CORE_SOURCE,pins.aospSystemCore,['libcutils/trace-host.cpp','libcutils/include/cutils/trace.h','libcutils/include/cutils/compiler.h'],path.join(source,'core'));
  assert.deepEqual(prepared.names.slice().sort(),['ATrace_beginAsyncSection','ATrace_beginSection','ATrace_endAsyncSection','ATrace_endSection','ATrace_isEnabled','ATrace_setCounter']);
  const binary=path.join(output,'probe');
  const run=(program,args)=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const native=path.resolve(__dirname,'../src/modules/android/native'),registry=path.join(output,'registry.o');
  run('clang',['-std=c11','-arch','arm64','-O2','-c',path.join(native,'native-import-registry.c'),'-o',registry]);
  run('clang++',['-I'+native,registry,'-std=c++23','-arch','arm64','-mmacosx-version-min=13.0','-O2',...flags,'-I'+path.join(source,'core/libcutils/include'),...sources,path.join(source,'core/libcutils/trace-host.cpp'),path.join(__dirname,'fixtures/android-native/trace.cpp'),'-o',binary]);
  assert.match(run(binary,[]),/PASS original ATrace/);
});
