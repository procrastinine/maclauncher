const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('CPU affinity agrees with the existing CPU owner through native imports and raw Linux calls',t=>{
 const core=process.env.KLEPTON_NATIVE_CORE;if(process.platform!=='darwin'||process.arch!=='arm64'||!core)return t.skip('Requires Apple Silicon and a built native Android core');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-cpu-affinity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(file,args)=>{const result=spawnSync(file,args,{encoding:'utf8',timeout:10000});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run('clang',['-std=c11','-O2','-Wall','-Wextra','-Werror','-I'+path.resolve('src/modules/android/native'),path.resolve('tests/fixtures/android-native/cpu-affinity.c'),'-o',root+'/probe']);
 assert.match(run(root+'/probe',[path.resolve(core)]),/PASS shared LP32\/LP64 CPU masks/);
});
