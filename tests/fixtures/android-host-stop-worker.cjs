const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{once}=require('node:events');
const {createBackendOperations}=require('../../src/core/backend-operations');
const {errorRecord}=require('../../src/core/backend-worker-client');
const Host=require('../../src/modules/android/host');
const root=workerData.userDataDir,gamePath=path.join(root,'fixture-game');fs.mkdirSync(gamePath,{recursive:true});
const info={id:'android-stop-fixture',label:'Android Stop fixture',gameType:'native',runtime:{default:'runner',supported:['runner'],entries:{runner:{}}}};
const mod={id:info.id,manifest:info,async launchRuntime(_id,_entry,context){
 const child=spawn(process.execPath,['-e',`process.stderr.write('java.lang.ClassNotFoundException: optional.telemetry.Adapter\\n');console.log('ready');setInterval(()=>{},1000);`],{detached:true,stdio:['ignore','pipe','pipe']});
 await once(child.stdout,'data');
 // Ordinary host enrollment occurs before diagnostics are attached. The final
 // backend launch descriptor must still carry this exact process Stop owner.
 await context.onProcessSpawn(child);
 return Host.captureStderr(child,path.join(root,'runtime.log'),root,context.logger);
}};
const registry={listModuleIds:()=>[info.id],listModules:()=>[info],getModule:()=>mod,getModuleInfo:()=>info,getModuleDir:()=>gamePath,listSharedRuntimeManagers:()=>[],getRuntimeManagerUi:()=>null,detectGameAsync:async()=>({moduleId:info.id,gamePath,contentRootDir:gamePath,name:info.label})};
const operations=createBackendOperations({userDataDir:root,registry,emit:(event,payload)=>parentPort.postMessage({type:'event',event,payload})});
let entry;
parentPort.on('message',async message=>{
 if(message.type==='beginShutdown'){operations.beginShutdown();return;}
 if(message.type!=='request')return;
 try{let result;if(message.method==='launchEntry'){entry||=await operations.importEntry(gamePath,{});result=await operations.launchEntry(entry,{settings:{}});}else result=await operations[message.method](...message.args);parentPort.postMessage({type:'result',id:message.id,result});}
 catch(error){parentPort.postMessage({type:'result',id:message.id,error:errorRecord(error)});}
});
