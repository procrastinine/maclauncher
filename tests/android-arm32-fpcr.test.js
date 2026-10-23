const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {linkBinary}=require('./helpers/android-arm32-binary');

test('Original ARM32 FP blocks retain scalar and NEON modes, status and native boundaries',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,linker=process.env.ANDROID_ARM32_ELF_LINKER;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!linker)return t.skip('Requires Apple Silicon, the ARM32 component and ELF linker');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-fpcr-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const fixture=path.resolve(__dirname,'fixtures/android-arm32'),native=path.resolve(__dirname,'../src/modules/android/native/arm32');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  run('clang',['--target=armv7a-linux-androideabi21','-c',fixture+'/fpcr.S','-o',temporary+'/guest.o']);
  linkBinary(run,linker,[temporary+'/guest.o'],['fpcr_case','fpcr_loop','fpcr_fault'],['checkpoint'],temporary+'/guest.bin');
  const results=[];
  for(const [label,directory]of [['current',build],...(process.env.ANDROID_ARM32_BASELINE_BUILD?[['baseline',process.env.ANDROID_ARM32_BASELINE_BUILD]]:[])]){
    const binary=path.join(temporary,label);
    run('clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror','-I'+native,'-I'+fixture,'-I'+temporary,fixture+'/fpcr-probe.cpp',path.resolve(directory,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(directory),'-o',binary]);
    const output=run(binary,[temporary+'/guest.bin']);
    assert.match(output,/PASS original ARM32 floating-point blocks preserve values, status and mode boundaries/);
    results.push({label,...JSON.parse(output.split('\n').find(line=>line.startsWith('{')))});
  }
  if(results.length===2){assert.deepEqual(results[0].results,results[1].results);assert.equal(results[0].iterations,results[1].iterations);}
  t.diagnostic(JSON.stringify(results.map(({results,...summary})=>summary)));
});
