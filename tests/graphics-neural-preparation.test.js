const test=require('node:test'),assert=require('node:assert/strict');
const Preparation=require('../src/modules/shared/reshade/neural/model-preparation'),Selection=require('../src/modules/shared/effects/neural-selection.mjs');
const plan={schema:2,mode:'advanced',enabled:true,video:[{id:'nr',kind:'upscale',method:'realesrgan',enabled:true,settings:{modelPath:null}}]};
test('estimated attachment model work follows only enabled consumers and master On',async()=>{
 const fog={id:'fog',kind:'shader',enabled:true,shader:{enabled:true,preset:'shader:native:estimated-depth-fog'},settings:{modelPath:null}};
 const selected={schema:2,mode:'advanced',enabled:true,video:[fog]},before=structuredClone(selected),idle={models:[],pending:[],modelOperations:{}};
 const unused={neural:{listModels:()=>assert.fail('inactive consumers must not inventory models')}};
 const options={launchPreparation:true,ensureNeuralModel:()=>assert.fail('inactive or already installed models must not acquire')};
 assert.deepEqual(await Preparation.prepare({...selected,enabled:false},options,unused),idle);
 assert.deepEqual(await Preparation.prepare({...selected,video:[{...fog,enabled:false}]},options,unused),idle);
 const operation='depth-anything-v2-small',model={method:operation,version:'installed-depth',modelPath:'/managed/small.depthmodel'};let inventories=0;
 const ready=await Preparation.prepare({...selected,video:[fog,{...plan.video[0],enabled:false}]},options,
  {neural:{listModels:()=>{inventories++;return [model];}}});
 assert.equal(inventories,1);assert.deepEqual(ready.modelOperations,{fog:operation});assert.deepEqual(ready.pending,[]);assert.deepEqual(ready.models,[model]);assert.deepEqual(selected,before);
});
test('canonical model preparation requests the exact curated operation and resumes with its installed copy',async()=>{
 const declined=await Preparation.prepare(plan,{launchPreparation:true,ensureNeuralModel:()=>assert.fail('a context without consent downloads nothing')},{neural:{listModels:()=>[]},provider:{supportedMethods:['realesrgan']}});assert.equal(declined.pending.length,1);
 let models=[],called=0;const result=await Preparation.prepare(plan,{launchPreparation:true,confirmRuntimeInstall:async()=>true,ensureNeuralModel:async request=>{called++;assert.equal(request.method,'realesrgan');assert.match(request.sourceVersion,/general/);models=[{method:'realesrgan',version:'general',modelPath:'/managed/general',curatedDefault:true}];return models[0];}},{neural:{listModels:()=>models},provider:{supportedMethods:['realesrgan']}});
 assert.equal(called,1);assert.deepEqual(result.pending,[]);assert.equal(result.models[0],models[0]);assert.equal(plan.video[0].settings.modelPath,null);
 const again=await Preparation.prepare(plan,{launchPreparation:true,ensureNeuralModel:()=>assert.fail('installed operation stays offline')},{neural:{listModels:()=>models}});assert.deepEqual(again.pending,[]);
});
test('Off and superseded model waits stay responsive without cancelling the shared acquisition',async()=>{
 const controller=new AbortController();let finish,acquired=false;const pending=Preparation.prepare(plan,{launchPreparation:true,signal:controller.signal,confirmRuntimeInstall:async()=>true,ensureNeuralModel:()=>new Promise(resolve=>{finish=()=>{acquired=true;resolve({version:'new'});};})},{neural:{listModels:()=>[]},provider:{supportedMethods:['realesrgan']}});
 await new Promise(resolve=>setImmediate(resolve));controller.abort(Object.assign(new Error('Off'),{name:'AbortError'}));await assert.rejects(pending,/Off/);finish();assert.equal(acquired,true);
 assert.deepEqual(await Preparation.prepare({...plan,video:plan.video.map(node=>({...node,enabled:false}))},{launchPreparation:true,ensureNeuralModel:()=>assert.fail('Off acquires no models')},{neural:{listModels:()=>assert.fail('Off inventories no models')}}),{models:[],pending:[],modelOperations:{}});
});
test('declined or unavailable sources retain a pending request while selection honors operation defaults',async t=>{
 const pending=await Preparation.prepare(plan,{launchPreparation:true,ensureNeuralModel:async()=>null},{neural:{listModels:()=>[]},provider:{supportedMethods:['realesrgan']}});assert.equal(pending.pending[0].id,'nr');assert.equal(pending.pending[0].retained,false);assert.match(pending.pending[0].reason,/model/);
 const rows=[{version:'anime',method:'realesrgan'},{version:'general',method:'realesrgan',curatedDefault:true},{version:'nr',method:'mlx-dlss'},{version:'rife',method:'rife'}];
 assert.equal(Selection.selectNeuralModel('realesrgan',rows).version,'general');assert.equal(Selection.selectNeuralModel('realesrgan',rows,{defaultVersions:{realesrgan:'anime'},defaultVersion:'rife'}).version,'anime');
 const Models=require('../src/modules/shared/reshade/neural/models'),Manager=require('../src/modules/shared/reshade/runtime/neural-models-manager');t.mock.method(Models,'listInstalled',()=>rows);
 const settings=Manager.updateSettingsAfterDefault({defaultVersion:'rife'},{version:'rife'},{userDataDir:'/owned',previousSettings:{defaultVersion:'nr'}});
 assert.deepEqual(settings.defaultVersions,{'mlx-dlss':'nr',rife:'rife'});assert.equal(Selection.selectNeuralModel('mlx-dlss',rows,settings).version,'nr');
});
test('a live edit names the curated source of a missing model for the status owner instead of downloading it',async()=>{
 const Setup=require('../src/modules/shared/reshade/neural/setup'),source=Setup.sourcesFor('realesrgan').find(row=>row.defaultForOperation)||Setup.sourcesFor('realesrgan')[0];
 const live=await Preparation.prepare(plan,{ensureNeuralModel:()=>assert.fail('a live edit never downloads during preparation')},{neural:{listModels:()=>[]}});
 assert.deepEqual(live.pending.map(row=>row.acquisition),[{operation:'realesrgan',source:{version:source.version,label:source.label,bytes:source.bytes,setupActionId:'downloadModel:'+source.version}}]);
 const launch=await Preparation.prepare(plan,{launchPreparation:true},{neural:{listModels:()=>[]}});
 assert.equal(launch.pending[0].acquisition,undefined,'launch preparation acquires its own models after consent');
});
