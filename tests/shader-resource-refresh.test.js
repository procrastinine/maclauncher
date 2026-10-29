const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const StoredPlan=require('../src/modules/shared/effects/stored-plan'),GraphicsStatus=require('../src/main/graphics-status');
const id='11111111-1111-4111-8111-111111111111',preset='filter:'+id;
const graph=(enabled=true,selected=preset)=>({schema:2,mode:'advanced',enabled,video:[{id:'effect',kind:'shader',enabled:true,shader:{enabled:true,preset:selected,...(selected==='custom'?{effectPath:'/alias.fx'}:{})}}]});
function harness(games,{prepare}={}){
 const source=fs.readFileSync(path.join(__dirname,'../src/main/main.js'),'utf8'),start=source.indexOf('function publishGraphics('),end=source.indexOf('ipcMain.handle("launcher:getGameEffects"',start),jobs=[],prepared=[],invalidated=[],controllers=new Map();
 assert.ok(start>=0&&end>start);
 // Status reads are direct; the owner's throttle and confirmation timers stay idle.
 const graphicsStatus=GraphicsStatus.createGraphicsStatusOwner({clock:{now:Date.now,setTimeout:()=>0,clearTimeout:()=>{}}});
 const context={Set,Map,Promise,Error,Object,fs:{realpathSync:file=>file==='/alias.fx'?'/source.fx':file},userDataDir:'/profile',
  ReShadeFilters:{list:()=>[{id,path:'/source.fx'}]},loadGamesHydrated:()=>games,runningGameSessions:new Map(games.map(game=>[game.gamePath,new Set([1])])),
  GraphicsStatus,graphicsStatus,graphicsActiveLaunches:new Map(),graphicsEditControllers:controllers,storedGraphicsPlan:entry=>StoredPlan.read(entry),
  graphicsSession:()=>({running:true,live:true,launchId:'launch',pid:1}),observeGraphicsAcceptance:()=>{},graphicsAcquisitions:()=>[],
  findGameByPath:(values,gamePath)=>values.find(game=>game.gamePath===gamePath),backendService:{invalidateGraphicsPreparation:async entry=>invalidated.push(entry.gamePath)},
  gameEffectsOptions:async()=>({isCurrent:()=>true,running:true}),editGraphics:(_path,run)=>{const job=new Promise((resolve,reject)=>jobs.push(signal=>run(signal).then(resolve,reject)));return job;},
  EffectsRuntime:{prepare:async(entry,options)=>{prepared.push({entry,options});return prepare?prepare(entry,options):{document:{revision:'new-source'}};}},
  ReShade:{createPublication(){}},
  require:name=>name==='./graphics-update'?{apply:async(_entry,options,run)=>{const result=await run(options);
   options.onPublication?.({prepared:result,committedAt:Date.now(),documentRevision:result?.document?.revision,bypass:false,slow:false});return result;}}:(()=>{throw Error(name)})()};
 vm.runInNewContext(source.slice(start,end)+'\nthis.refresh=refreshShaderSelections;',context);
 return {context,graphicsStatus,prepared,invalidated,jobs,refresh:context.refresh,flush:()=>Promise.allSettled(jobs.splice(0).map(run=>run(new AbortController().signal)))};
}
test('source refresh targets active references, preserves original paths/settings and shares ordinary publication',async()=>{
 const games=[{gamePath:'/active',effects:graph()},{gamePath:'/off',effects:graph(false)},{gamePath:'/other',effects:graph(true,'grayscale')},{gamePath:'/custom',effects:graph(true,'custom')}],before=structuredClone(games),h=harness(games);
 h.refresh([preset]);await h.flush();assert.deepEqual(h.invalidated,['/active','/custom']);assert.equal(h.prepared.length,2);
 assert.equal(h.prepared[0].options.forceShaderPresets.has(preset),true);assert.equal(h.prepared[0].options.live,true);
 assert.deepEqual(games,before);
 for(const gamePath of ['/active','/custom']){const status=h.graphicsStatus.status(gamePath);assert.equal(status.phase,'published');assert.equal(status.published.documentRevision,'new-source');}
 assert.equal(h.graphicsStatus.status('/off').desiredSeq,0,'an unselected or Off plan gets no new desired revision');
});
test('queued source refresh rereads Off and leaves dormant graphics unprepared',async()=>{
 const game={gamePath:'/active',effects:graph()},h=harness([game]);h.refresh([preset]);game.effects.enabled=false;await h.flush();assert.equal(h.prepared.length,0);assert.deepEqual(h.invalidated,[]);
});
test('a newer selection invalidates a running source refresh before it can publish stale completion',async()=>{
 const game={gamePath:'/active',effects:graph()};let release,entered,scope;
 const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),h=harness([game],{prepare:async(_entry,options)=>{scope=options;entered();await gate;return {document:{revision:'old-source'}};}});
 h.refresh([preset]);const running=h.flush();await ready;
 h.graphicsStatus.desired(game.gamePath,{revision:'newer',running:true,live:true});assert.equal(scope.isCurrent(),false);release();await running;
 const status=h.graphicsStatus.status(game.gamePath);
 assert.equal(status.phase,'preparing');assert.equal(status.desiredRevision,'newer');assert.equal(status.published,undefined);
});
