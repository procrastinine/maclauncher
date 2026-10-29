const test=require('node:test'),assert=require('node:assert/strict');
const Plan=require('../src/modules/shared/effects/plan.mjs'),Requirements=require('../src/modules/shared/effects/execution-requirements');
const plan={schema:2,mode:'advanced',enabled:true,video:[]};
test('explicit output color requests survive canonical edits while master bypass removes executable work',()=>{
 for(const toneMapping of ['preserve','reinhard','pbr-neutral']){
  const saved=Plan.validate({...plan,output:{toneMapping}}),before=structuredClone(saved);
  assert.deepEqual(Plan.normalize(saved),before);
  const off=Plan.execution({...saved,enabled:false});assert.equal(off.output,undefined);assert.deepEqual(saved,before);
 }
 for(const toneMapping of ['scene',null,{},false])assert.throws(()=>Plan.validate({...plan,output:{toneMapping}}),/tone mapping/);
});
test('output-only processing needs one shared presenter and no shader/model/scene provider discovery',()=>{
 for(const toneMapping of ['preserve','reinhard','pbr-neutral']){
  const demand=Requirements.analyze({effects:{...plan,output:{toneMapping}}});
  for(const key of ['outputColor','processor','ordered','presentation'])assert.equal(demand.needed[key],true,key);
  for(const key of ['shaders','neural','losslessModel','temporal','generation','sourceResolution','motionClarity','comparison'])assert.equal(demand.needed[key],false,key);
  assert.equal(Requirements.analyze({effects:{...plan,enabled:false,output:{toneMapping}}}).needed.processor,false);
 }
 assert.equal(Requirements.analyze({effects:{...plan,output:{toneMapping:'auto'}}}).needed.processor,false);
});
