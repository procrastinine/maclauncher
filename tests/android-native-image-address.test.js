const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
test('dladdr retains actual provider ownership across guest and native mappings',t=>{
 const ndk=process.env.ANDROID_NDK_ROOT,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 const core=process.env.KLEPTON_NATIVE_LIBRARY||(runtime&&path.resolve(runtime,'native/libklepton-jvm.dylib'));
 if(process.platform!=='darwin'||process.arch!=='arm64'||!ndk||!core)return t.skip('Requires Apple Silicon, the selected Android NDK and native runtime');
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'android-image-address-'));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const run=(program,args)=>execFileSync(program,args,{encoding:'utf8',timeout:30000});
 const guest=path.join(work,'libguest.so'),compiler=path.join(ndk,'toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android23-clang');
 run(compiler,['-shared','-nostdlib','-O1',path.join(__dirname,'fixtures/android-native/image-identity-guest.c'),'-o',guest]);
 const binary=path.join(work,'address');run('clang',['-std=c11','-Wall','-Wextra','-Werror',path.join(__dirname,'fixtures/android-native/image-address.c'),'-o',binary]);
 assert.match(run(binary,[path.resolve(core),guest]),/PASS dladdr retains guest ELF ownership and exact Darwin provider metadata/);
});
