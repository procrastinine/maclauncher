const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('Android AAPCS64 graphics stack arguments preserve framebuffer and array texture pixels',async t=>{
 const provider=process.env.ANDROID_ANGLE_PROVIDER;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!provider)return t.skip('Requires the actual Apple Silicon ANGLE provider');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-gles-abi-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const headers=path.resolve(JSON.parse(fs.readFileSync('src/modules/android/native/gles-headers.json')).directory);
 const {prepareGlesGuestAbi}=await import('../src/modules/android/native/gles-guest-abi.mjs');
 const source=prepareGlesGuestAbi(headers,temporary),run=(cmd,args)=>{const result=spawnSync(cmd,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;};
 run('clang++',['-std=c++20','-O2','-arch','arm64','-Wall','-Wextra','-Werror','-I'+path.join(headers,'include'),source,'tests/fixtures/android-native/gles-guest-abi.cpp','tests/fixtures/android-native/gles-guest-stack.S','-o',temporary+'/probe']);
 const output=run(temporary+'/probe',[path.resolve(provider)]);assert.match(output,/PASS original AAPCS64 blit/);assert.match(output,/PASS original AAPCS64 array upload/);assert.match(output,/PASS mixed floating registers/);assert.match(output,/PASS matching signatures retain direct provider pointers/);
});
