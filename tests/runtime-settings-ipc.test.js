const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function fixture(){
  let saved={gameId:'example',gamePath:'/Games/Example',moduleId:'current-engine',runtimeId:'old-player'};
  let finishRefresh;const refreshing=new Promise(resolve=>{finishRefresh=resolve;});
  const handlers=new Map(),opened=[],settings={},module={},info={runtime:{}};let broadcasts=0,reads=0;
  const context={Date,loadSettings:()=>settings,loadGamesHydrated:options=>{assert.equal(options.persist,false);reads++;return [structuredClone(saved)];},
    findGameByPath:(games,gamePath)=>games.find(game=>game.gamePath===gamePath),resolveModuleId:game=>game.moduleId,
    Modules:{getModule:()=>module,getModuleInfo:()=>info},resolveModuleSettings:()=>({}),
    normalizeGameEntry:game=>({...game,runtimeId:game.runtimeId||'default-player'}),
    resolveRuntimeForEntry:requested=>requested,saveGameRecord:game=>{saved=structuredClone(game);},
    backendService:{request:async()=>{await refreshing;return {saveLocations:[]};}},
    buildState:(_settings,games)=>({recents:games}),broadcastState:()=>{broadcasts++;},
    createRuntimeSettingsWindow:async value=>opened.push(structuredClone(value)),
    ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},cachedState:null};
  const source=fs.readFileSync(path.join(__dirname,'../src/main/main.js'),'utf8');
  for(const [startToken,endToken]of [['ipcMain.handle("launcher:setGameRuntime",','ipcMain.handle("launcher:setGameRuntimeSettings",'],
      ['ipcMain.handle("launcher:openRuntimeSettings",','ipcMain.handle("launcher:setLauncherSettings",']]){
    const start=source.indexOf(startToken),end=source.indexOf(endToken,start);assert(start>=0&&end>start);vm.runInNewContext(source.slice(start,end),context);
  }
  return {opened,context,finishRefresh,get saved(){return saved;},set saved(value){saved=value;},get broadcasts(){return broadcasts;},get reads(){return reads;},
    invoke:(name,payload,...args)=>handlers.get('launcher:'+name)(null,payload,...args)};
}

test('game settings use the saved runtime while its selection refresh and renderer snapshot are still pending',async()=>{
  const f=fixture(),changing=f.invoke('setGameRuntime',f.saved.gamePath,'new-player');
  assert.equal(f.saved.runtimeId,'new-player');assert.equal(f.broadcasts,0);
  assert.equal(await f.invoke('openRuntimeSettings',{scope:'game',gamePath:f.saved.gamePath,moduleId:'stale-engine',runtimeId:'old-player'}),true);
  assert.deepEqual(f.opened,[{scope:'game',gamePath:f.saved.gamePath,moduleId:'current-engine',runtimeId:'new-player'}]);
  f.finishRefresh();await changing;assert.equal(f.broadcasts,1);
});

test('module settings retain the explicitly requested module/runtime without reading game state',async()=>{
  const f=fixture();
  await f.invoke('openRuntimeSettings',{scope:'module',moduleId:' global-engine ',runtimeId:' alternate-player ',gamePath:'/ignored'});
  assert.deepEqual(f.opened,[{scope:'module',moduleId:'global-engine',runtimeId:'alternate-player'}]);assert.equal(f.reads,0);
});

test('game settings resolve saved defaults and reject missing entries instead of trusting stale request identities',async()=>{
  const f=fixture();f.saved={...f.saved,runtimeId:null};
  await f.invoke('openRuntimeSettings',{scope:'game',gamePath:f.saved.gamePath,runtimeId:'stale-player'});
  assert.equal(f.opened[0].runtimeId,'default-player');
  await assert.rejects(f.invoke('openRuntimeSettings',{scope:'game',gamePath:'/Games/Removed',runtimeId:'stale-player',moduleId:'stale-engine'}),/Game not found in library/);
  await assert.rejects(f.invoke('openRuntimeSettings',{scope:'game',runtimeId:'stale-player'}),/Missing game path/);
  await assert.rejects(f.invoke('openRuntimeSettings',{scope:'module',moduleId:'engine'}),/Missing runtime id/);
  await assert.rejects(f.invoke('openRuntimeSettings',{scope:'module',runtimeId:'player'}),/Missing module id/);
  assert.equal(f.opened.length,1);
});

