const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('ARM32 data retirement preserves code while executable changes invalidate the original JIT',t=>{
 const build=process.env.ANDROID_ARM32_BUILD;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!build)return t.skip('Requires Apple Silicon and the shared ARM32 component');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-invalidation-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const results=[];
 for(const [label,directory]of [['candidate',build],...(process.env.ANDROID_ARM32_BASELINE_BUILD?[['baseline',process.env.ANDROID_ARM32_BASELINE_BUILD]]:[])]){
  const binary=path.join(temporary,label),library=path.resolve(directory,'libandroid-arm32.dylib');
  run('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+path.resolve('src/modules/android/native/arm32'),path.resolve('tests/fixtures/android-arm32/code-invalidation.cpp'),library,'-Wl,-rpath,'+path.dirname(library),'-o',binary]);
  const output=run(binary,label==='baseline'?['baseline']:[]);
  assert.match(output,label==='baseline'?/PASS baseline ARM32 data retirement measurement/:/PASS original ARM32 data retirement, executable lifetimes, permission transitions and cache flush/);
  const result=JSON.parse(output.split('\n').find(line=>line.startsWith('{')));
  if(label==='candidate')assert.equal(result.dataInvalidations,0);else assert.equal(result.dataInvalidations,20000);
  results.push({label,...result});
 }
 t.diagnostic(JSON.stringify(results));
});
