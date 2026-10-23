const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');

async function childProcess(t, ignoreTerm) {
  const child = spawn(process.execPath, ['-e',
    (ignoreTerm ? "process.on('SIGTERM',()=>{});" : '') + "process.stdout.write('ready\\n');setInterval(()=>{},1000);"],
  {detached:true,stdio:['ignore','pipe','pipe']});
  t.after(() => { if(child.exitCode==null&&child.signalCode==null) try {process.kill(-child.pid,'SIGKILL');} catch {} });
  await once(child.stdout,'data');
  return child;
}

test('native retirement completes only after a forced child exit, with one concurrent owner', async t => {
  const {stopProcess} = await import('../src/modules/android/art/process-retirement.mjs');
  const child = await childProcess(t, true);
  const first = stopProcess(child,{graceMs:30});
  assert.equal(stopProcess(child,{graceMs:30}),first);
  await first;
  assert.equal(child.signalCode,'SIGKILL');
  assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
  assert.equal(child.listenerCount('exit'),0);
  assert.equal(child.listenerCount('close'),0);
});

test('native retirement preserves graceful exit and already retired children', async t => {
  const {stopProcess} = await import('../src/modules/android/art/process-retirement.mjs');
  const child = await childProcess(t, false);
  await stopProcess(child);
  assert.equal(child.signalCode,'SIGTERM');
  await stopProcess(child);
  await stopProcess(null);
  assert.equal(child.listenerCount('exit'),0);
});

test('a refused child retirement is bounded, preserves the failure and still retires independent owners', async t => {
  const {stopProcess,stopProcesses,retireAll,requireRetired}=await import('../src/modules/android/art/process-retirement.mjs');
  const blocked=await childProcess(t,true),other=await childProcess(t,false);
  const kill=process.kill.bind(process),denied=Object.assign(Error('owned child signal refused'),{code:'EPERM'});
  t.mock.method(process,'kill',(pid,signal)=>{if(pid===-blocked.pid)throw denied;return kill(pid,signal);});
  t.mock.method(blocked,'kill',()=>false);
  let failed,independent=0,released=0;
  try {
    await assert.rejects(stopProcess(blocked,{graceMs:20,killMs:20}),error=>{
      failed=error;return error.message==='Android process did not exit.'&&error.cause===denied&&error.pid===blocked.pid;
    });
    await assert.rejects(retireAll([
      ()=>{throw failed;},
      ()=>stopProcesses([other]),
      ()=>{independent++;},
      ()=>{requireRetired([blocked,other]);released++;}
    ]),error=>error===failed);
    assert.equal(independent,1);assert.equal(released,0,'A live consumer keeps its resource lease');
    assert.throws(()=>kill(other.pid,0),{code:'ESRCH'});
    assert.doesNotThrow(()=>kill(blocked.pid,0));
    assert.equal(blocked.listenerCount('exit'),0);assert.equal(blocked.listenerCount('close'),0);
  } finally {
    t.mock.restoreAll();const exited=once(blocked,'exit');kill(-blocked.pid,'SIGKILL');await exited;
  }
});

test('authority EOF gets its original graceful interval before forced retirement', async t => {
  const {stopProcess}=await import('../src/modules/android/art/process-retirement.mjs');
  const child=spawn(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdout.write('ready\\n');"],{detached:true,stdio:['pipe','pipe','ignore']});
  t.after(()=>{if(child.exitCode==null&&child.signalCode==null)try{process.kill(-child.pid,'SIGKILL');}catch{}});
  await once(child.stdout,'data');child.stdin.end();
  await stopProcess(child,{initialSignal:null,graceMs:100,killMs:100});
  assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);
});

test('optional retirement observations cannot replace an owned result or prevent later cleanup',async()=>{
  const {observeRetirement,retireAll}=await import('../src/modules/android/art/process-retirement.mjs');
  const original=()=>42;assert.equal(observeRetirement('off',original),original);
  const failure=Error('original cleanup failure'),events=[];
  const observe=record=>{events.push(record);if(record.state==='started')throw Error('observer unavailable');return Promise.reject(Error('observer rejected'));};
  let retired=0;
  await assert.rejects(retireAll([
    observeRetirement('first',()=>{throw failure;},observe),
    observeRetirement('second',()=>{retired++;},observe)
  ]),error=>error===failure);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(retired,1);
  assert.deepEqual(events,[{phase:'first',state:'started'},{phase:'first',state:'rejected'},{phase:'second',state:'started'},{phase:'second',state:'fulfilled'}]);
});
