const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('Shared native ABI scratch retains reentrant calls, floating arguments and large-call fallback',t=>{
 const candidate=process.env.ANDROID_ARM32_BUILD,baseline=process.env.ANDROID_ARM32_BASELINE_BUILD;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!candidate)return t.skip('Requires the shared ARM32 component');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-native-scratch-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));const measurements=[];
 for(const [name,directory]of[['baseline',baseline],['candidate',candidate]]){if(!directory)continue;
  const binary=path.join(temporary,name),library=path.resolve(directory,'libandroid-arm32.dylib');
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  run('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+path.resolve('src/modules/android/native/arm32'),path.resolve('tests/fixtures/android-arm32/native-scratch.cpp'),library,'-Wl,-rpath,'+path.dirname(library),'-o',binary]);
  const result=JSON.parse(run(binary,[]));assert.equal(result.calls,100000);assert.equal(result.reentrant,true);assert.equal(result.floatAbi,true);assert.equal(result.largeArguments,15);measurements.push({name,...result});
 }
 if(measurements.length===2)assert.equal(measurements[0].checksum,measurements[1].checksum);t.diagnostic(JSON.stringify(measurements));
});
