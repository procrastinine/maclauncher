const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');

test('ARM32 execution preserves original stack guards and allocation ownership',t=>{
  const library=process.env.ANDROID_ARM32_LIBRARY;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!library)
    return t.skip('Requires the built native ARM32 execution library');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-stack-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'probe');
  const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:1<<20});
  const absolute=path.resolve(library);
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror',
    '-I'+path.resolve(__dirname,'../src/modules/android/native/arm32'),
    path.join(__dirname,'fixtures/android-arm32/borrowed-stack.cpp'),absolute,
    '-Wl,-rpath,'+path.dirname(absolute),'-o',binary]);
  assert.match(run(binary,[]),/PASS original guarded stack is borrowed/);
});

test('original linker bootstrap uses the ARM32 process memory and execution owner',t=>{
  const library=process.env.ANDROID_ARM32_LIBRARY,jdk=process.env.JAVA_HOME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!library||!jdk)
    return t.skip('Requires the built native ARM32 execution library and JDK');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-arm32-process-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'probe'),absolute=path.resolve(library);
  const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:1<<20});
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror',
    '-I'+path.resolve(__dirname,'../src/modules/android/native/arm32'),
    '-I'+path.join(jdk,'include'),'-I'+path.join(jdk,'include/darwin'),
    path.join(__dirname,'fixtures/android-arm32/process-memory.cpp'),absolute,
    '-L'+path.join(jdk,'lib/server'),'-ljvm','-Wl,-rpath,'+path.join(jdk,'lib/server'),
    '-Wl,-rpath,'+path.dirname(absolute),'-o',binary]);
  assert.match(run(binary,[]),/PASS process memory executes through the existing ARM32 owner/);
});
