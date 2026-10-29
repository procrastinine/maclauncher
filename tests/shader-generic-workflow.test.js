const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),vm=require('node:vm'),React=require('react');
const {build}=require('vite'),{react,componentHarness}=require('./helpers/renderer-component');
let EffectsControls,ShaderLibraryFamily,ReShadeFilterLibrary;
async function component(name){const result=await build({configFile:false,logLevel:'silent',build:{ssr:path.join(__dirname,'../src/renderer/src/ui/components/'+name+'.tsx'),write:false,rollupOptions:{external:id=>/^react(?:-dom)?(?:\/|$)/.test(id),output:{format:'cjs',codeSplitting:false}}}});const m=new Module(path.join(__dirname,name+'-drop.cjs'),module);m.paths=module.paths;m.require=id=>id==='react'?react:Module.prototype.require.call(m,id);m._compile(result.output.find(row=>row.type==='chunk').code,m.id);return m.exports[name];}
test.before(async()=>{[EffectsControls,ShaderLibraryFamily,ReShadeFilterLibrary]=await Promise.all(['EffectsControls','ShaderLibraryFamily','ReShadeFilterLibrary'].map(component));});
// Hook-free graphics views render through their editor props.
const views=new Set(['SourceResolutionControls','SourcePolicyControls','SimpleEffectsView','AdvancedEffectsView','EffectRowControls','OutputPolicyControls','GraphicsStatusLabel']);
const elements=n=>React.isValidElement(n)?[n,...React.Children.toArray(typeof n.type==='function'&&views.has(n.type.name)?n.type(n.props):n.props.children).flatMap(elements),...elements(n.props.toolbar)]:[];
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const original={id:'original',kind:'shader',enabled:true,shader:{enabled:true,preset:'crt',parameters:{Strength:[.7]}}};
function event(file){return{defaultPrevented:false,dataTransfer:{files:[{path:file}],items:[],types:['Files'],getData(){return'';}},preventDefault(){this.defaultPrevented=true;}};}
function setup(before,rows,options={}){const writes=[],calls=[],props={game:{gamePath:'/Game',effects:before},running:false,status:{available:true,presets:[]},editor:{info:{plan:before,catalog:options.catalog||[]},onChange:next=>writes.push(next),pickFile:options.pickFile||(()=>Promise.resolve(null))}};global.window={MacLauncher:{launcher:{importReShadeFilters:async(family,paths)=>{calls.push({family,paths});return typeof rows==='function'?rows():rows;}}}};const h=componentHarness(EffectsControls,props);elements(h.render()).find(n=>n.type==='button'&&n.props.children===(options.advanced?'Advanced':'Simple')).props.onClick();return{h,props,writes,calls};}
test('every shader format drops through one registration and canonical image-node path without semantic placement gates',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});
 const formats=[['fx','fx'],['slangp','slangp'],['slang','slang'],['libplacebo','hook'],['libplacebo','cube'],['libplacebo','plfilter'],['isf','fs'],['isf','isf'],['magpie','hlsl'],['native','mclfilter']];
 for(const [index,[format,extension]]of formats.entries()){
  const file='/Sources/Original.'+extension,filter={id:id(index+1),name:'Manual '+extension,path:file,format,available:true,traits:{category:'upscaling',neural:true},outputContract:{domain:'image',sizing:'preserve',extentEditable:false}},before={schema:2,mode:'advanced',enabled:true,video:[structuredClone(original)]},f=setup(before,[filter]);
  try{const drop=event(file);elements(f.h.render()).find(n=>n.type==='section'&&n.props.className==='effectsControls').props.onDrop(drop);assert.equal(drop.defaultPrevented,true);await f.h.settle();const next=f.writes.at(-1);assert.ok(next,extension);assert.deepEqual(f.calls,[{family:undefined,paths:[file]}]);assert.equal(next.video.length,2);assert.deepEqual(next.video[0],original);assert.equal(next.video[1].kind,'shader');assert.equal(next.video[1].shader.preset,'filter:'+filter.id);assert.equal(next.video[1].extent,undefined);assert.equal(next.renderResolution,undefined,'semantic tags cannot add resize helpers');}finally{f.h.close();}
 }
});
test('compatible fixed-size replacement preserves newer Off and independent settings; stale source selection never attaches',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});const old={id:'scale',kind:'shader',enabled:true,shader:{enabled:true,preset:'filter:'+id(40)},extent:{relativeTo:'input',factor:2}},before={schema:2,mode:'advanced',enabled:true,video:[old,structuredClone(original)],renderResolution:{height:720}};
 const replacement={id:id(41),name:'Manual intrinsic',path:'/Sources/Intrinsic.hlsl',format:'magpie',available:true,outputContract:{domain:'image',sizing:'intrinsic',scale:{x:2,y:2},extentEditable:false}},catalog=[{id:'old',kind:'shader',label:'Old',group:'Resize',available:true,template:old,outputContract:{domain:'image',sizing:'stage',extentEditable:true}}];let finish;
 const f=setup(before,()=>new Promise(r=>{finish=r;}),{advanced:true,catalog});
 try{const target=elements(f.h.render()).find(n=>n.type==='div'&&/\beffectMethodRow\b/.test(n.props.className));target.props.onDrop(event(replacement.path));elements(f.h.render()).find(n=>n.props.id==='effect-scale-enabled').props.onChange({target:{checked:false}});await f.h.settle();finish([replacement]);await f.h.settle();const next=f.writes.at(-1);assert.equal(next.video[0].shader.preset,'filter:'+replacement.id);assert.equal(next.video[0].enabled,false);assert.equal(next.video[0].extent,undefined);assert.deepEqual(next.video[1],original);assert.deepEqual(next.renderResolution,before.renderResolution);}finally{f.h.close();}
 let resolve;const second=setup(before,()=>new Promise(r=>{resolve=r;}),{advanced:true,catalog});
 try{elements(second.h.render()).find(n=>n.type==='div'&&/\beffectMethodRow\b/.test(n.props.className)).props.onDrop(event(replacement.path));elements(second.h.render()).find(n=>n.props.id==='effect-scale-enabled').props.onChange({target:{checked:false}});await second.h.settle();elements(second.h.render()).find(n=>n.type==='button'&&n.props['aria-label']==='Remove Old').props.onClick();await second.h.settle();const count=second.writes.length;resolve([replacement]);await second.h.settle();assert.equal(second.writes.length,count);assert.deepEqual(second.writes.at(-1).video,[original]);}finally{second.h.close();}
});
test('manual file selection registers metadata before attaching and newer model choice survives a pending import',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});const file='/Sources/Manual.cube',filter={id:id(50),name:'Manual LUT',path:file,format:'libplacebo',available:true,outputContract:{domain:'image',sizing:'preserve',extentEditable:false}},node={id:'file',kind:'shader',enabled:true,shader:{enabled:true,preset:'custom',effectPath:'/Sources/Previous.fx'}},before={schema:2,mode:'advanced',enabled:true,video:[node]};
 const f=setup(before,[filter],{advanced:true,pickFile:async()=>file,catalog:[{id:'custom',kind:'shader',label:'Custom',group:'Image filters',available:true,template:node,outputContract:{domain:'image',sizing:'stage',extentEditable:true}}]});
 try{elements(f.h.render()).find(n=>n.type==='button'&&n.props.children==='Choose shader…').props.onClick();await f.h.settle();assert.equal(f.writes.at(-1).video[0].shader.preset,'filter:'+filter.id);assert.deepEqual(f.calls,[{family:undefined,paths:[file]}]);}finally{f.h.close();}
 const model={id:'fog',kind:'shader',enabled:true,shader:{enabled:true,preset:'filter:'+id(51)},settings:{modelPath:null}},plan={schema:2,mode:'advanced',enabled:true,video:[model]},choice={id:'fog-choice',kind:'shader',label:'Model consumer',group:'Image filters',available:true,modelOperation:'depth-anything-v2-small',template:model,outputContract:{domain:'image',sizing:'preserve',extentEditable:false}};let done;
 const m=setup(plan,[],{advanced:true,catalog:[choice],pickFile:()=>new Promise(r=>{done=r;})});
 try{let controls=elements(m.h.render()).find(n=>n.props.nodeId==='fog'&&n.props.method==='depth-anything-v2-small');controls.props.onImport();controls.props.onChange('/Models/Later.depthmodel');await m.h.settle();const count=m.writes.length;done('/Models/Earlier.depthmodel');await m.h.settle();assert.equal(m.writes.length,count);assert.equal(m.writes.at(-1).video[0].settings.modelPath,'/Models/Later.depthmodel');}finally{m.h.close();}
});
test('library uses returned contracts, then reveals imported type without source/format privilege',()=>{
 const fixed={id:id(60),name:'Tagged upscaling but fixed',path:'/Sources/Fog.mclfilter',format:'native',available:true,traits:{category:'upscaling'},outputContract:{domain:'image',sizing:'preserve',extentEditable:false}},up={id:id(61),name:'Manual up',path:'/Sources/Two.slangp',format:'slangp',available:true,outputContract:{domain:'image',sizing:'intrinsic',scale:{x:2,y:2},extentEditable:false}},props={active:true,collections:[],filters:[fixed],shaderCategory:'downsample',onSelectCollection(){}};const h=componentHarness(ShaderLibraryFamily,props);
 try{let tree=h.render(),library=elements(tree).find(n=>n.type===ReShadeFilterLibrary||n.props.showDownloads===false);assert.deepEqual(library.props.filters,[]);elements(tree).find(n=>n.props.id==='shader-library-search').props.onChange({target:{value:'old query'}});library.props.onImported([up]);props.filters=[fixed,up];tree=h.render();assert.equal(elements(tree).find(n=>n.props.id==='shader-library-type').props.value,'upscale');assert.equal(elements(tree).find(n=>n.props.id==='shader-library-search').props.value,'');library=elements(tree).find(n=>n.props.showDownloads===false);assert.deepEqual(library.props.filters,[up]);}finally{h.close();}
});
test('Advanced replacement from a builtin resize opens Custom and keeps unknown editable shaders in the intended slot',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});const node={id:'resize',kind:'downsample',method:'bilinear',enabled:true,settings:{},outputSize:{width:128}},plan={schema:2,mode:'advanced',enabled:true,video:[node]},file='/Sources/Requested.hlsl',filter={id:id(65),name:'Requested target',path:file,format:'magpie',available:true,outputContract:{domain:'image',sizing:'shader',extentEditable:true}};
 const builtin={id:'downsample:bilinear',kind:'downsample',label:'Bilinear',group:'Resize',available:true,template:node,outputContract:{domain:'image',sizing:'stage',direction:'downsample',extentEditable:true}},custom={id:'shader:custom',kind:'shader',label:'Custom',group:'Image filters',available:true,template:{kind:'shader',enabled:true,shader:{enabled:true,preset:'custom'}},outputContract:{domain:'image',sizing:'shader',extentEditable:true}},registered={...custom,id:'shader:filter:'+filter.id,label:filter.name,template:{...custom.template,shader:{enabled:true,preset:'filter:'+filter.id}}};
 for(const selected of [custom,registered]){let picks=0;const f=setup(plan,[filter],{advanced:true,pickFile:async()=>{picks++;return file;},catalog:[builtin,custom,registered]});
  try{elements(f.h.render()).find(n=>n.props.id==='effect-choice-resize').props.onChange({target:{value:selected.id}});await f.h.settle();const result=f.writes.at(-1).video[0];assert.equal(picks,selected===custom?1:0);assert.equal(result.kind,'shader');assert.equal(result.shader.preset,'filter:'+filter.id);assert.deepEqual(result.extent,{width:128});assert.equal(result.id,node.id);}finally{f.h.close();}
 }
});
test('same-path source revisions refresh metadata and parameter schema without changing the selected plan',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});const filter={id:id(70),name:'Editable source',path:'/Sources/Editable.fx',format:'fx',available:true,sourceRevision:'source-a'},node={id:'revision',kind:'shader',enabled:true,shader:{enabled:true,preset:'filter:'+filter.id,parameters:{Original:[.5]}}},plan={schema:2,mode:'advanced',enabled:true,video:[node]};
 let revision='source-a',reads=0,parameters=[{name:'Original',label:'Original',type:'float',default:[1]}];
 const choice=()=>({id:'shader:filter:'+filter.id,kind:'shader',label:filter.name,group:'Image filters',available:true,sourceRevision:revision,template:node,outputContract:{domain:'image',sizing:'preserve',extentEditable:false}});
 global.window={MacLauncher:{launcher:{async getGameEffects(){reads++;return{plan,catalog:[choice()]};},async getGameEffectParameters(){return{parameters};},async setGameEffects(){throw Error('A metadata refresh must not write settings.');}}}};
 const props={game:{gamePath:'/Game',effects:plan},running:false,status:{available:true,presets:[],filters:[filter],shaderParameters:true}},h=componentHarness(EffectsControls,props);
 try{h.render();await h.settle();elements(h.render()).find(n=>n.type==='button'&&n.props.children==='Advanced').props.onClick();let control=elements(h.render()).find(n=>n.props.idPrefix==='effect-revision');const firstKey=control.key;assert.equal((await control.props.loadParameters()).parameters[0].name,'Original');
  revision='source-b';parameters=[{name:'Replacement',label:'Replacement',type:'bool',default:[0]}];props.status={...props.status,filters:[{...filter,sourceRevision:revision}]};h.render();await h.settle();control=elements(h.render()).find(n=>n.props.idPrefix==='effect-revision');assert.notEqual(control.key,firstKey,'new source/include metadata remounts the schema controls');assert.equal((await control.props.loadParameters()).parameters[0].name,'Replacement');assert.equal(reads,2);assert.deepEqual(props.game.effects,plan);
 }finally{h.close();}
 const custom={...node,shader:{...node.shader,preset:'custom',effectPath:'/Sources/Original.hlsl'}},customPlan={...plan,video:[custom]},customProps={game:{gamePath:'/Custom',effects:customPlan},running:false,status:{available:true,presets:[],shaderParameters:true},editor:{info:{plan:customPlan,catalog:[],nodeCatalog:{revision:{...choice(),template:custom,nodeId:custom.id,selectionKey:require('../src/modules/shared/effects/selection-key.mjs').effectSelectionKey(custom),sourceRevision:'custom-a'}}},onChange(){throw Error('Metadata must not write settings.');},async parameters(){return{parameters};}}},direct=componentHarness(EffectsControls,customProps);
 try{elements(direct.render()).find(n=>n.type==='button'&&n.props.children==='Advanced').props.onClick();const key=elements(direct.render()).find(n=>n.props.idPrefix==='effect-revision').key;customProps.editor.info={...customProps.editor.info,nodeCatalog:{revision:{...customProps.editor.info.nodeCatalog.revision,sourceRevision:'custom-b'}}};direct.render();await direct.settle();assert.notEqual(elements(direct.render()).find(n=>n.props.idPrefix==='effect-revision').key,key,'direct custom sources use the same per-node revision');}finally{direct.close();}
});
test('explicit-path IPC skips dialogs, validates every family through registered formats and refreshes selected IDs only',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shader-import-api-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=fs.readFileSync(path.join(__dirname,'../src/main/main.js'),'utf8'),body=source.slice(source.indexOf('ipcMain.handle("launcher:importReShadeFilters"'),source.indexOf('ipcMain.handle("launcher:updateReShadeFilter"'));let handler,dialogs=0,published=0,refresh=[],imports=0,pickerFiles;
 const Filters=require('../src/modules/shared/reshade/filter-library');const context={ipcMain:{handle(_name,fn){handler=fn;}},ReShadeFilters:Filters,GraphicsImports:{importFilters(_dir,files){imports++;return[{id:'unrelated',path:path.join(root,'unrelated.fx')},...files.map((file,i)=>({id:String(i),path:file}))];}},fs,path,userDataDir:root,BrowserWindow:{fromWebContents(){return null;}},getLauncherDialogOwner(){return null;},dialog:{async showOpenDialog(){dialogs++;return pickerFiles?{canceled:false,filePaths:pickerFiles}:{canceled:true,filePaths:[]};}},publishReShadeFilters(){published++;},refreshShaderSelections(ids){refresh.push(Array.from(ids));},Set,Error};vm.runInNewContext(body,context);
 for(const[family,extension]of [['reshade','fx'],['libretro','slang'],['libretro','slangp'],['mpv','glsl'],['mpv','hook'],['mpv','cube'],['mpv','plfilter'],['isf','fs'],['isf','isf'],['magpie','hlsl'],['native','mclfilter']]){const file=path.join(root,'manual.'+extension);fs.writeFileSync(file,'Original');const result=await handler({sender:{}},family,[file]);assert.equal(result.length,1);assert.equal(result[0].path,file);assert.deepEqual(refresh.at(-1),['filter:0']);assert.equal(fs.readFileSync(file,'utf8'),'Original');}
 assert.equal(dialogs,0);assert.equal(published,11);assert.equal(imports,11);await assert.rejects(handler({sender:{}},'native',[path.join(root,'manual.fx')]),/selected family/);assert.equal(imports,11);assert.equal(await handler({sender:{}},undefined),null);assert.equal(dialogs,1);
 pickerFiles=[path.join(root,'manual.fx')];const chosen=await handler({sender:{}},undefined);assert.deepEqual(Array.from(chosen,row=>row.path),pickerFiles,'native picker and drop report only imported selections, while publishing the full catalog');assert.deepEqual(refresh.at(-1),['filter:0']);assert.equal(published,12);
});
test('Simple image filter removal preserves independent rows and removes only owned NR helpers',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});
 const nr={id:'nr',kind:'neural',method:'mlx-dlss',enabled:true,settings:{modelPath:null}},manual={id:'manual',kind:'downsample',method:'bilinear',enabled:true,extent:{width:100},settings:{}},film={...original,id:'film'};
 const before={schema:2,mode:'advanced',enabled:true,video:[manual,{...manual,id:'auto-nr-input-nr'},nr,{id:'auto-nr-fit-nr',kind:'upscale',method:'bilinear',enabled:true,settings:{}},film]},catalog=[{id:'neural:mlx-dlss',kind:'neural',label:'Neural rendering',group:'Image filters',available:true,template:nr,outputContract:{domain:'image',sizing:'preserve'}},{id:'shader:crt',kind:'shader',label:'Film',group:'Image filters',available:true,template:film,outputContract:{domain:'image',sizing:'preserve'}}];
 const f=setup(before,[],{catalog});try{const tree=f.h.render();elements(tree).find(n=>n.type==='button'&&n.props['aria-label']==='Remove Neural rendering').props.onClick();await f.h.settle();assert.deepEqual(f.writes.at(-1).video,[manual,film]);}finally{f.h.close();}
});
test('custom processing percentages and Game resolution percentages use canonical independent sizes',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});const node={id:'resize',kind:'downsample',enabled:true,method:'bilinear',outputSize:{width:128},settings:{spatialMultiplier:.5}},plan={schema:2,mode:'advanced',enabled:true,video:[node]},writes=[];
 const props={game:{gamePath:'/Game',effects:plan},running:false,editor:{info:{plan,catalog:[{id:'downsample:bilinear',kind:'downsample',label:'Bilinear',group:'Resize',available:true,template:node}],sourceResolution:{heights:false,multipliers:[],processing:true}},onChange:next=>writes.push(next),pickFile:async()=>null}};
 global.window={};const h=componentHarness(EffectsControls,props);
 try{let tree=h.render();const source=elements(tree).find(n=>n.props.capabilities&&n.props.onChange),s=componentHarness(source.type,source.props);
  try{elements(s.render()).find(n=>n.props.id==='effects-game-rendering').props.onChange({target:{value:'percentage'}});await h.settle();const requested=writes.at(-1);assert.equal(requested.renderResolution.multiplier,2);assert.deepEqual(requested.video,plan.video);
  }finally{s.close();}
  elements(h.render()).find(n=>n.type==='button'&&n.props.children==='Advanced').props.onClick();tree=h.render();const settings=elements(tree).find(n=>n.props.node?.id==='resize'&&n.props.onExtentChange),g=componentHarness(settings.type,settings.props);
  try{const resize=elements(g.render()).find(n=>n.props.nodeId==='resize'&&n.props.onChange&&'extent'in n.props),r=componentHarness(resize.type,{...resize.props,extent:{relativeTo:'presentation',factor:.5}});
   try{const field=elements(r.render()).find(n=>n.props.id==='effect-resize-percentage');assert.equal(field.props.max,1600);field.props.onValue(37.25);await h.settle();const sized=writes.at(-1).video[0];assert.deepEqual(sized.extent,{relativeTo:'presentation',factor:.3725});assert.equal(sized.outputSize,undefined);assert.equal(sized.settings.spatialMultiplier,undefined);assert.equal(writes.at(-1).renderResolution.multiplier,2);}finally{r.close();}
  }finally{g.close();}
 }finally{h.close();}
});
test('size summaries retain unknown and conditional geometry and identify the actual collection',()=>{
 const {implementationOutputSummary:label,implementationHelp:help}=require('../src/modules/shared/effects/presentation.mjs');
 assert.equal(label({outputContract:{sizing:'preserve'}}),'Same size');
 assert.equal(label({outputContract:{sizing:'stage',preservesSize:true}}),'Same size');
 assert.equal(label({outputContract:{sizing:'stage',compositeTarget:true,preservesSize:true}}),'Size set in options');
 assert.equal(label({outputContract:{sizing:'shader',resizeDirections:[]},traits:{geometryKnown:false}}),'Unknown size');
 assert.equal(label({outputContract:{sizing:'shader',scaleRange:{min:{x:1,y:1},max:{x:2,y:2}}}}),'Up to 2×');
 assert.equal(label({outputContract:{sizing:'intrinsic',scale:{x:2,y:2}}}),'2×');
 assert.equal(label({outputContract:{resizeContext:'upscale'}}),'Upscale refinement');
 assert.match(help({traits:{recommendedPlacement:'during-upscale'}}),/same shader provider/);
 const h=componentHarness(ReShadeFilterLibrary,{filters:[{id:'shader:mpv:manual',presetId:'shader:mpv:manual',name:'Original filter',path:'/Collection/Original.hook',format:'libplacebo',origin:'collection',collectionLabel:'mpv',available:true,canRemove:false,canRelocate:false,traits:{geometryKnown:false},outputContract:{domain:'image',sizing:'shader',resizeDirections:[]}}],showDownloads:false,compact:true});
 try{const markup=require('react-dom/server').renderToStaticMarkup(h.render());assert.match(markup,/mpv collection/);assert.match(markup,/Unknown size/);assert.doesNotMatch(markup,/Same size|Custom input\/output|Declared by shader/);}finally{h.close();}
});
test('shader geometry places fixed, conditional and requested-size shaders in the ordinary types',()=>{
 const {GRAPHICS_TYPES,graphicsType,implementationsFor,shaderGeometry}=require('../src/modules/shared/effects/contracts.mjs');
 const shader=(id,outputContract,traits={})=>({id,kind:'shader',label:id,group:'Shaders',available:true,traits,outputContract,template:{kind:'shader',enabled:true,shader:{enabled:true,preset:id}}});
 const same=shader('name says upscale',{domain:'image',sizing:'preserve'}),fixed=shader('unnamed',{domain:'image',sizing:'intrinsic',scale:{x:2,y:2},extentEditable:false}),conditional=shader('conditional',{domain:'image',sizing:'shader',scaleRange:{min:{x:1,y:1},max:{x:2,y:2}},extentEditable:false}),contextual=shader('dynamic',{domain:'image',sizing:'shader',extentEditable:true}),resampler=shader('resampler',{domain:'image',sizing:'stage',extentEditable:true,resizeDirections:['downsample','upscale']});
 const basic={id:'downsample:bilinear',template:{kind:'downsample',method:'bilinear'},available:true},model={id:'upscale:model',template:{kind:'upscale',method:'realcugan'},intrinsicScale:3,available:true},rows=[same,fixed,conditional,contextual,resampler,basic,model],before=JSON.stringify(rows);
 assert.deepEqual(GRAPHICS_TYPES.map(row=>row.id),['image','downsample','upscale','temporal','generation']);
 assert.deepEqual([same,fixed,conditional,contextual,resampler].map(row=>shaderGeometry(row).kind),['identity','scale','conditional','unknown','target']);
 assert.deepEqual([same,fixed,conditional,contextual,resampler].map(row=>graphicsType(row.template,row)),['image','upscale','upscale','image','image']);
 assert.equal(graphicsType({...resampler.template,extent:{relativeTo:'input',factor:.5}},resampler),'downsample');assert.equal(graphicsType({...resampler.template,extent:{relativeTo:'presentation',factor:1}},resampler),'upscale');
 assert.equal(graphicsType({...same.template,extent:{relativeTo:'input',factor:.5}},same),'image','an output size does not move a same-size filter');
 assert.deepEqual(implementationsFor('image',rows).map(row=>row.id),[same.id,contextual.id,resampler.id]);
 assert.deepEqual(implementationsFor('upscale',rows).map(row=>row.id),[fixed.id,conditional.id,resampler.id,model.id]);
 assert.deepEqual(implementationsFor('downsample',rows).map(row=>row.id),[resampler.id,basic.id]);
 assert.deepEqual(implementationsFor('downsample',rows,{contextual:true}).map(row=>row.id),[contextual.id,resampler.id,basic.id]);assert.equal(JSON.stringify(rows),before);
});
test('a 2x shader dropped on Simple Upscale is shown there with shared size controls and Off retires its helpers',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});
 const file='/Sources/Double.glsl',filter={id:id(70),name:'Double',path:file,format:'libplacebo',available:true,traits:{outputScale:{x:2,y:2}},outputContract:{domain:'image',sizing:'intrinsic',scale:{x:2,y:2},extentEditable:false}};
 const fit={id:'upscale:bicubic',kind:'upscale',label:'Bicubic',group:'Resize',available:true,template:{kind:'upscale',enabled:true,method:'bicubic',settings:{}},outputContract:{domain:'image',sizing:'stage',direction:'upscale',extentEditable:true}};
 const down={...fit,id:'downsample:bicubic',kind:'downsample',template:{...fit.template,kind:'downsample'},outputContract:{...fit.outputContract,direction:'downsample'}};
 const f=setup({schema:2,mode:'advanced',enabled:true,video:[]},[filter],{catalog:[fit,down]});
 try{const drop=event(file);
  elements(f.h.render()).find(n=>n.props.className?.includes('simpleEffectRow')&&n.props.children?.[1]?.props?.id==='simple-effect-upscale').props.onDrop(drop);await f.h.settle();
  let plan=f.writes.at(-1),shaderNode=plan.video.find(row=>row.kind==='shader');assert.ok(shaderNode);assert.equal(shaderNode.extent,undefined);
  // Helpers name their owner explicitly; their ids carry no meaning.
  assert.deepEqual(plan.video.map(row=>row.ownedBy||row.id),[{id:shaderNode.id,role:'input'},shaderNode.id,{id:shaderNode.id,role:'fit'}]);assert.deepEqual(plan.renderResolution,{multiplier:2,managedBy:shaderNode.id});
  const fitId=plan.video[2].id;
  let tree=f.h.render();
  assert.equal(elements(tree).find(n=>n.props.id==='simple-effect-upscale').props.value,'shader:filter:'+filter.id);
  elements(tree).find(n=>n.type==='button'&&n.props.children==='Options…').props.onClick();tree=f.h.render();
  assert.ok(elements(tree).some(n=>n.type==='span'&&n.props.className==='detailValue'&&React.Children.toArray(n.props.children).includes('2×')),'the declared scale is shown');
  const size=elements(tree).find(n=>n.props.nodeId===fitId);assert.ok(size,'the owned fit supplies the output size');
  size.props.onChange({relativeTo:'input',factor:1});await f.h.settle();plan=f.writes.at(-1);
  const sized=plan.video.find(row=>row.id===fitId);assert.deepEqual(sized.extent,{relativeTo:'input',factor:1});assert.deepEqual(sized.ownedBy,{id:shaderNode.id,role:'fit'},'the helper keeps its owner');
  elements(f.h.render()).find(n=>n.props.id==='simple-effect-upscale').props.onChange({target:{value:'off'}});await f.h.settle();plan=f.writes.at(-1);
  assert.equal(plan.renderResolution,undefined);assert.ok(plan.video.every(row=>!row.enabled));
 }finally{f.h.close();}
});
test('saved shader rows load by geometry and a requested-size shader keeps its Simple slot when sized',async t=>{
 const previous=global.window;t.after(()=>{global.window=previous;});
 const row=(preset,outputContract)=>({id:'shader:'+preset,kind:'shader',label:preset,group:'Resize',available:true,outputContract,template:{kind:'shader',enabled:true,shader:{enabled:true,preset,parameters:null}}});
 const conditional=row('conditional',{domain:'image',sizing:'shader',scaleRange:{min:{x:1,y:1},max:{x:2,y:2}},extentEditable:false}),unknown=row('unknown',{domain:'image',sizing:'shader',extentEditable:false}),resampler=row('resampler',{domain:'image',sizing:'stage',extentEditable:true,resizeDirections:['downsample','upscale']});
 const node=(id,preset,extra={})=>({id,kind:'shader',enabled:true,shader:{enabled:true,preset,parameters:null},...extra});
 const plan={schema:2,mode:'advanced',enabled:true,video:[node('a','unknown'),node('b','resampler',{extent:{relativeTo:'input',factor:.5}}),node('c','conditional')]};
 const f=setup(plan,[],{catalog:[conditional,unknown,resampler]});
 try{let tree=f.h.render();
  assert.equal(elements(tree).find(n=>n.props.id==='simple-effect-image-a').props.value,unknown.id);
  assert.equal(elements(tree).find(n=>n.props.id==='simple-effect-downsample').props.value,resampler.id);
  assert.equal(elements(tree).find(n=>n.props.id==='simple-effect-upscale').props.value,conditional.id);
  assert.ok(!elements(tree).some(n=>n.props.id==='simple-effect-resize-shader'));
  elements(tree).filter(n=>n.type==='button'&&n.props.children==='Options…')[1].props.onClick();tree=f.h.render();
  const size=elements(tree).find(n=>n.props.nodeId==='b');assert.equal(size.props.direction,'downsample');
  const markup=require('react-dom/server').renderToStaticMarkup(size);assert.match(markup,/Scale of previous image/);assert.match(markup,/Fixed resolution/);assert.doesNotMatch(markup,/Fraction of window/,'Downsample offers only sizes that keep a bidirectional shader there');
 }finally{f.h.close();}
});
