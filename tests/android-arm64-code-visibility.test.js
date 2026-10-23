const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('shared A64 execution retains original instruction data and precise owner faults',{timeout:60000},t=>{
 const archive=process.env.ANDROID_A64_CPU_ARCHIVE,build=process.env.ANDROID_DYNARMIC_BUILD;
 if(process.platform!=='darwin'||process.arch!=='arm64'||!archive||!build)return t.skip('Requires Apple Silicon and the A64 CPU component archives');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-a64-visibility-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const binary=path.join(temporary,'probe'),libraries=['src/dynarmic/libdynarmic.a','externals/mcl/src/libmcl.a','externals/fmt/libfmt.a'].map(file=>path.resolve(build,file));
 const run=(program,args)=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+path.resolve('src/modules/android/native/arm64'),path.resolve('tests/fixtures/android-native/arm64-code-visibility.cpp'),path.resolve(archive),...libraries,'-o',binary]);
 assert.match(run(binary,[]),/PASS shared A64 binding retains original text, CPU state, SVC continuation, owner faults, bounded execution and direct memory/);
});

test('A64 SVC state uses the original AIM Linux syscall dispatcher',{timeout:60000},t=>{
 const archive=process.env.ANDROID_A64_CPU_ARCHIVE,build=process.env.ANDROID_DYNARMIC_BUILD,rlib=process.env.ANDROID_AIM_RLIB,target=process.env.ANDROID_AIM_CARGO_TARGET,rust=process.env.RUSTC;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![archive,build,rlib,target,rust].every(Boolean))return t.skip('Requires the A64 CPU archives and matching original AIM Rust build');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-a64-dispatch-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const binary=path.join(temporary,'probe'),libraries=[path.resolve(archive),...['src/dynarmic/libdynarmic.a','externals/mcl/src/libmcl.a','externals/fmt/libfmt.a'].map(file=>path.resolve(build,file))];
 const args=['--edition=2024','-O',path.resolve('tests/fixtures/android-art-faults/a64-dispatch.rs'),'-L','dependency='+path.resolve(target,'release/deps'),'--extern','aim_linux_abi='+path.resolve(rlib),...libraries.flatMap(file=>['-L','native='+path.dirname(file),'-l','static='+path.basename(file).replace(/^lib/,'').replace(/\.a$/,'')]),'-l','c++','-o',binary];
 const run=(program,args)=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:45000,maxBuffer:4<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run(rust,args);
 assert.match(run(binary,[]),/PASS original A64 SVC state invokes original AIM Linux dispatcher, preserves errno and continuation without source rewriting/);
});
