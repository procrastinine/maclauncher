#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname,pin=JSON.parse(fs.readFileSync(path.join(here,'source.json')));
const [sourceArg,toolsArg,outputArg,...options]=process.argv.slice(2);
if(!outputArg)throw Error('Usage: build.mjs SOURCE_GIT TOOLS OUTPUT [--shaders-only] [--native-only]');
const source=path.resolve(sourceArg),tools=path.resolve(toolsArg),output=path.resolve(outputArg);
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',maxBuffer:32*1024*1024});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
if(run('git',['-C',source,'rev-parse','HEAD']).trim()!==pin.commit)throw Error('Select the declared FidelityFX SDK commit.');
for(const name of ['dxc','spirv-cross'])if(hash(fs.readFileSync(path.join(tools,name)))!==pin.tools[name])throw Error('The shader compiler differs from the declared build input: '+name);
fs.mkdirSync(output,{recursive:true});
const exported=path.join(output,'source'),archive=path.join(output,'source.tar');fs.mkdirSync(exported,{recursive:true});
run('git',['-C',source,'archive','--format=tar','--output='+archive,pin.commit,'LICENSE.txt','sdk/include','sdk/src/components/opticalflow','sdk/src/components/frameinterpolation','sdk/src/shared','sdk/src/backends/shared','sdk/src/backends/dx12/shaders/opticalflow','sdk/src/backends/dx12/shaders/frameinterpolation']);
run('tar',['-xf',archive,'-C',exported]);fs.rmSync(archive);
// The SDK's alpha channel is an internal inpainting mask. The final pass has
// consumed that mask; an opaque presentation image requires alpha one even
// when its RGB did not need inpainting. Keep that change in the owned export.
const inpainting=path.join(exported,'sdk/include/FidelityFX/gpu/frameinterpolation/ffx_frameinterpolation_inpainting.h');
const original=fs.readFileSync(inpainting,'utf8'),conditional='    if (bWriteColor)\n    {\n        StoreFrameinterpolationOutput(iPxPos, FfxFloat32x4(fInterpolatedColor.rgb, 1.0f));';
if(!original.includes(conditional))throw Error('The final inpainting output declaration changed.');
fs.writeFileSync(inpainting,original.replace(conditional,'    {\n        StoreFrameinterpolationOutput(iPxPos, FfxFloat32x4(fInterpolatedColor.rgb, 1.0f));'));
const groups={
 opticalflow:['prepare_luma','compute_luminance_pyramid','generate_scd_histogram','compute_scd_divergence','compute_optical_flow_advanced_pass_v5','filter_optical_flow_pass_v5','scale_optical_flow_advanced_pass_v5'],
 frameinterpolation:['reconstruct_and_dilate','setup','reconstruct_previous_depth','game_motion_vector_field','optical_flow_vector_field','disocclusion_mask','frameinterpolation','compute_inpainting_pyramid','inpainting','compute_game_vector_field_inpainting_pyramid','debug_view']
};
const payload=path.join(output,'payload');fs.mkdirSync(payload,{recursive:true});
const signature=(msl,reflection)=>{
 const entry=/kernel\s+void\s+(\w+)\s*\(([\s\S]*?)\)\s*\{/.exec(msl);if(!entry)throw Error('The translated Metal kernel is missing.');
 return {entry:entry[1],threads:reflection.entryPoints[0].workgroup_size,bindings:[...entry[2].matchAll(/(\w+)\s*\[\[(buffer|texture|sampler)\((\d+)\)\]\]/g)].map(match=>({name:match[1],kind:match[2],index:Number(match[3])}))};
};
if(!options.includes('--native-only'))for(const [effect,passes]of Object.entries(groups))for(let variant=0;variant<(effect==='opticalflow'?2:8);++variant){
 const directory=path.join(payload,effect,String(variant));fs.mkdirSync(directory,{recursive:true});
 for(let pass=0;pass<passes.length;++pass){
  let name=passes[pass];const filename=effect==='frameinterpolation'&&name==='frameinterpolation'?'ffx_frameinterpolation_pass.hlsl':`ffx_${effect}_${name}${name.includes('_pass_')?'':'_pass'}.hlsl`;
  const shader=path.join(exported,'sdk/src/backends/dx12/shaders',effect,filename),spv=path.join(directory,pass+'.spv');
  const defines={FFX_GPU:1,FFX_HLSL:1,FFX_HALF:0,...(effect==='opticalflow'?{FFX_OPTICALFLOW_OPTION_HDR_COLOR_INPUT:variant}:{FFX_FRAMEINTERPOLATION_OPTION_LOW_RES_MOTION_VECTORS:variant&1?1:0,FFX_FRAMEINTERPOLATION_OPTION_JITTER_MOTION_VECTORS:variant&2?1:0,FFX_FRAMEINTERPOLATION_OPTION_INVERTED_DEPTH:variant&4?1:0})};
  run(path.join(tools,'dxc'),['-spirv','-fspv-target-env=vulkan1.1','-T','cs_6_0','-E','CS','-O3','-fvk-t-shift','32','0','-fvk-u-shift','64','0','-I',path.join(exported,'sdk/include/FidelityFX/gpu'),...Object.entries(defines).flatMap(([name,value])=>['-D',name+'='+value]),shader,'-Fo',spv]);
  const metal=run(path.join(tools,'spirv-cross'),[spv,'--msl','--msl-version','23000']),reflection=JSON.parse(run(path.join(tools,'spirv-cross'),[spv,'--reflect']));
  fs.writeFileSync(path.join(directory,pass+'.metal'),metal);fs.writeFileSync(path.join(directory,pass+'.json'),JSON.stringify(signature(metal,reflection)));fs.rmSync(spv);
 }
}
fs.copyFileSync(path.join(exported,'LICENSE.txt'),path.join(payload,'FSR3-LICENSE.txt'));
if(options.includes('--shaders-only')){console.log('Translated FidelityFX optical flow and frame interpolation shaders: '+payload);process.exit(0);}
const overlay=path.join(output,'host-overlay/FidelityFX/host');fs.mkdirSync(overlay,{recursive:true});
for(const effect of ['opticalflow','frameinterpolation']){
 const header=fs.readFileSync(path.join(exported,'sdk/include/FidelityFX/host',`ffx_${effect}.h`),'utf8'),name=effect.toUpperCase();
 const pattern=new RegExp(`(#define FFX_${name}_CONTEXT_SIZE\\s+)\\(FFX_SDK_DEFAULT_CONTEXT_SIZE\\)`);if(!pattern.test(header))throw Error('The SDK context-size declaration changed.');
 fs.writeFileSync(path.join(overlay,`ffx_${effect}.h`),header.replace(pattern,'$1(FFX_SDK_DEFAULT_CONTEXT_SIZE * (sizeof(wchar_t) / 2))'));
}
const includes=['-I',path.join(output,'host-overlay'),'-I',path.join(exported,'sdk/include'),'-I',path.join(exported,'sdk/include/FidelityFX/host'),'-I',path.join(exported,'sdk/src/shared'),'-I',path.resolve(here,'../../native'),'-I',path.resolve(here,'../../native/base/src')];
for(const architecture of pin.architectures){
 const flags=['-std=c++17','-O2','-DNDEBUG','-DFFX_GCC','-DRS_FSR3=1','-arch',architecture,'-mmacosx-version-min=13.0',...includes,'-include',path.resolve(here,'../../temporal/fsr/host-compat.hpp')],objects=[];
 for(const file of ['sdk/src/components/opticalflow/ffx_opticalflow.cpp','sdk/src/components/frameinterpolation/ffx_frameinterpolation.cpp',...['ffx_assert.cpp','ffx_object_management.cpp','ffx_message.cpp'].map(name=>'sdk/src/shared/'+name)]){
  const object=path.join(output,architecture+'-'+path.basename(file)+'.o');run('xcrun',['clang++',...flags,'-c',path.join(exported,file),'-o',object]);objects.push(object);
 }
 run('xcrun',['clang++',...flags,'-fobjc-arc','-dynamiclib',path.join(here,'backend.mm'),...objects,'-framework','Metal','-framework','Foundation','-install_name','@rpath/libmaclauncher-fsr3-generation.dylib','-o',path.join(output,architecture+'.dylib')]);
}
const library=path.join(payload,'libmaclauncher-fsr3-generation.dylib');run('lipo',['-create',...pin.architectures.map(name=>path.join(output,name+'.dylib')),'-output',library]);run('codesign',['--force','--sign','-',library]);
fs.writeFileSync(path.join(payload,'provider.json'),JSON.stringify({providerABI:1,interfaces:{generation:1,preparation:1},shaderVariants:{opticalflow:2,frameinterpolation:8},shaderPasses:{opticalflow:7,frameinterpolation:11},complete:true,method:'fsr3',source:pin.repository,commit:pin.commit,effects:pin.effects,architectures:pin.architectures,minimumMacOS:pin.minimumMacOS,tools:pin.tools,adaptations:['opaque-presentation-alpha','darwin-wchar-context-size','inactive-SPD-UAV-bindings'],library:path.basename(library)},null,2)+'\n');
console.log('Built FidelityFX optical flow and frame interpolation provider: '+payload);
