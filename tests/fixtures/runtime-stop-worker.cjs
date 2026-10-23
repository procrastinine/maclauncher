const {parentPort,workerData,threadId}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{once}=require('node:events');
const {createBackendOperations}=require('../../src/core/backend-operations');
const {bindProcessStop}=require('../../src/core/process-lifecycle');
const {errorRecord}=require('../../src/core/backend-worker-client');
const root=workerData.userDataDir,gamePath=path.join(root,'fixture-game');fs.mkdirSync(gamePath,{recursive:true});
let entry,child,mode='graceful',release,entered=false,calls=0;
const info={id:'stop-fixture',label:'Stop fixture',gameType:'native',runtime:{default:'runner',supported:['runner'],entries:{runner:{}}}};
const mod={id:info.id,manifest:info,launchRuntime:async(_id,_entry,context)=>{
  entered=false;calls=0;
  child=spawn(process.execPath,['-e',`process.on('SIGTERM',()=>process.stdout.write('UNEXPECTED_TERM\\n'));process.on('SIGINT',()=>process.stdout.write('UNEXPECTED_INT\\n'));process.stdin.on('data',()=>process.exit(0));console.log('ready');setInterval(()=>{},1000)`],{detached:true,stdio:['pipe','pipe','pipe']});
  await once(child.stdout,'data');
  if(mode!=='fallback')bindProcessStop(child,async()=>{
    calls++;entered=true;parentPort.postMessage({type:'event',event:'stopEntered',payload:{pid:child.pid,threadId}});
    if(mode==='failure')throw Error('Original owned cleanup failed');
    const stopped=once(child,'exit');child.stdin.write('stop\n');await stopped;
    if(mode==='held')await new Promise(resolve=>{release=resolve;});
    return true;
  });
  await context.onProcessSpawn(child);return child;
}};
const registry={listModuleIds:()=>[info.id],listModules:()=>[info],getModule:()=>mod,getModuleInfo:()=>info,getModuleDir:()=>gamePath,listSharedRuntimeManagers:()=>[],getRuntimeManagerUi:()=>null,
  detectGameAsync:async()=>({moduleId:info.id,gamePath,contentRootDir:gamePath,name:info.label})};
const operations=createBackendOperations({userDataDir:root,registry,emit:(event,payload)=>parentPort.postMessage({type:'event',event,payload})});
parentPort.on('message',async message=>{
  if(message.type==='beginShutdown'){operations.beginShutdown();return;}
  if(message.type!=='request')return;
  try{
    let result;
    if(message.method==='launchEntry'){mode=message.args[1]?.mode||'graceful';entry||=await operations.importEntry(gamePath,{});result={...await operations.launchEntry(entry,{settings:{}}),threadId};}
    else if(message.method==='releaseStop'){release?.();result=true;}
    else if(message.method==='status')result={pid:child?.pid,calls,entered,threadId,exitCode:child?.exitCode};
    else if(message.method==='disposeChild'){if(child?.exitCode==null&&child?.signalCode==null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}result=true;}
    else result=await operations[message.method](...message.args);
    parentPort.postMessage({type:'result',id:message.id,result});
  }catch(error){parentPort.postMessage({type:'result',id:message.id,error:errorRecord(error)});}
});
