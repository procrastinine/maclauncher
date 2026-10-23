const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('Original media message clocks retain monotonic deadlines on Darwin',async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,checkout=process.env.KLEPTON_SYSTEM_CORE||path.resolve(__dirname,'../src/external/aosp-system-core');
  if(process.platform!=='darwin'||!runtime||!fs.existsSync(path.join(checkout,'.git')))return t.skip('Requires pinned Android system/core and native build headers');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-media-clock-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const pins=require('../src/modules/android/native/source-pins.json');
  const {exportSources,prepareDarwinUtils}=await import('../src/modules/android/native/binder-rpc/build.mjs');
  exportSources(checkout,pins.aospSystemCore,['libutils/Timers.cpp','libutils/include/utils/Condition.h'],path.join(temporary,'core'));
  prepareDarwinUtils(temporary);
  const binder=path.resolve(runtime,'build/binder-rpc');
  const includes=[path.join(temporary,'core/libutils/include'),...['source/core/libutils/include','source/core/libutils/binder/include','source/native/libs/binder/liblog_stub/include','source/libbase/include'].map(file=>path.join(binder,file))];
  const binary=path.join(temporary,'media-clock');
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-Wno-unused-parameter','-Wno-sign-compare',...includes.map(file=>'-I'+file),path.join(temporary,'core/libutils/Timers.cpp'),path.join(__dirname,'fixtures/android-native/media-clock.cpp'),path.resolve(runtime,'native/libandroid-binder-rpc.dylib'),'-Wl,-rpath,'+path.resolve(runtime,'native'),'-o',binary]);
  assert.match(run(binary,[]),/PASS original libutils clocks and relative condition wait/);
});
