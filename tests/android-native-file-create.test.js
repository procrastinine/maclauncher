const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
test('creat and creat64 retain the existing native openat owner',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,core=process.env.KLEPTON_NATIVE_LIBRARY||(runtime&&path.resolve(runtime,'native/libklepton-jvm.dylib'));
 if(process.platform!=='darwin'||process.arch!=='arm64'||!core)return t.skip('Requires Apple Silicon and the native Android runtime');
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'android-file-create-'));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const binary=path.join(work,'create'),run=(program,args)=>execFileSync(program,args,{encoding:'utf8',timeout:30000});
 run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-Wall','-Wextra','-Werror','-I'+path.resolve(__dirname,'../src/modules/android/native'),path.join(__dirname,'fixtures/android-native/file-create.c'),path.resolve(core),'-Wl,-rpath,'+path.dirname(path.resolve(core)),'-o',binary]);
 assert.match(run(binary,[work]),/PASS creat\/creat64 share openat pathname/);
});
