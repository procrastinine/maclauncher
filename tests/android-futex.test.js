const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('Native futex retains exact private waits and wakes shared backing objects across processes',t=>{
  if(process.platform!=='darwin')return t.skip('Requires Darwin pthread futex adaptation');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-futex-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'futex');
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  run('clang',['-std=c11','-O1','-Wall','-Wextra','-Werror','-pthread',
    path.join(__dirname,'fixtures/android-native/futex-contention.c'),
    path.resolve(__dirname,'../src/modules/android/native/native-clock/futex.c'),
    '-o',binary]);
  const result=run(binary,[]);
  assert.match(result,/PASS native futex exact-address wake, bitsets, timeout, requeue, wake-op and cancellation/);
  assert.match(result,/PASS shared futex aliases, fork, exact wake count, private isolation and timeout/);
});

test('Guest suspension cannot retain native futex metadata locks',t=>{
  if(process.platform!=='darwin')return t.skip('Requires Darwin signals and kernel address waits');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-futex-signals-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const binary=path.join(temporary,'futex-signals');
  const compile=spawnSync('clang',['-std=c11','-O1','-Wall','-Wextra','-Werror','-pthread',
    '-DFUTEX_SOURCE='+JSON.stringify(path.resolve(__dirname,'../src/modules/android/native/native-clock/futex.c')),
    path.join(__dirname,'fixtures/android-native/futex-suspension.c'),'-o',binary],{encoding:'utf8',timeout:20000});
  assert.ifError(compile.error);assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:10000});
  assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/PASS guest suspension during futex enrollment, wake and retirement/);
});
