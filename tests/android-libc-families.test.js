const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');

test('original Bionic character/exec families share native owners and unchanged compiler inputs',async t=>{
 const bionicSource=process.env.ANDROID_BIONIC_SOURCE,klepton=process.env.KLEPTON_SOURCE,ninja=process.env.NINJA,python=process.env.PYTHON;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![bionicSource,klepton,ninja,python].every(Boolean))return t.skip('Requires pinned Bionic/Klepton sources, Ninja and Python');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-libc-families-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const {prepareNativeCtype}=await import('../src/modules/android/native/native-ctype/build.mjs'),{prepareNativeExec}=await import('../src/modules/android/native/native-exec/build.mjs');
 const request={bionicSource,klepton,build:temporary,ninja,python};
 const ctype=prepareNativeCtype(request),exec=prepareNativeExec(request),objects=[...ctype.objects,...exec.objects];
 const timestamps=objects.map(file=>fs.statSync(file).mtimeMs);prepareNativeCtype(request);prepareNativeExec(request);assert.deepEqual(objects.map(file=>fs.statSync(file).mtimeMs),timestamps);
 assert.ok(ctype.names.length>20);assert.ok(exec.names.includes('execvp')&&exec.names.includes('execve'));
 const va=path.join(temporary,'va.o'),probe=path.join(temporary,'probe');
 execFileSync('clang',['-O1','-c',path.resolve(klepton,'runtime/libc/kl_va.c'),'-o',va],{stdio:'pipe'});
 execFileSync('clang++',['-std=c++20','-Wall','-Wextra','-Werror',path.resolve('tests/fixtures/android-native/libc-families.cpp'),...objects,va,'-o',probe],{stdio:'pipe'});
 execFileSync(probe,[],{stdio:'pipe',timeout:15000});
});
