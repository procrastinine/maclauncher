const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('Android file allocation uses real native storage without repeated reservation',t=>{
 if(process.platform!=='darwin'||process.arch!=='arm64'||!process.env.KLEPTON_NATIVE_RUNTIME)return t.skip('Requires Apple Silicon and native runtime');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-allocation-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const native=path.resolve(process.env.KLEPTON_NATIVE_RUNTIME,'native'),binary=path.join(temporary,'probe');
 const run=(program,args)=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:30000,env:{...process.env,DYLD_LIBRARY_PATH:native}});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-Wall','-Wextra','-Werror','-I'+path.resolve(__dirname,'../src/modules/android/native'),path.join(__dirname,'fixtures/android-native/file-allocation.c'),path.join(native,'libklepton-jvm.dylib'),'-o',binary]);
 const output=run(binary,[temporary]);assert.match(output,/PASS native allocation/);
 assert.match(output,/PASS adopted native-file allocation and dup preserve capability, readonly access and counter rejection/);
});
