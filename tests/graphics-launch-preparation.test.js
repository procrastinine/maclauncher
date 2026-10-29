const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createLauncher}=require('../src/core/launcher'),Store=require('../src/core/game-store'),ReShade=require('../src/modules/shared/reshade'),Models=require('../src/modules/shared/reshade/neural/model-preparation');
test('initial Play graphics Off retries only graphics with latest settings while shared acquisition and another job continue',{timeout:5000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphics-preparation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const manifest={id:'fixture',runtime:{supported:['native'],default:'native',entries:{native:{graphicsHost:'window'}}}},registry={listModules:()=>[manifest],getModule:()=>({manifest}),getModuleInfo:()=>manifest};
 const launcher=createLauncher({userDataDir:root,registry,confirmRuntimeInstall:async()=>true,logger:{warn:()=>assert.fail('supersession is not a graphics failure')}}),wholePlay=new AbortController(),otherJob=new AbortController();
 const entry={gameId:'graphics-race',moduleId:'fixture',runtimeId:'native',gamePath:'/game',effects:{schema:2,mode:'advanced',enabled:true,video:[{id:'nr',kind:'neural',enabled:true,method:'mlx-dlss',settings:{modelPath:null}}]}};Store.writeGameRecord(root,entry);
 t.mock.method(require('../src/modules/shared/reshade/live-resources'),'supported',()=>true);
 let finishModel,startedResolve,sharedComplete=false;const started=new Promise(resolve=>{startedResolve=resolve;}),shared=new Promise(resolve=>{finishModel=()=>{sharedComplete=true;resolve({version:'model',modelPath:'/model'});};});const seen=[];
 t.mock.method(ReShade,'prepare',async(candidate,options)=>{
  seen.push({enabled:candidate.effects.enabled,settings:options.settings});
  await Models.prepare(require('../src/modules/shared/effects/plan').execution(candidate.effects),{...options,launchPreparation:true,ensureNeuralModel:()=>{startedResolve();return shared;}},{neural:{listModels:()=>[]},provider:{supportedMethods:['mlx-dlss']}});
  return {GRAPHICS_STATE:candidate.effects.enabled===false?'off':'on'};
 });
 const context=launcher.getLaunchContext(entry,undefined,{gameEffects:true,signal:wholePlay.signal});context.effectsEntry=structuredClone(entry);let refreshed=0;context.refreshGraphicsPreparation=async()=>{refreshed++;context.effectsEntry=structuredClone(entry);};
 const prepared=context.getGameEffectsEnvironment();await started;
 Store.writeGameRecord(root,{...entry,effects:{...entry.effects,enabled:false}});fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({runtimes:{'graphics-neural-models':{defaultVersions:{'mlx-dlss':'latest-choice'}}}}));
 assert.equal(context.invalidateGraphicsPreparation(),true);assert.deepEqual(await prepared,{GRAPHICS_STATE:'off'});assert.equal(wholePlay.signal.aborted,false);assert.equal(otherJob.signal.aborted,false);assert.equal(sharedComplete,false);assert.equal(refreshed,1);assert.deepEqual(seen.map(x=>x.enabled),[true,false]);assert.equal(seen[1].settings.runtimes['graphics-neural-models'].defaultVersions['mlx-dlss'],'latest-choice');assert.equal(context.graphicsPreparationFailure,undefined);
 finishModel();await new Promise(resolve=>setImmediate(resolve));assert.equal(sharedComplete,true);assert.deepEqual(await context.getGameEffectsEnvironment(),{GRAPHICS_STATE:'off'});assert.equal(seen.length,2,'late acquisition cannot revive the old snapshot');
});
