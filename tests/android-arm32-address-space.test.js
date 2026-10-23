const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('ARM32 free ranges retain original placement through allocation churn',t=>{
  const boost=process.env.ANDROID_BOOST_INCLUDE||'/opt/homebrew/include';
  if(!fs.existsSync(path.join(boost,'boost/multi_index_container.hpp')))return t.skip('Requires the Boost headers used by the ARM32 component');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-ranges-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const root=path.resolve(__dirname,'..'),binary=path.join(directory,'probe');
  const compile=spawnSync(process.env.CXX||'clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+path.join(root,'src/modules/android/native/arm32'),'-I'+boost,path.join(__dirname,'fixtures/android-arm32/address-space-probe.cpp'),'-o',binary],{encoding:'utf8',timeout:60000});
  assert.ifError(compile.error);assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:30000});
  assert.ifError(run.error);assert.equal(run.status,0,run.stdout+run.stderr);
  assert.match(run.stdout,/PASS original best-fit alignment, fragmented allocation and coalesced ownership/);
});