test('network IPC persists one concrete choice and broadcasts the same legacy/default snapshot exposed by records',async t=>{
  const os=require('node:os'),GameStore=require('../src/core/game-store');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'network-ipc-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const saved={gameId:'network-ipc',gamePath:'/Games/Network',runtimeId:'player',moduleId:'web',
    runtimeSettings:{player:{enableProtections:false}},notes:'Keep',moduleData:{retained:true}};
  GameStore.writeGameRecord(root,saved);
  const handlers=new Map();let broadcasts=0;
  const source=fs.readFileSync(path.join(__dirname,'../src/main/main.js'),'utf8');
  const context={NetworkAccess:require('../src/core/network-access'),GAME_SCHEMA_VERSION:1,
    ReShade:{normalizeSettings:value=>value},GraphicsSettings:{normalizeSettings:value=>value},EffectsPlan:{normalize:value=>value},
    loadSettings:()=>({launcher:{networkAccess:false}}),loadGamesHydrated:options=>{
      assert.equal(options.persist,false);return [GameStore.readGameRecord(root,saved.gameId)];},
    findGameByPath:(games,gamePath)=>games.find(game=>game.gamePath===gamePath),
    launcherService:{runAction:async(entry,action,payload)=>{
      assert.equal(action,'setGameNetworkAccess');Object.assign(entry,GameStore.setGameNetworkAccess(root,entry.gameId,payload.networkAccess));}},
    gameRecordsCache:[structuredClone(saved)],buildState:(_settings,games)=>({recents:games}),
    broadcastState:()=>{broadcasts++;},cachedState:null,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)}};
  const start=source.indexOf('function serializeGameEntry('),end=source.indexOf('\nfunction isGameRemoving(',start);
  assert(start>=0&&end>start);vm.runInNewContext(source.slice(start,end),context);
  assert.equal(context.serializeGameEntry(saved).networkAccess,true,'saved legacy choice matches the inspector');
  const handlerStart=source.indexOf('ipcMain.handle("launcher:setGameNetworkAccess",');
  const handlerEnd=source.indexOf('\nrequire("../modules/shared/effects/presets-ipc")',handlerStart);
  assert(handlerStart>=0&&handlerEnd>handlerStart);vm.runInNewContext(source.slice(handlerStart,handlerEnd),context);
  const invoke=value=>handlers.get('launcher:setGameNetworkAccess')(null,saved.gamePath,value);
  for(const networkAccess of [true,false]){
    assert.equal(await invoke(networkAccess),true);
    assert.equal(GameStore.readGameRecord(root,saved.gameId).networkAccess,networkAccess);
    assert.equal(context.gameRecordsCache[0].networkAccess,networkAccess);
    assert.equal(context.cachedState.recents[0].networkAccess,networkAccess);
    assert.equal(context.serializeGameEntry(GameStore.readGameRecord(root,saved.gameId)).networkAccess,networkAccess);
  }
  assert.equal(broadcasts,2);
  await assert.rejects(invoke('false'),/Network access/);
  await assert.rejects(invoke(null),/Network access/);
  assert.equal(context.serializeGameEntry({...saved,networkAccess:null}).networkAccess,false);
  await assert.rejects(handlers.get('launcher:setGameNetworkAccess')(null,'/Games/Missing',true),/Game not found/);
  assert.equal(broadcasts,2);
  const record=GameStore.readGameRecord(root,saved.gameId);
  assert.equal(record.notes,'Keep');assert.deepEqual(record.moduleData,{retained:true});
  assert.deepEqual(record.runtimeSettings,saved.runtimeSettings);
});
