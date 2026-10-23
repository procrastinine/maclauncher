const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('complete original Bionic search family retains one representation owner',async t=>{
  if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires macOS arm64');
  const bionicSource=process.env.ANDROID_BIONIC_SOURCE;if(!bionicSource)return t.skip('Set pinned Bionic source');
  const build=fs.mkdtempSync(path.join(os.tmpdir(),'android-search-'));t.after(()=>fs.rmSync(build,{recursive:true,force:true}));
  const {prepareNativeSearch}=await import('../src/modules/android/native/native-search/build.mjs');
  const result=prepareNativeSearch({bionicSource,build});
  function run(command,args){const value=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.equal(value.error,undefined,value.error?.message);assert.equal(value.status,0,value.stdout+value.stderr);return value.stdout;}
  const binary=path.join(build,'probe');
  run('clang',['-O2','-I'+result.include,'-include',result.annotations,'-include',path.join(result.output,'namespace.h'),path.join(__dirname,'fixtures/android-native-search/probe.c'),...result.objects,'-o',binary]);
  assert.match(run(binary,[]),/PASS complete original search family/);
  assert.equal(result.names.length,15);
  const defined=run('nm',['-gU',...result.objects]);
  for(const name of result.names)assert.match(defined,new RegExp('\\b_klj_search_'+name+'\\b'));
});
