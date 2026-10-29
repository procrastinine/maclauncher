const test=require('node:test'),assert=require('node:assert/strict'),Plan=require('../src/modules/shared/effects/plan'),Contracts=require('../src/modules/shared/effects/contracts.mjs');
test('real-frame shader history is explicit, provider-qualified and independent of names or image geometry',()=>{
 const Bindings=require('../src/modules/shared/reshade/shader-scene-bindings'),Providers=require('../src/modules/shared/reshade/shader-providers');
 const traits=Bindings.apply('//!SCENE_INPUT ArbitraryMotion motion\n//!SCENE_HISTORY real\n//!SCENE_COORDINATES preserve',{});
 assert.equal(traits.sceneHistory,'real');assert.deepEqual(traits.sceneInputs,['motion']);assert.deepEqual(traits.sceneBindings,{ArbitraryMotion:'motion'});
 assert.equal(traits.preservesCoordinates,true);assert.equal(Bindings.apply('',{}).preservesCoordinates,undefined);
 assert.throws(()=>Bindings.apply('//!SCENE_HISTORY synthetic',{}),/real source frames/);
 assert.match(Providers.sceneHistoryAvailability('fx','real'),/real-frame scene history/);
 assert.equal(Providers.sceneHistoryAvailability('fx','real',{features:{sceneHistoryAPI:1,providers:{fx:{sceneHistoryAPI:1}}}}),null);
 assert.match(Providers.sceneHistoryAvailability('isf','real',{features:{sceneHistoryAPI:1,providers:{fx:{sceneHistoryAPI:1}}}}),/real-frame scene history/);
 assert.equal(Providers.sceneHistoryAvailability('fx',undefined),null);
});
test('recommendation tags do not change placement for equal image contracts',()=>{
 const shader=id=>({id,kind:'shader',enabled:true,shader:{preset:'custom',effectPath:'/Shaders/'+id+'.fx'}});
 const value={schema:2,mode:'advanced',enabled:true,video:[shader('color'),shader('restoration'),shader('neural'),{id:'fit',kind:'spatial',enabled:true,method:'bilinear',settings:{}},shader('scaled')]};
 const facts={color:{traits:{category:'color'}},restoration:{traits:{category:'restoration'}},neural:{traits:{neural:true}},scaled:{traits:{outputScale:{x:2,y:2}}}};
 assert.deepEqual(Plan.orderSimple(value,{shaderFacts:facts}).video.map(node=>node.id),['scaled','fit','color','restoration','neural']);
});
test('the same imported contract has the same slot and controls across format and recommendation identities',()=>{
 const spec={domain:'image',sizing:'shader',extentEditable:true};
 const presets=['fx','slangp','libplacebo','isf','magpie','native'].map((format,i)=>({id:i?'filter:'+i:'recommended',label:format,format,available:true,traits:{outputExtentEditable:true,unresolvedGeometry:true},outputContract:spec}));
 const rows=Plan.catalog({reshadeState:{available:true,presets}}).filter(row=>row.kind==='shader');
 for(const row of rows){assert.deepEqual(row.outputContract,spec);assert.equal(Contracts.shaderGeometry(row).kind,'unknown');assert.ok(Contracts.implementationsFor('image',rows).includes(row));
  for(const type of ['upscale','downsample']){assert.ok(Contracts.implementationsFor(type,rows,{contextual:true}).includes(row));assert.ok(!Contracts.implementationsFor(type,rows).includes(row));}}
 const sized=Plan.catalog({reshadeState:{available:true,presets:[{id:'stage',label:'Stage-sized image',format:'isf',traits:{requestedOutputExtent:true,outputExtentEditable:true}}]}}).find(row=>row.id==='shader:stage');
 assert.equal(sized.group,'Image filters');assert.equal(Contracts.graphicsType(sized.template,sized),'image');
});
test('color policy follows the declared input rather than the shader format',()=>{
 const presets=['fx','isf','magpie'].flatMap(format=>['source','srgb-sdr'].map(inputPolicy=>({id:format+inputPolicy,label:format,format,traits:{inputPolicy}})));
 const rows=Plan.catalog({reshadeState:{available:true,presets},graphicsCapabilities:{colorPipeline:true,shaderInputPolicy:true}});
 for(const preset of presets){const row=rows.find(row=>row.id==='shader:'+preset.id);assert.equal(Boolean(row.colorPolicy),preset.traits.inputPolicy==='srgb-sdr');}
});
test('an imported copy of a collection shader has the same types, menus and default sizes',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),{build}=require('vite');
 const Managed=require('../src/modules/shared/reshade/managed-shaders'),ReShade=require('../src/modules/shared/reshade'),Imports=require('../src/modules/shared/reshade/imports');
 const Presentation=require('../src/modules/shared/effects/presentation.mjs');
 const compiled=await build({configFile:false,logLevel:'silent',build:{ssr:path.join(__dirname,'../src/renderer/src/ui/shader-implementations.ts'),write:false,rollupOptions:{output:{format:'cjs'}}}});
 const loaded=new Module(path.join(__dirname,'shader-implementations.cjs'),module);loaded.paths=module.paths;loaded._compile(compiled.output.find(x=>x.type==='chunk').code,loaded.id);
 const Rows=loaded.exports,root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'shader-equal-footing-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const runtime=path.join(root,'runtime'),userDataDir=path.join(root,'profile'),collection=path.join(root,'collection'),imported=path.join(root,'imported');
 for(const directory of [runtime,userDataDir,collection,imported])fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(runtime,'runtime.json'),JSON.stringify({schema:1,version:'test',minimumMacOS:'13.0',features:{shaders:{formats:['libplacebo','slangp','magpie']},graphics:{effectPlanAPI:1}}}));
 for(const file of ['libreshade-macos.dylib','fx-compile'])fs.writeFileSync(path.join(runtime,file),'fixture');
 const hook=(stage,directives)=>`//!HOOK ${stage}\n//!BIND HOOKED\n${directives}\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}\n`;
 const magpie=size=>`//!MAGPIE EFFECT\n//!VERSION 4\n//!TEXTURE\nTexture2D INPUT;\n//!TEXTURE\n${size}Texture2D OUTPUT;\n//!SAMPLER\n//!FILTER POINT\nSamplerState pointSampler;\n//!PASS 1\n//!STYLE PS\n//!IN INPUT\n//!OUT OUTPUT\nfloat4 Pass1(float2 position){return INPUT.SampleLevel(pointSampler,position,0);}\n`;
 // One source per geometry class; neither copy has a name or collection hint.
 const sources={'A.glsl':['libplacebo',hook('MAIN',''),'identity'],'B.hlsl':['magpie',magpie('//!WIDTH INPUT_WIDTH*2\n//!HEIGHT INPUT_HEIGHT*2\n'),'scale'],
  'C.glsl':['libplacebo',hook('MAIN','//!WIDTH 1280\n//!HEIGHT 720'),'size'],'D.glsl':['libplacebo',hook('MAIN','//!WIDTH HOOKED.w 2 *\n//!HEIGHT HOOKED.h 2 *\n//!WHEN OUTPUT.w HOOKED.w >'),'conditional'],
  'E.glsl':['libplacebo',hook('POSTKERNEL','//!WHEN OUTPUT.w MAIN.w >'),'target'],'F.slangp':['slangp','shaders = 1\nshader0 = pass.slang\nscale_type0 = viewport\nscale0 = 1.0\n','target'],
  'G.glsl':['libplacebo',hook('MAIN','//!WIDTH OUTPUT.w\n//!HEIGHT OUTPUT.h'),'target'],'H.slangp':['slangp','shaders = 0\n','unknown']};
 for(const directory of [collection,imported]){fs.writeFileSync(path.join(directory,'pass.slang'),'#version 450\nvoid main(){}\n');for(const [file,[,source]] of Object.entries(sources))fs.writeFileSync(path.join(directory,file),source);}
 const packId=Managed.Catalog.packs[0].id,effects=Object.entries(sources).map(([file,[format]],i)=>({id:String(i+1).repeat(16),file,format,label:file,traitsVersion:0}));
 t.mock.method(Managed,'listInstalled',(_userDataDir,section)=>section===packId?[{packId,root:collection,filesRoot:collection,files:Object.fromEntries(effects.map(row=>[row.file,{bytes:1,sha256:require('node:crypto').createHash('sha256').update(sources[row.file][1]).digest('hex')}])),effects}]:[]);
 const importer=Imports.createImporter({root:runtime,userDataDir,importGame:()=>{},importModel:async()=>({}),onGraphicsImported:()=>{}});
 for(const file of Object.keys(sources))assert.equal((await importer(path.join(imported,file))).kind,'filter');
 const state=ReShade.getState({root:runtime,userDataDir,platform:'darwin',macOSVersion:'27.0',graphicsArchitecture:'arm64'}),catalog=Plan.catalog({reshadeState:state});
 const types=Contracts.GRAPHICS_TYPES.map(type=>type.id);
 const view=row=>({geometry:Contracts.shaderGeometry(row),type:Contracts.graphicsType(row.template,row),group:row.group,extent:row.template.extent,
  menus:types.filter(type=>Contracts.implementationsFor(type,[row]).length),custom:types.filter(type=>Contracts.implementationsFor(type,[row],{contextual:true}).length),
  sizes:types.map(type=>Rows.shaderExtent(row,type)),output:Contracts.shaderDefaultOutput(row),pickerGroups:types.map(type=>Presentation.implementationGroup(row,type)),
  details:types.map(type=>Presentation.implementationOutputSummary(row,type)),help:Presentation.implementationHelp(row)});
 const preset=(directory,file)=>state.presets.find(row=>row.sourcePath===path.join(directory,file));
 for(const [file,[,,kind]] of Object.entries(sources)){
  const own=preset(collection,file),copy=preset(imported,file);assert.ok(own&&copy,file);
  const expected=view(catalog.find(row=>row.id===own.id));assert.equal(expected.geometry.kind,kind,file);
  assert.deepEqual(view(catalog.find(row=>row.id===copy.id)),expected,file+' editor row');
  assert.deepEqual(view(Rows.importedShaderImplementation(state.filters.find(row=>row.path===path.join(imported,file)))),expected,file+' imported row');
  assert.deepEqual(view(Rows.importedShaderImplementation(state.shaderLibrary.find(row=>row.presetId===own.id))),expected,file+' library row');
 }
 const two=view(catalog.find(row=>row.id===preset(collection,'F.slangp').id)),zoom=view(catalog.find(row=>row.id===preset(collection,'G.glsl').id));
 assert.deepEqual(two.menus,['image','downsample','upscale']);assert.deepEqual(zoom.menus,['image','downsample','upscale']);
 assert.deepEqual(zoom.sizes.slice(0,3),[{relativeTo:'input',factor:1},{relativeTo:'input',factor:.5},{relativeTo:'presentation',factor:1}]);
 assert.deepEqual(two.pickerGroups.slice(0,3),['Shaders','Any size','Any size']);assert.equal(two.details[0],'Same size');
 assert.deepEqual(view(catalog.find(row=>row.id===preset(collection,'B.hlsl').id)).pickerGroups.slice(0,3),['Shaders','Shaders','Shaders']);
});
