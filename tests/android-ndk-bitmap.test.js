const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');

test('Original guest NDK bitmap APIs share the original Java graphics owner',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME,
   headers=process.env.ANDROID_NDK_HEADERS,linker=process.env.ANDROID_ARM32_ELF_LINKER;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![runtime,home,headers,linker].every(Boolean))
   return t.skip('Requires the original Android runtime, NDK headers, Java21 and ELF linker');
 const library=path.resolve(runtime,'android-root/system/lib64/libjnigraphics.so');
 assert.ok(fs.existsSync(library),'The runtime contains the original libjnigraphics product');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'android-ndk-bitmap-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const fixture=path.resolve(__dirname,'fixtures/android-native');
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const object=path.join(dir,'bitmap.o'),image=path.join(dir,'libbitmapprobe.so');
 run('clang',['--target=aarch64-linux-android36','-std=c11','-fPIC','-O1','-Wall','-Wextra','-Werror',
   '-isystem',headers,'-isystem',path.join(headers,'aarch64-linux-android'),
   '-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),
   '-c',path.join(fixture,'ndk-bitmap.c'),'-o',object]);
 // Only the test client is compiled here. All bitmap implementations and
 // dependencies are the normal original component products.
 run(linker,['-flavor','gnu','-shared','--hash-style=both','-soname','libbitmapprobe.so','-o',image,object,library]);
 const cp=[dir,...['android-host.jar','android-framework.jar'].map(file=>path.resolve(runtime,file))].join(path.delimiter);
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',dir,path.join(fixture,'NdkBitmapProbe.java'),path.join(fixture,'../android-window-session/RuntimeFixture.java')]);
 const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');
 assert.match(run(path.join(home,'bin/java'),[...frameworkJvmOptions,'-Xverify:all','-Xcheck:jni','-cp',cp,
   'maclauncher.android.NdkBitmapProbe',path.resolve(runtime),path.join(dir,'data'),image]),/PASS original NDK Bitmap/);
});
