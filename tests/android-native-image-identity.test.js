const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const native=path.resolve(__dirname,'../src/modules/android/native'),fixtures=path.join(__dirname,'fixtures/android-native');
function run(command,args){return execFileSync(command,args,{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});}
function compiler(ndk,target){return path.join(ndk,'toolchains/llvm/prebuilt/darwin-x86_64/bin',target+'23-clang');}
function library(ndk,target,file,soname){run(compiler(ndk,target),['-shared','-nostdlib','-O1','-Wl,-soname,'+soname,path.join(fixtures,'image-identity-guest.c'),'-o',file]);}
test('ELF image identity reads original width-correct dynamic metadata',t=>{
 const ndk=process.env.ANDROID_NDK_ROOT;if(process.platform!=='darwin'||!ndk)return t.skip('Requires the selected Android NDK');
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'android-image-identity-'));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const files=['aarch64-linux-android','armv7a-linux-androideabi'].map((target,index)=>{const file=path.join(work,'image'+index+'.so');library(ndk,target,file,'libdeclared.so');return file;});
 // Program headers alone supply identity, including a sectionless ELF.
 const stripped=path.join(work,'sectionless.so'),bytes=fs.readFileSync(files[0]);bytes.fill(0,40,48);bytes.fill(0,58,64);fs.writeFileSync(stripped,bytes);
 const binary=path.join(work,'identity');run('clang',['-std=c11','-Wall','-Wextra','-Werror','-I'+native,path.join(fixtures,'image-identity.c'),'-o',binary]);
 assert.match(run(binary,[...files,stripped]),/PASS ELF32\/ELF64 immutable SONAME/);
});
test('shared native loader resolves SONAME aliases without fresh NOLOAD mapping',t=>{
 const ndk=process.env.ANDROID_NDK_ROOT,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 const core=process.env.KLEPTON_NATIVE_LIBRARY||(runtime&&path.resolve(runtime,'native/libklepton-jvm.dylib'));
 if(process.platform!=='darwin'||process.arch!=='arm64'||!ndk||!core)return t.skip('Requires Apple Silicon, the selected Android NDK and native runtime');
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'android-image-loader-'));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const image=path.join(work,'libdifferent.so');library(ndk,'aarch64-linux-android',image,'libdeclared.so');
 library(ndk,'aarch64-linux-android',path.join(work,'libnotloaded.so'),'libnotloaded.so');
 const binary=path.join(work,'loader');run('clang',['-std=c11','-Wall','-Wextra','-Werror',path.join(fixtures,'image-identity-loader.c'),'-o',binary]);
 assert.match(run(binary,[path.resolve(core),work,image]),/PASS SONAME and filename share one image/);
});
