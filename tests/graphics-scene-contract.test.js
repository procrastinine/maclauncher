const test=require('node:test'),assert=require('node:assert/strict');
const Contracts=require('../src/modules/shared/effects/operation-contracts.mjs'),Requirements=require('../src/modules/shared/reshade/requirements'),Plan=require('../src/modules/shared/effects/plan');
test('scene attachment requirements keep one canonical packet shape and distinguish noisy color from texture slots',()=>{
 const requirements=Contracts.sceneInputRequirements(['normal','roughness','projectionMatrix','normal','noisyColor']);
 assert.deepEqual(requirements,{depth:false,motion:false,projectionMatrix:true,noisyColor:true,sceneAovs:['normal','roughness']});
 assert.deepEqual(Requirements.flags(requirements),requirements);assert.deepEqual(Contracts.sceneInputNames(requirements),['projectionMatrix','noisyColor','normal','roughness']);
 for(const sceneAovs of [['normal','normal'],['color'],['noisyColor'],'normal',[null]])assert.throws(()=>Requirements.flags({depth:false,motion:false,sceneAovs}),/requirements/);
 assert.throws(()=>Requirements.flags({...requirements,noisyColor:'true'}),/requirements/);
});
test('attachment availability follows declared data contracts across arbitrary runtime identities',()=>{
 const preset={id:'surface',label:'Surface effect',available:true,traits:{sceneInputs:['normal','roughness','projectionMatrix'],preservesCoordinates:true}};
 const row=graphicsInputs=>Plan.catalog({reshadeState:{available:true,presets:[preset]},graphicsInputs}).find(value=>value.id==='shader:surface');
 const pending=row({depth:true,projectionMatrix:true});assert.deepEqual(pending.pendingInputs,['normal','roughness']);assert.equal(pending.available,true);assert.match(pending.inputReason,/surface normals, roughness/);
 assert.deepEqual(row({projectionMatrix:true,sceneAovs:['normal','roughness']}).pendingInputs,['normal','roughness']);
 for(const host of ['arbitrary-metal','translated-client','software-producer']){
  const selected=row({host,projectionMatrix:true,sceneAovAPI:1,sceneAovs:['normal','roughness']});assert.equal(selected.pendingInputs,undefined);assert.equal(selected.available,true);
 }
 assert.equal(Contracts.sceneInputAvailable('noisyColor',{sceneAovAPI:1,sceneAovs:['noisyDiffuse','noisySpecular']}),false);
 assert.equal(Contracts.sceneInputAvailable('noisyColor',{noisyColor:true}),true);
});
test('scene attachment consumers preserve ordering constraints without imposing them on independent image filters',()=>{
 const shader=id=>({id,kind:'shader',enabled:true,shader:{preset:'grayscale'}}),plan={schema:2,mode:'advanced',enabled:true,video:[shader('warp'),shader('surface')]};
 assert.throws(()=>Plan.validateOrdering(plan,{nodes:{warp:{preservesCoordinates:false},surface:{requirements:{depth:false,motion:false,sceneAovs:['normal']},preservesCoordinates:true}}}),/matching coordinates/);
 assert.doesNotThrow(()=>Plan.validateOrdering(plan,{nodes:{warp:{preservesCoordinates:false},surface:{requirements:{depth:false,motion:false},preservesCoordinates:true}}}));
});
