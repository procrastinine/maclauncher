const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('shared register decoder preserves reserved memory and FP fields in both VM projections',async t=>{
 const klepton=process.env.KLEPTON_SOURCE||path.resolve('src/external/klepton');
 if(process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(path.join(klepton,'runtime/kl_x18.c')))return t.skip('Requires Apple Silicon and original Klepton source');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-memory-fp-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {prepareX18Source,prepareX18Core}=await import('../src/modules/android/native/x18-source.mjs');
 const run=(program,args)=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 for(const [name,prepare,define]of[['jvm',prepareX18Source,'KL_X18_SOURCE'],['art',prepareX18Core,'KL_X18_CORE_SOURCE']]) {
  const output=path.join(root,name);fs.mkdirSync(output);const source=prepare(klepton,output),binary=path.join(output,'probe');
  const args=['-O1','-g','-fsanitize=address,undefined','-std=gnu11','-Wall','-Wextra','-Werror','-Wno-unused-function','-I'+output,'-I'+path.join(klepton,'runtime'),'-D'+define+'='+JSON.stringify(source),'tests/fixtures/android-native/x18-memory-fp-encoding.c'];
  if(name==='jvm')args.push(path.join(klepton,'runtime/kl_env.c'));
  run('clang',[...args,'-o',binary]);assert.match(run(binary,[]),/PASS 11 reserved memory\/FP words preserved, 30 allocated x18 forms and five SIMD operand banks retained/);
 }
});
