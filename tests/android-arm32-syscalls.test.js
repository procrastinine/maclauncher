const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {linkBinary}=require('./helpers/android-arm32-binary');

test('ARM32 exec converts guest pointer vectors at the shared process boundary',t=>{
  const build=process.env.ANDROID_ARM32_BUILD;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build)return t.skip('Requires ARM32 component');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-exec-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const row=JSON.parse(fs.readFileSync(path.resolve(build,'syscalls/syscalls.json'))).find(value=>value.name==='execve');
  assert.equal(row.mode,'Exec');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const binary=path.join(directory,'probe');
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+path.resolve(__dirname,'../src/modules/android/native/arm32'),
    path.join(__dirname,'fixtures/android-arm32/exec-vectors.cpp'),path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-o',binary]);
  assert.match(run(binary,[String(row.number)]),/PASS original ARM32 exec vectors/);
});

test('raw ARM EABI syscalls enter the same native imports with kernel register semantics',t=>{
  const build=process.env.ANDROID_ARM32_BUILD,runtime=process.env.KLEPTON_NATIVE_RUNTIME,linker=process.env.ANDROID_ARM32_ELF_LINKER;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!build||!runtime||!linker)return t.skip('Requires ARM32 component, shared runtime and ELF linker');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-syscalls-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const root=path.resolve(__dirname,'..'),fixture=path.join(__dirname,'fixtures/android-arm32');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:60000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const rows=JSON.parse(fs.readFileSync(path.resolve(build,'syscalls/syscalls.json')));
  assert.ok(rows.length>200,'Complete original Bionic stub inventory');
  const constants=rows.map(row=>`#define NR_${row.name.replace('__ARM_NR_','')} ${row.number}`);
  const source=fs.readFileSync(path.resolve(build,'syscalls/syscalls.inc'),'utf8');
  constants.push('#define NR_futex '+source.match(/syscallFutex=(\d+)/)[1]);
  fs.writeFileSync(temporary+'/syscall-test-numbers.h',constants.join('\n'));
  fs.copyFileSync(path.resolve(build,'syscalls/prctl-constants.h'),temporary+'/prctl-constants.h');
  run('clang',['--target=armv7a-linux-androideabi21','-fPIC','-c',fixture+'/syscalls-guest.S','-o',temporary+'/guest.o']);
  linkBinary(run,linker,[temporary+'/guest.o'],['raw_syscall'],[],temporary+'/guest.bin');
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+root+'/src/modules/android/native/arm32','-I'+temporary,fixture+'/syscalls-probe.cpp',path.resolve(build,'libandroid-arm32.dylib'),'-Wl,-rpath,'+path.resolve(build),'-o',temporary+'/probe']);
  assert.match(run(temporary+'/probe',[path.resolve(runtime,'native/libklepton-jvm.dylib'),temporary+'/guest.bin']),/PASS original ARM EABI/);
  const jdk=process.env.JAVA_HOME;
  if(jdk){
    run('clang',['--target=armv7a-linux-androideabi21','-mthumb','-fomit-frame-pointer','-fPIC','-ffreestanding','-O2','-I'+temporary,'-c',fixture+'/syscalls-runtime-guest.c','-o',temporary+'/runtime-guest.o']);
    linkBinary(run,linker,[temporary+'/runtime-guest.o'],['Java_SyscallFixture_pid','borrowed_buffer','buffer_finalizer'],[],temporary+'/runtime-guest.bin');
    run(jdk+'/bin/javac',['-d',temporary,fixture+'/SyscallFixture.java']);
    run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+root+'/src/modules/android/native/arm32','-I'+temporary,'-I'+jdk+'/include','-I'+jdk+'/include/darwin',fixture+'/syscalls-runtime-probe.cpp',path.resolve(build,'libandroid-arm32.dylib'),'-L'+jdk+'/lib/server','-ljvm','-Wl,-rpath,'+jdk+'/lib/server','-Wl,-rpath,'+path.resolve(build),'-o',temporary+'/runtime-probe']);
    assert.match(run(temporary+'/runtime-probe',[path.resolve(runtime,'native/libklepton-jvm.dylib'),temporary+'/runtime-guest.bin',temporary]),/PASS raw SVC uses the ordinary JNI/);
  }
});
