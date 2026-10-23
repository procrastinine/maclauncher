const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const fixture=path.join(__dirname,'fixtures/android-native');
const run=(file,args)=>{const r=spawnSync(file,args,{encoding:'utf8',timeout:60000,maxBuffer:2<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
function workspace(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-image-relro-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function guest(root,linker,width,alignment){
 const object=path.join(root,'guest.o'),library=path.join(root,'guest.so');
 run('clang',['--target='+ (width===64?'aarch64-linux-android23':'armv7a-linux-androideabi23'),'-fPIC','-ffreestanding','-fno-stack-protector','-fno-unwind-tables','-O2','-c',path.join(fixture,'image-relro-guest.c'),'-o',object]);
 run(linker,['-flavor','gnu','-shared','-z','now','--hash-style=both','-z','max-page-size='+alignment,'-T',path.join(fixture,'image-relro.ld'),object,'-o',library]);return library;
}
test('ELF64 seals GNU_RELRO between relocation and constructors',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,linker=process.env.ANDROID_ARM32_ELF_LINKER;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime||!linker)return t.skip('Requires Apple Silicon, native Android runtime and ELF linker');
 const root=workspace(t),probe=path.join(root,'probe');run('clang',['-O2','-Wall','-Wextra','-Werror',path.join(fixture,'image-relro.c'),'-o',probe]);
 for(const alignment of [4096,16384,65536])assert.match(run(probe,[path.resolve(runtime,'native/libklepton-jvm.dylib'),guest(root,linker,64,alignment)]),/PASS ELF64 relocation precedes read-only constructors/);
});
test('ELF32 seals GNU_RELRO through the original guest page owner',t=>{
 const build=process.env.ANDROID_ARM32_BUILD,linker=process.env.ANDROID_ARM32_ELF_LINKER;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!linker)return t.skip('Requires Apple Silicon, ARM32 component and ELF linker');
 const root=workspace(t),probe=path.join(root,'probe'),library=path.resolve(build,'libandroid-arm32.dylib');
 run('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+path.resolve(__dirname,'../src/modules/android/native/arm32'),path.join(__dirname,'fixtures/android-arm32/image-relro.cpp'),library,'-Wl,-rpath,'+path.dirname(library),'-o',probe]);
 assert.match(run(probe,[guest(root,linker,32,4096)]),/PASS ELF32 relocation precedes read-only constructors/);
});
