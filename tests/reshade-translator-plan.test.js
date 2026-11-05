const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Plan = require('../src/modules/shared/runtime/translator-plan');
const Binding = require('../src/modules/shared/reshade/launch-binding');
const ReShade = require('../src/modules/shared/reshade'), Effects = require('../src/modules/shared/effects/runtime');
const components = {'d3d-renderer':['d3dmetal','dxmt','dxvk','wined3d'], d3d12:['d3dmetal','vkd3d','vkd3d-proton'], 'vulkan-driver':['moltenvk','kosmickrisp'], video:['gstreamer']};
function description(component, engine, id, source) {return {component, engine, id, source, root:'/fixture/'+id, files:[], version:'label', form:component==='vulkan-driver'?(source==='included'?'dylib':'icd'):source==='managed'||source==='custom'?'native':'builtin'};}
function poisonSelection(plan) {
  for (const row of Object.values(plan.components)) Object.defineProperty(row,'selected',{get(){assert.fail('graphics must never read the requested selection');}});
  return plan;
}
function fixture(t) {
  const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reshade-plan-'))), root=path.join(temporary,'runtime'), userDataDir=path.join(temporary,'profile');
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'effects'),{recursive:true});fs.mkdirSync(userDataDir);
  for(const name of ['libreshade-macos.dylib','fx-compile','effects/grayscale.fx'])fs.writeFileSync(path.join(root,name),'fixture');
  fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({schema:1,version:'test',minimumMacOS:'13.0',features:{shaders:{formats:['fx']},graphics:{effectPlanAPI:1,screenshotAPI:1,frameGenerationMethods:['vision-flow'],presentation:{hosts:{window:{frameGeneration:true,liveSwitching:true}}}}}}));
  const options={root,userDataDir,platform:'darwin',macOSVersion:'27.0',graphicsHost:'window',graphicsArchitecture:'x86_64',diagnostics:false,gpuTiming:false,trace:false,verify:()=>true,
    settings:{launcher:{graphicsShortcuts:{screenshot:true}}},execute:async(_command,args)=>{if(args[0]==='--prepare')fs.copyFileSync(args[1],args[2]);else{fs.writeFileSync(path.join(args[1],'textures.json'),'[]');fs.writeFileSync(path.join(args[1],'uniforms.json'),'[]');}}};
  const entry={gameId:'plan-game',effects:{schema:2,mode:'advanced',enabled:true,video:[{id:'tone',kind:'shader',enabled:true,shader:{preset:'grayscale'}},{id:'gen',kind:'frame-generation',enabled:true,method:'vision-flow',settings:{frameGeneration:'vision-flow',frameMultiplier:2}}]}};
  return {root,userDataDir,options,entry};
}
test('every resolved translator/form and fallback retains the shared presentation, capture and image-generation paths',async t=>{
 const f=fixture(t);let cases=0;
 for(const runtime of ['crossover','sikarugir'])for(const [component,engines]of Object.entries(components))for(const engine of engines)for(const source of ['included','template','managed','custom']){
  const chosen=description(component,engine,'chosen',source),included=description(component,engine,'vendor','included');
  const args={runtime,selections:{[component]:chosen.id},choices:[chosen],included:[included]};
  const plans=[Plan.resolvePlan(args),Plan.resolvePlan({...args,compatibility:{chosen:{compatible:false,reason:'Missing required file'}}}),Plan.resolvePlan({...args,included:[],compatibility:{chosen:{compatible:false,reason:'Missing CPU slice'}}}),Plan.resolvePlan({runtime,environment:{selections:{[component]:chosen}}})];
  for(const plan of plans){const used=plan.components[component].used;poisonSelection(plan);
   const inputs={architecture:'x86_64',depth:false,motionVectors:false,source:'window-capture',methods:[]};
   const env=await ReShade.prepare(f.entry,{...f.options,translatorPlan:plan,graphicsInputs:inputs});
   assert.equal(env.DYLD_INSERT_LIBRARIES,path.join(f.root,'libreshade-macos.dylib'));assert.equal(env.RESHADE_EXPLICIT_HOST,undefined);
   assert.equal(env.RESHADE_CAPTURE_FINAL,'1');assert.ok(env.RESHADE_CAPTURE_TRIGGER);assert.equal(env.RESHADE_LAYER_SURFACE,'1');
   const launch=JSON.parse(fs.readFileSync(path.join(path.dirname(env.RESHADE_EFFECT_PLAN),'launch.json'))),document=JSON.parse(fs.readFileSync(env.RESHADE_EFFECT_PLAN));
   assert.equal(launch.graphicsHost,'window');assert.deepEqual(launch.graphicsInputs,inputs);assert.deepEqual(launch.translatorPlan.components[component],{used});
   assert.deepEqual(document.nodes.filter(n=>n.enabled).map(n=>n.kind),['shader','frame-generation']);assert.equal(document.nodes.find(n=>n.id==='gen').method,'vision-flow');assert.equal(document.nodes.filter(n=>n.id==='tone').length,1);
   assert.equal('selected'in launch.translatorPlan.components[component],false);cases++;
  }
 }
 assert.equal(cases,320);
});
test('unresolved vendor automatic, unknown engines and independent D3D12/driver choices remain honest',()=>{
 const plan=Plan.resolvePlan({runtime:'crossover'});assert.equal(Binding.usedTranslatorPlan(plan).components['d3d-renderer'].used,null);
 const used=description('d3d-renderer','future-engine','future','custom'),d12=description('d3d12','vkd3d-proton','d12','managed'),vk=description('vulkan-driver','kosmickrisp','vk','managed');
 const resolved=Plan.resolvePlan({choices:[used,d12,vk],selections:{'d3d-renderer':'future',d3d12:'d12','vulkan-driver':'vk'}});poisonSelection(resolved);
 assert.equal(Binding.usedTranslatorPlan(resolved).components['d3d-renderer'].used,used);assert.equal(Binding.usedTranslatorPlan(resolved).components.d3d12.used,d12);assert.equal(Binding.usedTranslatorPlan(resolved).components['vulkan-driver'].used,vk);
 for(const variant of ['dxvk','dxvk3','d9vk','dxvk-async','d9vk-async']){
  const value={...description('d3d-renderer','dxvk',variant,'template'),templateComponent:variant};
  const variantPlan=poisonSelection(Plan.resolvePlan({choices:[value],selections:{'d3d-renderer':variant}}));assert.equal(Binding.usedTranslatorPlan(variantPlan).components['d3d-renderer'].used,value);
 }
 for(const architecture of ['arm64','x86_64'])for(const engine of ['moltenvk','kosmickrisp']){
  const value={...description('vulkan-driver',engine,engine+architecture,'managed'),files:[{path:'/fixture/'+engine,format:'macho',cpuSlices:[architecture]}]};
  const driverPlan=poisonSelection(Plan.resolvePlan({choices:[value],selections:{'vulkan-driver':value.id}}));assert.deepEqual(Binding.usedTranslatorPlan(driverPlan).components['vulkan-driver'].used,value);
 }
 assert.equal(Binding.usedTranslatorPlan(null),undefined);
});
test('running graphics bind the used plan and supplier guides instead of new saved choices',async t=>{
 const f=fixture(t),used=description('d3d-renderer','dxmt','active','included'),next=description('d3d-renderer','wined3d','next','included');
 const active=poisonSelection(Plan.resolvePlan({choices:[used],selections:{'d3d-renderer':'active'}})),future=poisonSelection(Plan.resolvePlan({choices:[next],selections:{'d3d-renderer':'next'}}));
 const inputs={depth:true,motionVectors:true,jitter:true,exposure:true,source:'xess',methods:['metalfx']};
 const env=await ReShade.prepare(f.entry,{...f.options,translatorPlan:active,graphicsInputs:inputs});
 const file=path.join(path.dirname(env.RESHADE_EFFECT_PLAN),'launch.json'),launch=JSON.parse(fs.readFileSync(file));Object.assign(launch,{phase:'spawned',pid:71});fs.writeFileSync(file,JSON.stringify(launch));
 const info=Effects.info(f.entry,{...f.options,running:true,runningPids:[71],translatorPlan:future,graphicsInputs:{depth:false}});
 assert.deepEqual(info.translatorPlan,launch.translatorPlan);assert.deepEqual(info.activeLaunch.translatorPlan,launch.translatorPlan);assert.deepEqual(info.graphicsInputs,inputs);
 const originalState=ReShade.launchState,seen=[];t.mock.method(ReShade,'launchState',options=>{seen.push(options.translatorPlan);return originalState(options);});
 const edited=await Effects.prepare(f.entry,{...f.options,live:true,runningPids:[71],translatorPlan:future,graphicsInputs:inputs});
 assert.equal(edited.document.nodes.filter(row=>row.enabled).length,2);assert.ok(seen.length);for(const plan of seen)assert.deepEqual(plan,launch.translatorPlan,'live compilation must use the running closure');

 const legacy={...launch};delete legacy.translatorPlan;fs.writeFileSync(file,JSON.stringify(legacy));
 assert.equal(Effects.info(f.entry,{...f.options,running:true,runningPids:[71],translatorPlan:future}).translatorPlan.components['d3d-renderer'].used.id,'next');
});
test('discovery cache follows used files/root and ignores changes to the requested choice',t=>{
 const f=fixture(t),empty={...f.entry,effects:{schema:2,mode:'advanced',enabled:true,video:[]}},used=description('d3d-renderer','dxmt','current','included');
 const plan=poisonSelection(Plan.resolvePlan({choices:[used],selections:{'d3d-renderer':'current'}}));
 const original=ReShade.getState;let reads=0;t.mock.method(ReShade,'getState',(...args)=>{reads++;return original(...args);});
 const options={...f.options,inventoryRevision:'same-catalog',translatorPlan:plan};
 Effects.info(empty,options);assert.equal(reads,1);
 const requestedOnly={runtime:plan.runtime,components:Object.fromEntries(Object.entries(plan.components).map(([key,row])=>[key,{used:row.used}]))};
 requestedOnly.components['d3d-renderer'].value='another-request';poisonSelection(requestedOnly);
 Effects.info(empty,{...options,translatorPlan:requestedOnly});assert.equal(reads,1,'a request that did not load cannot change graphics discovery');
 const changed=Plan.resolvePlan({choices:[{...used,root:'/fixture/replacement',files:[{path:'/fixture/replacement/d3d11.dll'}]}],selections:{'d3d-renderer':'current'}});poisonSelection(changed);
 Effects.info(empty,{...options,translatorPlan:changed});assert.equal(reads,2,'the actual replacement closure cannot reuse old graphics discovery');
});
