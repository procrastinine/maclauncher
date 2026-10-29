const test=require('node:test'),assert=require('node:assert/strict'),Plan=require('../src/modules/shared/effects/plan.mjs'),Requirements=require('../src/modules/shared/effects/execution-requirements');
const plan={schema:2,mode:'advanced',enabled:true,video:[]};
test('comparison defaults and bounds are canonical without enabling unrelated output policies',()=>{
 const selected=Plan.validate({...plan,output:{comparison:{mode:'wipe'}}});assert.deepEqual(selected.output,{comparison:{mode:'wipe',position:.5,gain:1}});assert.equal(selected.output.motionClarity,undefined);assert.equal(selected.output.framePacing,undefined);
 for(const comparison of[{mode:'record'},{mode:'wipe',position:-.01},{mode:'wipe',position:1.01},{mode:'difference',gain:0},{mode:'difference',gain:17},{mode:'before',extra:true}])assert.throws(()=>Plan.validate({...plan,output:{comparison}}));
});
test('master bypass preserves comparison requests while the executable plan has no output processing',()=>{
 const saved=Plan.validate({...plan,enabled:false,output:{comparison:{mode:'difference',gain:2}}}),before=structuredClone(saved),executable=Plan.execution(saved);assert.deepEqual(saved,before);assert.equal(executable.output,undefined);assert.equal(saved.output.comparison.mode,'difference');
});
test('comparison-only plans require ordinary shared image processing and no unrelated providers',()=>{
 const selected={effects:{...plan,output:{comparison:{mode:'before'}}}},demand=Requirements.analyze(selected);assert.equal(demand.needed.processor,true);assert.equal(demand.needed.presentation,true);assert.equal(demand.needed.comparison,true);for(const name of['shaders','neural','generation','losslessModel','temporal','motionClarity'])assert.equal(demand.needed[name],false);assert.equal(Requirements.analyze({effects:{...selected.effects,enabled:false}}).needed.processor,false);assert.equal(Requirements.analyze({effects:{...plan,output:{comparison:{mode:'off'}}}}).needed.processor,false);
});
