const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('original zlib initialization sizes describe the converted stream in both widths',t=>{
 const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!generated)return t.skip('Requires the shared ARM32 component and generated original declarations');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-zlib-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const native=path.resolve('src/modules/android/native/arm32'),binary=path.join(temporary,'zlib-stream');
 const run=(c,args)=>{const r=spawnSync(c,args,{encoding:'utf8',timeout:60000});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+native,'-I'+path.resolve(generated),'-I'+path.resolve(generated,'..'),'-I'+path.resolve(generated,'../format'),'-I'+path.resolve(generated,'../syscalls'),'-DARM32_IMPORTS_SOURCE="'+path.join(native,'native-imports.cpp')+'"',path.resolve('tests/fixtures/android-arm32/zlib-stream.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-lffi','-lz','-Wl,-rpath,'+path.resolve(build),'-o',binary]);
 assert.match(run(binary,[]),/PASS original zlib five initialization ABIs/);
});
