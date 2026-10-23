const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('Android CPU queries use actual Darwin thread CPU identity',t=>{
  if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires Apple Silicon macOS');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-cpu-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const binary=path.join(temp,'probe');
  const compile=spawnSync('clang',['-std=c11','-Wall','-Wextra','-Werror',
    '-I'+path.resolve(__dirname,'../src/modules/android/native'),path.join(__dirname,'fixtures/android-native/scheduling.c'),'-o',binary],{encoding:'utf8',timeout:30000});
  assert.equal(compile.status,0,compile.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS actual Darwin CPU identity/);
});
