const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('native Android OpenSL configuration opens streams and retains actual playback callbacks',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,clang=process.env.ANDROID_NDK_CLANG;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime||!clang)return t.skip('Requires the native Android runtime and NDK compiler');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-opensl-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const fixture=path.resolve('tests/fixtures/android-native'),library=path.join(root,'probe.so'),program=path.join(root,'probe'),ids=path.join(root,'identity');fs.mkdirSync(ids,{mode:0o700});
 const run=(binary,args,extra={})=>{const r=spawnSync(binary,args,{encoding:'utf8',timeout:15000,...extra});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout+r.stderr;};
 run(clang,['-nostdlib','-mno-outline-atomics','-shared','-fPIC','-std=c11','-O2','-Wall','-Wextra','-Werror',fixture+'/opensl-configuration-guest.c','-o',library]);
 run('clang',['-O2','-Wall','-Wextra','-Werror',fixture+'/opensl-configuration-loader.c','-o',program]);
 const output=run(program,[path.resolve(runtime,'native/libklepton-jvm.dylib'),library,ids],{env:{...process.env,KL_AUDIO:'0'}});
 assert.match(output,/PASS original Android OpenSL configuration/);assert.match(output,/play state -> PLAYING/);t.diagnostic(output.trim());
});
