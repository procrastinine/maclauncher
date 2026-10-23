const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('shared ADRP veneers preserve page addresses across both signed range edges',async t=>{
 const klepton=process.env.KLEPTON_SOURCE||path.resolve('src/external/klepton');
 if(process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(path.join(klepton,'runtime/kl_x18.c')))return t.skip('Requires Apple Silicon and original Klepton source');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-adrp-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {prepareX18Source,prepareX18Core}=await import('../src/modules/android/native/x18-source.mjs');
 const run=(program,args)=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 for(const [name,prepare,define,previous]of[['jvm',prepareX18Source,'KL_X18_SOURCE',process.env.ANDROID_X18_PREVIOUS_JVM],['art',prepareX18Core,'KL_X18_CORE_SOURCE',process.env.ANDROID_X18_PREVIOUS_CORE]]) {
  const output=path.join(root,name);fs.mkdirSync(output);const current=prepare(klepton,output);
  for(const [source,adapted]of[...(previous?[[path.resolve(previous),'0']]:[]),[current,'1']]) {
   const binary=path.join(output,'probe-'+adapted),args=['-O1','-g','-std=gnu11','-Wall','-Wextra','-Werror','-Wno-unused-function','-I'+path.dirname(source),'-I'+path.join(klepton,'runtime'),'-D'+define+'='+JSON.stringify(source),'tests/fixtures/android-native/x18-adrp-edge.c'];
   if(adapted==='1')args.push('-fsanitize=address,undefined');
   if(name==='jvm')args.push(path.join(klepton,'runtime/kl_env.c'));
   run('clang',[...args,'-o',binary]);assert.match(run(binary,[adapted]),adapted==='1'?/PASS native ADRP positive\/negative edge addresses, both island directions, scratch registers and NZCV/:/PASS previous ADRP range-edge veneer rejection reproduced/);
  }
 }
});
