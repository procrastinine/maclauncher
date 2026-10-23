const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
test('Android physical logging survives guest standard stream redirection and closure',t=>{
 if(process.platform!=='darwin')return t.skip('Requires Darwin native process resources');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-log-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const native=path.resolve('src/modules/android/native'),binary=path.join(directory,'probe');
 let result=spawnSync('clang',['-std=c11','-O2','-Wall','-Wextra','-Werror','-I'+native,
   path.resolve('tests/fixtures/android-native/android-log.c'),path.join(native,'android-log.c'),path.join(native,'process-ids.c'),'-o',binary],{encoding:'utf8',timeout:20000});
 assert.equal(result.status,0,result.stdout+result.stderr);
 result=spawnSync(binary,[],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/PASS Android logging survives guest stdio/);t.diagnostic(result.stdout.trim());
});
test('Delivered JVM native Android logging preserves guest stdio ownership',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 const clang=process.env.ANDROID_NDK_CLANG||process.env.ANDROID_CLANG;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime||!clang)return t.skip('Requires Apple Silicon, delivered native runtime and Android NDK compiler');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-log-loader-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const fixture=path.resolve('tests/fixtures/android-native'),library=path.join(directory,'log-guest.so'),binary=path.join(directory,'probe'),ids=path.join(directory,'ids');fs.mkdirSync(ids,{mode:0o700});
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run(clang,['-nostdlib','-shared','-fPIC','-O2','-Wall','-Wextra','-Werror',fixture+'/android-log-guest.c','-o',library]);
 run('clang',['-O2','-Wall','-Wextra','-Werror',fixture+'/android-log-loader.c','-o',binary]);
 const output=run(binary,[path.resolve(runtime,'native/libklepton-jvm.dylib'),library,ids]);assert.match(output,/PASS original Android native log write\/print/);t.diagnostic(output.trim());
});
