const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('original Android siginfo tagged unions cross the shared LP32/LP64 adapter',async t=>{
 const build=process.env.ANDROID_ARM32_BUILD,generated=process.env.ANDROID_ARM32_IMPORTS,ndk=process.env.ANDROID_NDK;
 if(process.platform!=='darwin'||!build||!generated||!ndk)return t.skip('Requires the original NDK and existing ARM32 component');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-siginfo-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const bin=path.resolve(ndk,'toolchains/llvm/prebuilt/darwin-x86_64/bin'),include=path.resolve(bin,'../sysroot/usr/include');
 const run=(cmd,args)=>{let r=spawnSync(cmd,args,{encoding:'utf8',timeout:60000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const {generateSignalAbi}=await import('../src/modules/android/native/arm32/signal-abi.mjs');
 generateSignalAbi({include,output:tmp,clang:path.join(bin,'clang')});
 for(const [side,target]of [['guest','armv7a-linux-androideabi36'],['host','aarch64-linux-android36']]){
  run(path.join(bin,'clang'),['--target='+target,'-c',path.resolve(__dirname,'fixtures/android-arm32/signal-info-layout.c'),'-o',path.join(tmp,side+'.o')]);
  run(path.join(bin,'llvm-objcopy'),['--dump-section','.rodata='+path.join(tmp,side+'.bin'),path.join(tmp,side+'.o')]);
 }
 const native=path.resolve(__dirname,'../src/modules/android/native/arm32'),binary=path.join(tmp,'probe');
 run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+native,'-I'+tmp,'-I'+path.resolve(generated),'-I'+path.resolve(generated,'../format'),'-I'+path.resolve(generated,'../syscalls'),'-DARM32_IMPORTS_SOURCE="'+path.join(native,'native-imports.cpp')+'"',path.resolve(__dirname,'fixtures/android-arm32/signal-info-probe.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-lffi','-Wl,-rpath,'+path.resolve(build),'-o',binary]);
 assert.match(run(binary,[path.join(tmp,'guest.bin'),path.join(tmp,'host.bin')]),/PASS original Android signal union families/);
});
