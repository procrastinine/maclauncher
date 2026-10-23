const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('complete Bionic nonlocal-jump ABI uses shared native signals and guest x18',async t=>{
  if(process.platform!=='darwin'||process.arch!=='arm64')return t.skip('Requires macOS arm64');
  const bionicSource=process.env.ANDROID_BIONIC_SOURCE,klepton=process.env.ANDROID_KLEPTON_SOURCE;
  if(!bionicSource||!klepton)return t.skip('Set pinned Bionic and Klepton sources');
  const build=fs.mkdtempSync(path.join(os.tmpdir(),'android-jump-'));t.after(()=>fs.rmSync(build,{recursive:true,force:true}));
  const {prepareNonlocalJump}=await import('../src/modules/android/native/nonlocal-jump/build.mjs');
  const result=prepareNonlocalJump({bionicSource,klepton,build});
  const native=path.resolve(__dirname,'../src/modules/android/native'),fixture=path.join(__dirname,'fixtures/android-native-jump');
  function run(command,args){const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
  const signals=path.join(build,'signals.o'),registers=path.join(build,'registers.o'),binary=path.join(build,'probe');
  run('clang',['-O2','-c',path.join(native,'signal-bridge.c'),'-o',signals]);
  run('clang',['-c',path.join(fixture,'registers.S'),'-o',registers]);
  run('clang++',['-std=c++20','-O2','-Wl,-dead_strip','-I'+path.join(klepton,'runtime'),path.join(fixture,'probe.cpp'),...result.objects,signals,registers,'-o',binary]);
  assert.match(run(binary,[]),/PASS Bionic jump family/);
  assert.equal(result.names.length,6);
  const assembly=fs.readFileSync(path.join(result.output,'setjmp.S'),'utf8').replace(/\/\/[^\n]*/g,'');
  assert.doesNotMatch(assembly,/\bx18\b/);
  assert.match(fs.readFileSync(path.join(result.output,'source/libc/include/setjmp.h'),'utf8'),/__aarch64__[\s\S]*?#define _JBLEN 32/);
});
