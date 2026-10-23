const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('shared register decoder preserves reserved GP data and allocated arithmetic semantics',async t=>{
 const klepton=process.env.KLEPTON_SOURCE||path.resolve('src/external/klepton');
 if(process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(path.join(klepton,'runtime/kl_x18.c')))return t.skip('Requires Apple Silicon and original Klepton source');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-gp-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {prepareX18Source}=await import('../src/modules/android/native/x18-source.mjs'),adapted=prepareX18Source(klepton,root);
 const run=(program,args)=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const cases=[[adapted,'1']];if(process.env.ANDROID_X18_ORIGINAL_SOURCE)cases.unshift([process.env.ANDROID_X18_ORIGINAL_SOURCE,'0']);
 for(const [source,fixed]of cases){const binary=path.join(root,'probe-'+fixed);run('clang',['-O2','-std=gnu11','-I'+path.dirname(source),'-I'+path.join(klepton,'runtime'),'-DKL_X18_SOURCE='+JSON.stringify(source),'tests/fixtures/android-native/x18-gp-encoding.c',path.join(klepton,'runtime/kl_env.c'),'-o',binary]);const stdout=run(binary,[fixed]);assert.match(stdout,fixed==='1'?/PASS reserved GP data preserved and 17 native arithmetic\/flag veneers preserve registers and NZCV/:/PASS previous decoder reproduced reserved GP words as translation candidates/);t.diagnostic(stdout.trim());}
});
