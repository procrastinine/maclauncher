const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events');

test('JVM composition still retires owned helpers and composition after authority failure',{timeout:10000},async t=>{
 const {retireCompositionSession}=await import('../src/modules/android/composition-session.mjs');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-jvm-composition-'));
 const child=spawn(process.execPath,['-e',"process.stdout.write('ready\\n');setInterval(()=>{},1000);"],{detached:true,stdio:['ignore','pipe','ignore']});
 t.after(()=>{if(child.exitCode==null&&child.signalCode==null)try{process.kill(-child.pid,'SIGKILL');}catch{}fs.rmSync(directory,{recursive:true,force:true});});
 await once(child.stdout,'data');const first=Error('authority close failure'),later=Error('composition close failure');let closed=0;
 await assert.rejects(retireCompositionSession({directory,children:new Set([child]),authority:{close(){throw first;}},composition:{async close(){closed++;assert.ok(child.signalCode);throw later;}}}),error=>error===first);
 assert.equal(closed,1);assert.equal(fs.existsSync(directory),false);assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
});

test('JVM composition attempts later retirement but retains files after refused child exit',{timeout:10000},async t=>{
 const {retireCompositionSession}=await import('../src/modules/android/composition-session.mjs');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-jvm-composition-live-'));
 const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000);"],{detached:true,stdio:['ignore','pipe','ignore']});
 await once(child.stdout,'data');const kill=process.kill.bind(process);let closed=0;
 t.after(async()=>{t.mock.restoreAll();if(child.exitCode==null&&child.signalCode==null){const exited=once(child,'exit');kill(-child.pid,'SIGKILL');await exited;}fs.rmSync(directory,{recursive:true,force:true});});
 t.mock.method(process,'kill',(pid,signal)=>{if(pid===-child.pid)throw Object.assign(Error('owned signal refused'),{code:'EPERM'});return kill(pid,signal);});
 t.mock.method(child,'kill',()=>false);
 await assert.rejects(retireCompositionSession({directory,children:new Set([child]),composition:{close(){closed++;}}}),error=>error.message==='Android process did not exit.'&&error.pid===child.pid);
 assert.equal(closed,1);assert.equal(fs.existsSync(directory),true);assert.doesNotThrow(()=>kill(child.pid,0));
});
