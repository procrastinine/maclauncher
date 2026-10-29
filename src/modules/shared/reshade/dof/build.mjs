#!/usr/bin/env node
// Copyright (c) MacLauncher contributors. MIT license.
// Original FidelityFX DoF kernels, constants and dispatch schedule.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname,spec=JSON.parse(fs.readFileSync(path.join(here,'source.json'))),options={};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!['--source','--tools','--output'].includes(key)||!process.argv[i+1]||options[key])throw Error('Expected unique --source, --tools and --output paths.');options[key]=path.resolve(process.argv[i+1]);}
for(const key of ['--source','--tools','--output'])if(!options[key])throw Error('Missing '+key);
const source=options['--source'],tools=options['--tools'],out=options['--output'];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),run=(exe,args)=>execFileSync(exe,args,{encoding:'utf8',maxBuffer:64*1024*1024});
if(run('git',['-C',source,'rev-parse','HEAD']).trim()!==spec.commit)throw Error('DoF source pin changed.');
run('git',['-C',source,'diff','--exit-code','HEAD','--']);
const read=file=>fs.existsSync(path.join(source,file))?fs.readFileSync(path.join(source,file),'utf8'):run('git',['-C',source,'show',spec.commit+':'+file]);
for(const [file,digest]of Object.entries(spec.files))if(hash(read(file))!==digest)throw Error('DoF source changed: '+file);
fs.mkdirSync(out,{recursive:true});const overlay=path.join(out,'overlay'),gpu=path.join(source,'sdk/include/FidelityFX/gpu');fs.mkdirSync(path.join(overlay,'dof'),{recursive:true});
for(const file of Object.keys(spec.files))if(file.startsWith('sdk/include/FidelityFX/gpu/dof/'))fs.writeFileSync(path.join(overlay,'dof',path.basename(file)),read(file));
fs.copyFileSync(path.join(here,'../native/scene-projection.hlsl'),path.join(overlay,'scene-projection.hlsl'));
const original=read('sdk/include/FidelityFX/gpu/dof/ffx_dof_callbacks_hlsl.h');let callbacks=original;
const replace=(before,after,count=1)=>{if(callbacks.split(before).length!==count+1)throw Error('DoF callback adaptation changed: '+before);callbacks=callbacks.split(before).join(after);};
replace('RWTexture2D<FfxHalfOpt4>  rw_internal_bilat_color[4]    : FFX_DOF_DECLARE_UAV(FFX_DOF_BIND_UAV_INTERNAL_BILAT_COLOR);',Array.from({length:4},(_,i)=>`RWTexture2D<FfxHalfOpt4> rw_internal_bilat_color_mip${i}:register(u${12+i});`).join('\n'));
replace('rw_internal_bilat_color[mip][tex] = value;','if(any(tex<0)||any(tex>=max(FfxInt32x2(InputSizeHalf())>>mip,FfxInt32x2(1,1))))return;\n'+Array.from({length:4},(_,i)=>`${i?'else ':''}if(mip==${i})rw_internal_bilat_color_mip${i}[tex]=value;`).join('\n'));
// HLSL integer loads outside the logical image return zero. Keep that boundary
// explicit when translated to Metal; sampled gathers retain original clamping.
replace('return FfxHalfOpt4(r_input_color[tex]);','return all(tex>=0)&&all(tex<FfxInt32x2(InputSize()))?FfxHalfOpt4(r_input_color[tex]):FfxHalfOpt4(0,0,0,0);');
replace('return r_input_depth[coord];','return all(coord<InputSize())?r_input_depth[coord]:0.0;');
replace('return r_input_color[coord];','return all(coord<InputSize())?r_input_color[coord]:FfxFloat32x4(0,0,0,0);');
replace('return rw_internal_near[coord];','return all(coord<InputSizeHalf())?rw_internal_near[coord]:FfxHalfOpt4(0,0,0,0);');
replace('return rw_internal_far[coord];','return all(coord<InputSizeHalf())?rw_internal_far[coord]:FfxHalfOpt4(0,0,0,0);');
replace('return r_internal_bilat_color[coord];','return all(coord<InputSizeHalf())?r_internal_bilat_color[coord]:FfxHalfOpt4(0,0,0,0);');
replace('return r_internal_bilat_color.SampleLevel(PointSampler, coord, mip);','FfxUInt32 w,h,levels;r_internal_bilat_color.GetDimensions(mip,w,h,levels);\n    FfxFloat32x2 logical=max(InputSizeHalf()>>mip,FfxUInt32x2(1,1));\n    coord=clamp(coord,0.5/logical,1.0-0.5/logical);\n    return r_internal_bilat_color.SampleLevel(PointSampler,coord*logical/FfxFloat32x2(w,h),mip);');
for(const [image,extent]of [['rw_internal_near','InputSizeHalf()'],['rw_internal_far','InputSizeHalf()'],['rw_output_color','InputSize()']])replace(`${image}[coord] = color;`,`if(all(coord<${extent}))${image}[coord]=color;`);
for(const [image,coordinate,value]of [['rw_internal_radius','tile','radius'],['rw_internal_dilated_radius','coord','dilatedMinMax']])replace(`${image}[${coordinate}] = ${value};`,`FfxUInt32 w,h;${image}.GetDimensions(w,h);if(all(${coordinate}<FfxUInt32x2(w,h)))${image}[${coordinate}]=${value};`);
for(const [image,coordinate]of [['rw_internal_radius','tile'],['r_internal_dilated_radius','coord']])replace(`return ${image}[${coordinate}];`,`FfxUInt32 w,h;${image}.GetDimensions(w,h);return all(${coordinate}<FfxUInt32x2(w,h))?${image}[${coordinate}]:FfxFloat32x2(0,0);`);
fs.writeFileSync(path.join(overlay,'dof/ffx_dof_callbacks_hlsl.h'),callbacks);
const originalDepth=read('sdk/include/FidelityFX/gpu/dof/ffx_dof_downsample_depth.h');
if(originalDepth.split('FfxFloat32 minD = 1.0;').length!==2)throw Error('DoF tile min-depth initializer changed.');
const depth=originalDepth.replace('FfxFloat32 minD = 1.0;','FfxFloat32 minD = 3.402823466e+38f;');
fs.writeFileSync(path.join(overlay,'dof/ffx_dof_downsample_depth.h'),depth);
const cpp=read('sdk/src/components/dof/ffx_dof.cpp'),privateHeader=read('sdk/src/components/dof/ffx_dof_private.h');
const constants=/typedef struct DofConstants[\s\S]*?} DofConstants;/.exec(privateHeader)?.[0];
const sizes=/uint32_t halfWidth = \(width \+ 1\) \/ 2[\s\S]*?uint32_t tilesY = [^;]+;/.exec(cpp)?.[0];
// Match the original five pass order explicitly; unsupported scheduler changes
// fail source generation rather than silently changing the graph.
const schedule=cpp.slice(cpp.indexOf('scheduleDispatch(context, params, &context->pipelineDsDepth'),cpp.indexOf('// Execute all the work for the frame'));
if(!constants||!sizes||!schedule||!schedule.includes('pipelineComposite'))throw Error('DoF original schedule changed.');
const passes={DsDepth:'downsample-depth',DsColor:'downsample-color',Dilate:'dilate',Blur:'blur',Composite:'composite'};
const dispatches=[];for(const line of schedule.trim().split('\n')){const m=/scheduleDispatch\(context, params, &context->pipeline(\w+), (.*), (.*)\);/.exec(line.trim());if(!m||!passes[m[1]])throw Error('Unrecognized DoF dispatch.');dispatches.push(`{${JSON.stringify(passes[m[1]])},${m[2]},${m[3]}}`);}
if(dispatches.length!==5)throw Error('DoF requires the complete five-pass scheduler.');
fs.writeFileSync(path.join(out,'dof-upstream.hpp'),'// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see dof-MIT.txt.\n#pragma once\n#include <array>\n#include <cstdint>\nnamespace macfx::dof_host {\n'+constants+'\nstruct Dispatch{const char*name;uint32_t x,y;};\ninline std::array<Dispatch,5> schedule(uint32_t width,uint32_t height){\n'+sizes+'\nreturn {{'+dispatches.join(',')+'}};\n}\n}\n');
const shaders=[];for(const role of [...spec.roles,{name:'depth',entry:'CSDepth'},{name:'orient',entry:'CSOrient'}]){
 const base=path.join(out,role.name),spv=base+'.spv',metal=base+'.metal';let input,entry=role.entry||'CS';
 if(role.file){input=base+'.hlsl';fs.writeFileSync(input,read(role.file));}else input=path.join(here,'boundary.hlsl');
 const defines={FFX_GPU:1,FFX_HLSL:1,FFX_HLSL_6_2:1,FFX_HALF:0,FFX_DOF_OPTION_REVERSE_DEPTH:1,FFX_DOF_OPTION_COMBINE_IN_PLACE:0,FFX_DOF_OPTION_MAX_RING_MERGE_LOG:role.merge===false?0:1};
 run(path.join(tools,'dxc'),['-spirv','-fspv-target-env=vulkan1.1spirv1.4','-T','cs_6_2','-E',entry,'-O3','-fvk-t-shift','32','0','-fvk-u-shift','64','0','-I',overlay,'-I',gpu,...Object.entries(defines).flatMap(([k,v])=>['-D',k+'='+v]),input,'-Fo',spv]);
 run(path.join(tools,'spirv-val'),['--target-env','vulkan1.1spv1.4',spv]);run(path.join(tools,'spirv-cross'),[spv,'--msl','--msl-version','23000','--output',metal]);
 const reflection=JSON.parse(run(path.join(tools,'spirv-cross'),[spv,'--reflect'])),msl=fs.readFileSync(metal,'utf8'),kernel=/kernel\s+\w+\s+(\w+)\s*\(([\s\S]*?)\)\s*\{/.exec(msl);if(!kernel)throw Error('DoF Metal entry is unavailable.');
 const bindings=[...kernel[2].matchAll(/(\w+)\s*\[\[(buffer|texture|sampler)\((\d+)\)\]\]/g)].map(m=>({name:m[1],kind:m[2],index:Number(m[3])}));shaders.push({name:role.name,entry:kernel[1],threads:reflection.entryPoints[0].workgroup_size,bindings,sha256:hash(msl),source:msl});fs.rmSync(spv);
}
let header='// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see dof-MIT.txt.\n// Generated original FidelityFX DoF compute kernels.\n#pragma once\n#include <cstddef>\nnamespace macfx::dof_shaders {\nstruct Binding{const char*name;const char*kind;unsigned index;};\nstruct Shader{const char*name;const char*entry;const char*source;const Binding*bindings;size_t count;unsigned x,y,z;};\n';
shaders.forEach((s,i)=>{header+=`inline constexpr Binding bindings${i}[]={${s.bindings.map(b=>'{'+JSON.stringify(b.name)+','+JSON.stringify(b.kind)+','+b.index+'}').join(',')}};\ninline constexpr const char*source${i}=R"DOF_GPU(${s.source})DOF_GPU";\n`;});header+='inline constexpr Shader shaders[]={'+shaders.map((s,i)=>`{${JSON.stringify(s.name)},${JSON.stringify(s.entry)},source${i},bindings${i},sizeof(bindings${i})/sizeof(Binding),${s.threads.join(',')}}`).join(',')+'};\n}\n';
fs.writeFileSync(path.join(out,'dof-shaders.hpp'),header);fs.writeFileSync(path.join(out,'dof-MIT.txt'),read('LICENSE.txt'));
const hash22Notice=/\/\* hash22[\s\S]*?\*\//.exec(read('sdk/include/FidelityFX/gpu/dof/ffx_dof_blur.h'))?.[0];
if(!hash22Notice||!hash22Notice.includes('Copyright (c)2014 David Hoskins.'))throw Error('DoF hash22 attribution changed.');
fs.writeFileSync(path.join(out,'dof-HASH22-MIT.txt'),hash22Notice+'\n');
fs.writeFileSync(path.join(out,'translation.json'),JSON.stringify({schema:1,repository:spec.repository,commit:spec.commit,license:spec.license,source:spec,owned:hash(fs.readFileSync(import.meta.filename)),ownedFiles:Object.fromEntries(['boundary.hlsl','../native/scene-projection.hlsl'].map(file=>[file,hash(fs.readFileSync(path.join(here,file)))])),adaptations:{callbacks:{sourceSha256:hash(original),appliedSha256:hash(callbacks)},inverseDepthDomain:{sourceSha256:hash(originalDepth),appliedSha256:hash(depth)}},shaders:shaders.map(({source,...s})=>s)},null,2)+'\n');
console.log(JSON.stringify({output:out,kernels:shaders.length}));
