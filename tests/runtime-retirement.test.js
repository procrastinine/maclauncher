const test=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {afterProcessStop}=require('../src/core/process-lifecycle');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('normal process exit waits for retirement published by a later exit listener',async t=>{
  const child=spawn(process.execPath,['-e','process.stdin.once("data",()=>process.exit(0));console.log("ready")'],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');});
  await once(child.stdout,'data');let finish,released=false,retained;
  const retirement=new Promise(resolve=>finish=resolve);
  child.once('exit',()=>{retained=afterProcessStop(child,()=>{released=true;});});
  child.once('exit',()=>{child.runtimeRetirement=retirement;});
  const exited=once(child,'exit');child.stdin.write('stop');await exited;await tick();
  assert.equal(released,false);finish();await retained;assert.equal(released,true);
});

test('failed retirement preserves ownership and reports its original error once',async()=>{
  const {EventEmitter}=require('node:events'),child=new EventEmitter(),failure=Error('Original GPU owner retirement failed');
  let fail,released=0;const errors=[];child.on('runtimeRetirementError',error=>errors.push(error));
  child.runtimeRetirement=new Promise((_resolve,reject)=>fail=reject);
  const first=afterProcessStop(child,()=>released++),second=afterProcessStop(child,()=>released++);
  await tick();fail(failure);assert.equal(await first,false);assert.equal(await second,false);
  assert.equal(released,0);assert.equal(child.runtimeRetirementError,failure);assert.deepEqual(errors,[failure]);
});

test('ordinary processes without a runtime owner retain normal exit release',async()=>{
  let released=0;await afterProcessStop({},()=>released++);assert.equal(released,1);
});

test('repeated ordinary exits retain the actual backend until each runtime owner retires',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const {createBackendOperations}=require('../src/core/backend-operations');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-exit-retirement-')),gamePath=path.join(root,'game');
  fs.mkdirSync(gamePath);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let child,retire;const events=[];
  const info={id:'fixture',label:'Fixture',gameType:'native',runtime:{default:'runner',supported:['runner'],entries:{runner:{}}}};
  const mod={id:info.id,manifest:info,async launchRuntime(_id,_entry,context){
    child=spawn(process.execPath,['-e','process.stdin.once("data",()=>process.exit(0));console.log("ready")'],{stdio:['pipe','pipe','pipe']});
    const owned=child;t.after(()=>{if(owned.exitCode==null&&owned.signalCode==null)owned.kill('SIGKILL');});
    await once(child.stdout,'data');await context.onProcessSpawn(child);
    child.once('exit',()=>{child.runtimeRetirement=new Promise(resolve=>retire=resolve);});return child;
  }};
  const registry={listModuleIds:()=>[info.id],listModules:()=>[info],getModule:()=>mod,getModuleInfo:()=>info,getModuleDir:()=>root,listSharedRuntimeManagers:()=>[],getRuntimeManagerUi:()=>null,detectGameAsync:async()=>({moduleId:info.id,gamePath,contentRootDir:gamePath,name:'Fixture'})};
  const operations=createBackendOperations({userDataDir:root,registry,emit:(event,payload)=>{if(event==='activity')events.push(payload.processes);}});
  const entry=await operations.importEntry(gamePath,{});
  for(let i=0;i<3;i++){
    await operations.launchEntry(entry,{settings:{}});const exited=once(child,'exit');child.stdin.write('stop');await exited;await tick();
    assert.equal(events.at(-1),1,'root exit must keep the cleanup worker');retire();
    const end=Date.now()+2000;while(events.at(-1)!==0){assert.ok(Date.now()<end,'retired owner must release the worker');await tick();}
  }
  assert.deepEqual(events,[1,0,1,0,1,0]);
});
