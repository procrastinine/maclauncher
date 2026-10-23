const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('readlink and checked variants share the guest path and directory owner',t=>{
 if(process.platform!=='darwin')return t.skip('Requires macOS');const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-readlink-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const source=path.resolve(__dirname,'../src/modules/android/native'),binary=path.join(temporary,'probe');
 for(const [command,args] of [['clang',['-std=gnu11','-Wall','-Wextra','-Werror','-I'+source,path.join(__dirname,'fixtures/android-native/readlink-family.c'),'-o',binary]],[binary,[temporary]]]){const result=spawnSync(command,args,{encoding:'utf8',timeout:10000});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);}
});
