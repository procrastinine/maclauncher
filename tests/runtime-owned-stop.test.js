const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {spawn,execFileSync}=require('node:child_process'),{once,EventEmitter}=require('node:events');
const {bindProcessStop,processStopBinding,requestProcessStop,afterProcessStop}=require('../src/core/process-lifecycle');
const {createBackendService}=require('../src/core/backend-worker-client');
const workerPath=path.join(__dirname,'fixtures/runtime-stop-worker.cjs');
const wait=async check=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error('Owned Stop fixture timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
function childFixture(t){
  const child=spawn(process.execPath,['-e',`process.stdin.on('data',()=>process.exit(0));console.log('ready');setInterval(()=>{},1000)`],{detached:true,stdio:['pipe','pipe','pipe']});
  t.after(async()=>{if(child.exitCode==null&&child.signalCode==null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}});return child;
}
test('one actual child uses its runtime Stop once, without group termination, including an early root exit',async t=>{
  const child=childFixture(t);await once(child.stdout,'data');let calls=0,release,released=false;
  bindProcessStop(child,async()=>{calls++;const exited=once(child,'exit');child.stdin.write('stop');await exited;await new Promise(resolve=>release=resolve);return true;});
  const first=requestProcessStop(child,{fallback:()=>assert.fail('Generic group termination replaced owned Stop')});
  assert.equal(requestProcessStop(child),first);await wait(()=>child.exitCode===0&&release);
  const retiring=afterProcessStop(child,()=>{released=true;});assert.equal(released,false);
  release();assert.equal(await first,true);await retiring;assert.equal(released,true);assert.equal(calls,1);
});
test('failed Stop is returned unchanged; stale sessions and a changed PID cannot adopt another launch',async t=>{
  const child=childFixture(t);await once(child.stdout,'data');const pid=child.pid;let calls=0;
  bindProcessStop(child,async()=>{calls++;throw Error('Original cleanup failure');});
  assert.equal(await requestProcessStop(child,{isCurrent:()=>false}),false);assert.equal(calls,0);
  child.pid=pid+1;assert.equal(await requestProcessStop(child),false);assert.equal(calls,0);child.pid=pid;
  await assert.rejects(requestProcessStop(child,{fallback:()=>assert.fail('Cleanup errors must not trigger a group kill')}),/Original cleanup failure/);
  await assert.rejects(requestProcessStop(child),/Original cleanup failure/);assert.equal(calls,1);
  const other=childFixture(t);await once(other.stdout,'data');let fallbackPid;
  assert.equal(await requestProcessStop(other,{fallback:target=>{fallbackPid=target;other.stdin.write('stop');return true;}}),true);assert.equal(fallbackPid,other.pid);await once(other,'exit');
});
test('an ordinary actual child keeps the existing group Stop fallback',async t=>{
  const child=childFixture(t);await once(child.stdout,'data');const exited=once(child,'exit');
  assert.equal(await requestProcessStop(child),true);assert.deepEqual(await exited,[null,'SIGTERM']);
});
test('the real backend map/proxy retains pending Stop after controller exit under immediate idle eviction pressure',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-owned-stop-'));
  const service=createBackendService({userDataDir:root,workerPath,maxIdleWorkers:0,idleMs:5});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const entry={gameId:'fixture',gamePath:path.join(root,'fixture-game')};
  const launched=await service.launchEntry(entry,{mode:'held'}),child=launched.child;
  t.after(()=>{if(child.exitCode==null&&child.signalCode==null)try{process.kill(child.pid,'SIGKILL');}catch{}});
  const token=processStopBinding(child).token;
  assert.equal(await service.request('game:fixture','stopProcess',{id:launched.process.id,pid:child.pid+1,stopToken:token}),false);
  assert.equal(await service.request('game:fixture','stopProcess',{id:launched.process.id,pid:child.pid,stopToken:'foreign'}),false);
  const stopping=requestProcessStop(child);await wait(()=>child.exitCode===0);
  await new Promise(resolve=>setTimeout(resolve,40));
  const held=await service.request('game:fixture','status');assert.equal(held.calls,1);assert.equal(held.threadId,launched.threadId);
  await service.request('game:fixture','releaseStop');assert.equal(await stopping,true);
  await wait(()=>!service.hasPendingOperations());
  // A stale exact process token is retired; the next launch receives another
  // token and cannot be stopped through the old proxy/map entry.
  const next=await service.launchEntry(entry,{mode:'graceful'});t.after(()=>{if(next.child.exitCode==null&&next.child.signalCode==null)try{process.kill(next.child.pid,'SIGKILL');}catch{}});
  assert.equal(await service.request('game:fixture','stopProcess',{id:launched.process.id,pid:child.pid,stopToken:token}),false);
  assert.notEqual(processStopBinding(next.child).token,token);assert.equal(await requestProcessStop(next.child),true);
});
test('backend cleanup failures propagate through the real worker proxy',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-stop-failure-'));
  const service=createBackendService({userDataDir:root,workerPath});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const child=(await service.launchEntry({gameId:'fixture',gamePath:path.join(root,'fixture-game')},{mode:'failure'})).child;
  t.after(()=>{if(child.exitCode==null&&child.signalCode==null)try{process.kill(child.pid,'SIGKILL');}catch{}});
  await assert.rejects(requestProcessStop(child),/Original owned cleanup failed/);
  assert.equal(child.exitCode,null);await service.request('game:fixture','disposeChild');
});
test('direct CLI SIGINT calls the same owner and preserves its clean exit',async t=>{
  const script=`const{spawn}=require('node:child_process'),{once}=require('node:events');const{bindProcessStop}=require(${JSON.stringify(path.resolve(__dirname,'../src/core/process-lifecycle'))});const{waitForChild}=require(${JSON.stringify(path.resolve(__dirname,'../src/core/game-cli'))});(async()=>{const child=spawn(process.execPath,['-e',"process.stdin.on('data',()=>process.exit(0));console.log('ready');setInterval(()=>{},1000)"],{stdio:['pipe','pipe','pipe']});await once(child.stdout,'data');bindProcessStop(child,async()=>{console.log('owned-stop');const done=once(child,'exit');child.stdin.write('stop');await done;return true});const done=waitForChild(child);console.log('ready');console.log('exit='+await done);})().catch(e=>{console.error(e);process.exitCode=1});`;
  const host=spawn(process.execPath,['-e',script],{detached:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(host.exitCode==null&&host.signalCode==null)try{process.kill(-host.pid,'SIGKILL');}catch{}});let output='';host.stdout.on('data',bytes=>output+=bytes);
  await wait(()=>output.includes('ready'));const closed=once(host,'close');host.kill('SIGINT');assert.deepEqual(await closed,[0,null]);assert.match(output,/owned-stop/);assert.match(output,/exit=0/);
});
test('actual main Stop functions keep the original session through cleanup and report failure instead of stopping its replacement',async()=>{
  const source=fs.readFileSync(path.resolve(__dirname,'../src/main/main.js'),'utf8');
  const functions=source.slice(source.indexOf('async function stopRunSession('),source.indexOf('function buildRuntimeManagerState('));
  const sessions=new Map(),session={pid:123,stopProcess:async()=>{throw Error('Owned shutdown failed');}};sessions.set('game',new Map([[1,session]]));
  const cancel=source.slice(source.indexOf('function cancelGraphicsEdits('),source.indexOf('function editGraphics('));
  let aborted=0;
  const context={graphicsEditControllers:new Map([['game',[{abort(){assert.equal(session.stopRequested,true);aborted++;}}]]]),runningGameSessions:sessions,gameRecordsCache:[],loadGamesHydrated:()=>[],findGameByPath:()=>null,backendService:{cancelLaunch:async()=>false},stopProcessTree:()=>assert.fail('Owned Stop used generic fallback')};vm.createContext(context);vm.runInContext(cancel+functions,context);
  await assert.rejects(context.stopGameRuns('game'),/Owned shutdown failed/);assert.equal(session.stopRequested,true);
  assert.equal(aborted,1);assert.equal(sessions.get('game').get(1),session);
});
test('the actual provider attaches Stop before backend enrollment and never detaches data after failed owned cleanup',async t=>{
  const Storage=require('../src/modules/android/provider-storage'),Policy=require('../src/modules/android/policy'),Clipboard=require('../src/modules/android/provider-clipboard'),AIM=require('../src/modules/android/providers/aim');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-owned-stop-')),marker=path.join(root,'stop');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const guest=childFixture(t);await once(guest.stdout,'data');
  const mount=path.join(root,'mounted-data');fs.writeFileSync(mount,'existing mounted guest data');
  let detached=0,enrolled=false,stops=0,child;
  t.mock.method(Storage,'prepareStorage',async()=>({root,androidRoot:path.join(root,'data')}));
  t.mock.method(Storage,'preparePackages',async()=>({metadata:{}}));
  t.mock.method(Clipboard,'create',async()=>({socket:undefined,enroll(){},async close(){}}));
  t.mock.method(AIM,'prepareLaunch',async()=>({cwd:root,async stop(){stops++;const exited=once(child,'exit');fs.writeFileSync(marker,'stop');await exited;throw Error('Actual owned cleanup failure');},async cleanup(){detached++;fs.unlinkSync(mount);}}));
  t.mock.method(Policy,'prepareIsolation',async()=>({command:process.execPath,args:['-e',`const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)}))process.exit(0)},5)`],environment:{}}));
  const context={runtimeId:'aim',userDataDir:root,runtimeSettings:{},getGameEffectsEnvironment:async()=>({}),logger:{error(){},warn(){}},
    onProcessSpawn:process=>{enrolled=Boolean(processStopBinding(process));},
    spawnDetachedChecked:async(command,args,options)=>{child=spawn(command,args,{...options,detached:true});await once(child,'spawn');await context.onProcessSpawn(child);return child;}};
  child=await require('../src/modules/android/provider-main').launchRuntime('aim',{gameId:'fixture',gamePath:root},context);
  t.after(()=>{if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');});assert.equal(enrolled,true);
  await assert.rejects(requestProcessStop(child),/Actual owned cleanup failure/);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stops,1);assert.equal(detached,0);assert.equal(child.exitCode,0);
  assert.equal(process.kill(guest.pid,0),true);assert.equal(fs.readFileSync(mount,'utf8'),'existing mounted guest data');
});
test('actual launcher and main retain module, runtime and graphics leases until owned cleanup settles',async t=>{
  const {createBackendOperations}=require('../src/core/backend-operations'),{createRuntimeCoordinator}=require('../src/core/runtime-coordinator');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-stop-leases-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const gamePath=path.join(root,'game'),supplier=path.join(root,'supplier');fs.mkdirSync(gamePath);fs.mkdirSync(supplier);
  const coordinator=createRuntimeCoordinator({userDataDir:root}),identity={managerId:'fixture-runtime',version:'1',sourcePath:supplier};
  let child,release;
  const info={id:'fixture',label:'Fixture',gameType:'native',runtime:{default:'runner',supported:['runner'],entries:{runner:{}}}};
  const mod={id:info.id,manifest:info,runtimeManagers:[{id:identity.managerId}],launchRuntime:async(_id,_entry,context)=>{
    await context.useRuntime(identity);child=childFixture(t);await once(child.stdout,'data');
    bindProcessStop(child,async()=>{const exited=once(child,'exit');child.stdin.write('stop');await exited;await new Promise(resolve=>release=resolve);return true;});
    await context.onProcessSpawn(child);return child;
  }};
  const registry={listModuleIds:()=>[info.id],listModules:()=>[info],getModule:()=>mod,getModuleInfo:()=>info,getModuleDir:()=>root,listSharedRuntimeManagers:()=>[],getRuntimeManagerUi:()=>null,detectGameAsync:async()=>({moduleId:info.id,gamePath,contentRootDir:gamePath,name:'Fixture'})};
  const operations=createBackendOperations({userDataDir:root,registry,runtimeCoordinator:coordinator.client()}),entry=await operations.importEntry(gamePath,{});
  await operations.launchEntry(entry,{settings:{}});
  const source=fs.readFileSync(path.resolve(__dirname,'../src/main/main.js'),'utf8');
  const code=source.slice(source.indexOf('function registerGameRun('),source.indexOf('function buildRuntimeManagerState('));
  let graphicsReleased=0;
  const context={graphicsEditControllers:new Map(),runningGameSessions:new Map(),pendingGameCompletions:new Map(),nextRunSessionId:1,broadcastActivity(){},
    requestProcessStop,afterProcessStop,observeGameProcess:require('../src/core/game-process-events').observeGameProcess,
    gameRecordsCache:[],loadGamesHydrated:()=>[],findGameByPath:()=>null,backendService:{cancelLaunch:async()=>false},logger:{error(){},warn(){}},stopProcessTree:()=>assert.fail('Owned main Stop fell back')};
  const cancel=source.slice(source.indexOf('function cancelGraphicsEdits('),source.indexOf('function editGraphics('));
  vm.createContext(context);vm.runInContext(cancel+code,context);
  const run=context.registerProcessRun(gamePath,child,'runner'),session=context.runningGameSessions.get(gamePath).get(run);
  session.graphicsRuntimeUse={async release(){graphicsReleased++;}};
  const stopping=context.stopGameRuns(gamePath);await wait(()=>child.exitCode===0&&release);
  assert.equal(context.runningGameSessions.get(gamePath).get(run),session);assert.equal(graphicsReleased,0);
  assert.equal(coordinator.snapshot().games.length,1);assert.ok(coordinator.snapshot().active.some(row=>row.identities.some(value=>value.managerId===identity.managerId)));
  await assert.rejects(operations.removeGameData(entry),{code:'GAME_IN_USE'});
  release();assert.equal(await stopping,true);await wait(()=>coordinator.snapshot().games.length===0&&coordinator.snapshot().active.length===0&&graphicsReleased===1);
  assert.equal(context.runningGameSessions.has(gamePath),false);
  // A retained callback cannot adopt a replacement session, even with the same
  // public PID. It remains attached to the original run/object capability.
  context.runningGameSessions.set(gamePath,new Map([[run,{id:run,pid:child.pid}]]));
  assert.equal(await session.stopProcess(),false);assert.equal(graphicsReleased,1);
});
test('AIM Stop signals only its retained controller and preserves original shutdown status',async t=>{
  const {stopRuntime}=require('../src/modules/android/providers/aim');
  for(const code of [0,7]){
    const child=spawn(process.execPath,['-e',`process.on('SIGTERM',()=>setTimeout(()=>process.exit(${code}),20));console.log('ready');setInterval(()=>{},1000)`],{detached:true,stdio:['ignore','pipe','pipe']});
    t.after(()=>{if(child.exitCode==null&&child.signalCode==null)child.kill('SIGKILL');});await once(child.stdout,'data');
    let calls=0;const kill=child.kill.bind(child);t.mock.method(child,'kill',signal=>{calls++;assert.equal(signal,'SIGTERM');return kill(signal);});
    assert.equal(await stopRuntime({child,isCurrent:()=>false}),false);assert.equal(await stopRuntime({child,pid:child.pid+1}),false);assert.equal(calls,0);
    if(code===0){assert.equal(await stopRuntime({child}),true);assert.equal(await stopRuntime({child}),true);}
    else await assert.rejects(stopRuntime({child}),/Android controller shutdown failed \(7\)/);
    assert.equal(calls,1);assert.equal(child.listenerCount('exit'),0);assert.equal(child.listenerCount('error'),0);
  }
  const child=childFixture(t);await once(child.stdout,'data');t.mock.method(child,'kill',()=>false);
  await assert.rejects(stopRuntime({child}),/could not receive its shutdown request/);
  assert.equal(child.listenerCount('exit'),0);assert.equal(child.listenerCount('error'),0);t.mock.restoreAll();
});

const keeper=path.resolve(__dirname,'../src/modules/android/providers/aim/resources/maclauncher-aim');
test('AIM owned Stop reaches the actual sandboxed controller and its resident child without granting sibling signals',
  {skip:process.platform!=='darwin'||process.arch!=='arm64'||!fs.existsSync(keeper),timeout:20000},async t=>{
  const AIM=require('../src/modules/android/providers/aim'),Policy=require('../src/modules/android/policy');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'aim-owned-sandbox-stop-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const ctl=path.join(root,'supplier/bin/aimctl');fs.mkdirSync(path.dirname(ctl),{recursive:true});
  execFileSync('/usr/bin/clang',['-Wall','-Wextra','-Werror','-mmacosx-version-min=13.0',path.join(__dirname,'fixtures/runtime-stop-resident.c'),'-o',ctl]);
  const foreign=childFixture(t);await once(foreign.stdout,'data');
  for(const code of [0,7]){
    const base=path.join(root,String(code)),storage={root:base};
    for(const [key,name]of Object.entries({cacheRoot:'cache',runtimeRoot:'runtime',packagesRoot:'packages',home:'home',temporary:'tmp',androidRoot:'android'})){storage[key]=path.join(base,name);fs.mkdirSync(storage[key],{recursive:true});}
    fs.writeFileSync(path.join(storage.runtimeRoot,'aim-installed.json'),JSON.stringify({key:'example'}));
    const configuration=path.join(base,'launch.json'),trace=path.join(base,'resident.log');
    fs.writeFileSync(configuration,JSON.stringify({schemaVersion:1,runtime:path.dirname(path.dirname(ctl)),image:base,userdata:base,data:storage.androidRoot,root:base,packageName:'org.example.game',activity:'.Main',key:'example',apks:[path.join(base,'base.apk')]}));
    // This is the ordinary launch sandbox. Stop must neither rewrite it nor
    // create a separately sandboxed sibling aimctl process.
    const isolation=await Policy.prepareIsolation({command:keeper,args:[configuration],readFiles:[configuration],readDirectories:[path.dirname(path.dirname(ctl))],executables:[ctl],env:{AIM_STOP_TRACE:trace,AIM_STOP_EXIT:String(code),AIM_STOP_FOREIGN_PID:String(foreign.pid)}},storage,Policy.resolvePolicy());
    const policy=fs.readFileSync(path.join(storage.runtimeRoot,'sandbox.sb'),'utf8');
    const child=spawn(isolation.command,isolation.args,{env:isolation.environment,detached:true,stdio:['ignore','pipe','pipe']});
    const closed=once(child,'close');
    t.after(()=>{if(child.exitCode==null&&child.signalCode==null)child.kill('SIGTERM');});let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);
    await wait(()=>stdout.includes('Android game started.')||child.exitCode!=null||child.signalCode!=null);assert.match(stdout,/Android game started\./,stderr);
    bindProcessStop(child,AIM.stopRuntime);
    if(code===0)assert.equal(await requestProcessStop(child),true);else await assert.rejects(requestProcessStop(child),/Android controller shutdown failed \(1\)/);
    await closed;
    assert.equal(child.signalCode,null);assert.equal(child.exitCode,code===0?0:1);
    if(code===7)assert.match(stderr,/Android shutdown failed[\s\S]*7/);else assert.equal(stderr,'');
    const lines=fs.readFileSync(trace,'utf8');assert.match(lines,/foreign-signal-denied/);assert.match(lines,/resident-child-reaped/);
    for(const match of lines.matchAll(/owned-pid=(\d+)/g)){assert.throws(()=>process.kill(Number(match[1]),0),{code:'ESRCH'});}
    assert.equal(fs.readFileSync(path.join(storage.runtimeRoot,'sandbox.sb'),'utf8'),policy);
    assert.equal(process.kill(foreign.pid,0),true);
  }
});
