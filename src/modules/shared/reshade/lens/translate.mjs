// Copyright (c) MacLauncher contributors. MIT license.
// Build the original FidelityFX image kernels from a declared read-only SDK.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const directory=path.dirname(fileURLToPath(import.meta.url));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const run=(program,args)=>execFileSync(program,args,{encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,GIT_NO_LAZY_FETCH:'1'}});
function replace(source,before,after,count=1){if(source.split(before).length!==count+1)throw Error('The FidelityFX image adaptation seam changed: '+before);return source.split(before).join(after);}
export function translate(effect,args){
 const options={};for(let i=0;i<args.length;i+=2){const key=args[i];if(!['--source','--tools','--output'].includes(key)||!args[i+1]||options[key])throw Error('Expected unique --source, --tools and --output paths.');options[key]=path.resolve(args[i+1]);}
 for(const key of ['--source','--tools','--output'])if(!options[key])throw Error('Missing '+key);
 const here=path.resolve(directory,'../'+effect),spec=JSON.parse(fs.readFileSync(path.join(here,'source.json'))),source=options['--source'],tools=options['--tools'],out=options['--output'];
 if(run('git',['-C',source,'rev-parse','HEAD']).trim()!==spec.commit)throw Error('The FidelityFX source pin changed.');run('git',['-C',source,'diff','--exit-code','HEAD','--']);
 const read=file=>fs.existsSync(path.join(source,file))?fs.readFileSync(path.join(source,file),'utf8'):run('git',['-C',source,'show',spec.commit+':'+file]);
 for(const[file,digest]of Object.entries(spec.files))if(hash(read(file))!==digest)throw Error('The FidelityFX source changed: '+file);
 fs.mkdirSync(out,{recursive:true});const overlay=path.join(out,'overlay'),gpu=path.join(source,'sdk/include/FidelityFX/gpu');fs.mkdirSync(path.join(overlay,effect),{recursive:true});
 // Only the owned build copy changes. All algorithm and host files keep their
 // original bytes in the SDK Git store and in the source hash manifest.
 for(const file of spec.sourceScope)if(file.startsWith('sdk/include/FidelityFX/gpu/'+effect+'/'))fs.writeFileSync(path.join(overlay,effect,path.basename(file)),read(file));
 const original=read('sdk/include/FidelityFX/gpu/'+effect+'/ffx_'+effect+'_callbacks_hlsl.h');let callbacks=original.replace(/\r\n/g,'\n'),algorithm;
 if(effect==='lens'){
  callbacks=replace(callbacks,'    rw_output_texture[iPxPos] = FfxFloat32x4(fColor, 1.0);','    FfxUInt32 w,h;rw_output_texture.GetDimensions(w,h);\n    if(all(iPxPos>=0)&&all(iPxPos<FfxInt32x2(w,h)))rw_output_texture[iPxPos] = FfxFloat32x4(fColor, 1.0);',2);
 }else{
  callbacks=replace(callbacks,'        rw_output[outPxCoord] = FfxFloat32x4(color, 1);','        if(all(outPxCoord>=0)&&all(outPxCoord<ImageSize()))rw_output[outPxCoord] = FfxFloat32x4(color, 1);');
  callbacks=replace(callbacks,'        return r_input_src[inPxCoord].rgb;','        return r_input_src[clamp(FfxInt32x2(inPxCoord),FfxInt32x2(0,0),ImageSize()-1)].rgb;',2);
  const file='sdk/include/FidelityFX/gpu/blur/ffx_blur.h';const originalAlgorithm=read(file);algorithm=originalAlgorithm.replace(/\r\n/g,'\n');
  // Select the original unpacked float cache rather than narrowing RG to fp16.
  algorithm=replace(algorithm,'#define BLUR_GROUPSHARED_MEMORY_PK_UINT            1','#define BLUR_GROUPSHARED_MEMORY_PK_UINT            0');
  // Partial groups participate in the original cache barriers; bounded loads
  // and stores handle their inactive columns without divergent early returns.
  algorithm=replace(algorithm,'    if (gxy.x >= ImageSize.x)\n        return;','    // Padded columns participate in all threadgroup cache barriers.');
  // Small images can have fewer tiles than the kernel prefill. Keep the
  // intended empty first loop signed instead of underflowing its bound.
  algorithm=replace(algorithm,'    const FfxUInt32 iTileCount =\n        DIV_AND_ROUND_UP(','    const FfxInt32 iTileCount =\n        DIV_AND_ROUND_UP(');
  fs.writeFileSync(path.join(overlay,'blur/ffx_blur.h'),algorithm);
 }
 fs.writeFileSync(path.join(overlay,effect,'ffx_'+effect+'_callbacks_hlsl.h'),callbacks);
 const cpp=read('sdk/src/components/'+effect+'/ffx_'+effect+'.cpp'),privateHeader=read('sdk/src/components/'+effect+'/ffx_'+effect+'_private.h');
 const type=effect==='lens'?'LensConstants':'BlurConstants',constants=new RegExp('typedef struct '+type+'[\\s\\S]*?} '+type+';').exec(privateHeader)?.[0];if(!constants)throw Error('The original FidelityFX constants changed.');
 if(effect==='lens'){
  for(const text of ['threadGroupWorkRegionDim = 8','FFX_DIVIDE_ROUNDING_UP(params->renderSize.width, threadGroupWorkRegionDim)','FFX_DIVIDE_ROUNDING_UP(params->renderSize.height, threadGroupWorkRegionDim)','lensConst.center[0]   = params->renderSize.width / 2','lensConst.center[1]   = params->renderSize.height / 2'])if(!cpp.includes(text))throw Error('The original Lens dispatch changed.');
 }else for(const text of ['FFX_DIVIDE_ROUNDING_UP(constants.width, FFX_BLUR_TILE_SIZE_X)','dispatchY = FFX_BLUR_DISPATCH_Y','dispatchZ = 1'])if(!cpp.includes(text))throw Error('The original Blur dispatch changed.');
 fs.writeFileSync(path.join(out,'ffx-'+effect+'-upstream.hpp'),'// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see ffx-'+effect+'-MIT.txt.\n#pragma once\n#include <array>\n#include <cstdint>\nnamespace macfx::ffx_'+effect+'_host {\n'+constants+'\ninline std::array<unsigned,3>dispatch(unsigned width,unsigned height){return '+(effect==='lens'?'{(width+7)/8,(height+7)/8,1}':'{(width+7)/8,8,1}')+';}\n}\n');
 const variants=effect==='lens'?[{dimension:0,sigma:0}]:Array.from({length:10},(_,i)=>i*2+3).flatMap(dimension=>[0,1,2].map(sigma=>({dimension,sigma}))),shaders=[];
 for(const variant of variants){
  const name=effect==='lens'?'lens':variant.dimension+'-'+variant.sigma,base=path.join(out,name),input=base+'.hlsl',spv=base+'.spv',metal=base+'.metal';fs.writeFileSync(input,read('sdk/src/backends/dx12/shaders/'+effect+'/ffx_'+effect+'_pass.hlsl'));
  const defines={FFX_GPU:1,FFX_HLSL:1,FFX_HLSL_6_2:1,FFX_HALF:0,...(effect==='blur'?{FFX_BLUR_OPTION_KERNEL_DIMENSION:variant.dimension,FFX_BLUR_OPTION_KERNEL_PERMUTATION:variant.sigma}:{})};
  run(path.join(tools,'dxc'),['-spirv','-fspv-target-env=vulkan1.1spirv1.4','-T','cs_6_2','-E','CS','-O3','-fvk-t-shift','32','0','-fvk-u-shift','64','0','-I',overlay,'-I',gpu,...Object.entries(defines).flatMap(([k,v])=>['-D',k+'='+v]),input,'-Fo',spv]);
  run(path.join(tools,'spirv-val'),['--target-env','vulkan1.1spv1.4',spv]);run(path.join(tools,'spirv-cross'),[spv,'--msl','--msl-version','23000','--output',metal]);
  const reflection=JSON.parse(run(path.join(tools,'spirv-cross'),[spv,'--reflect'])),msl=fs.readFileSync(metal,'utf8'),entry=/kernel\s+\w+\s+(\w+)\s*\(([\s\S]*?)\)\s*\{/.exec(msl);if(!entry)throw Error('The translated FidelityFX entry is unavailable.');
  const bindings=[...entry[2].matchAll(/(\w+)\s*\[\[(buffer|texture|sampler)\((\d+)\)\]\]/g)].map(m=>({name:m[1],kind:m[2],index:Number(m[3])}));shaders.push({...variant,name,entry:entry[1],threads:reflection.entryPoints[0].workgroup_size,bindings,sha256:hash(msl),source:msl});fs.rmSync(spv);
 }
 let header='// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see ffx-'+effect+'-MIT.txt.\n// Generated original FidelityFX '+effect+' compute kernels.\n#pragma once\n#include <cstddef>\nnamespace macfx::ffx_'+effect+'_shaders {\nstruct Binding{const char*name;const char*kind;unsigned index;};\nstruct Shader{const char*name;const char*entry;const char*source;const Binding*bindings;size_t count;unsigned dimension,sigma,x,y,z;};\n';
 shaders.forEach((s,i)=>{header+=`inline constexpr Binding bindings${i}[]={${s.bindings.map(b=>'{'+JSON.stringify(b.name)+','+JSON.stringify(b.kind)+','+b.index+'}').join(',')}};\ninline constexpr const char*source${i}=R"FFX_IMAGE(${s.source})FFX_IMAGE";\n`;});header+='inline constexpr Shader shaders[]={'+shaders.map((s,i)=>`{${JSON.stringify(s.name)},${JSON.stringify(s.entry)},source${i},bindings${i},sizeof(bindings${i})/sizeof(Binding),${s.dimension},${s.sigma},${s.threads.join(',')}}`).join(',')+'};\n}\n';
 fs.writeFileSync(path.join(out,'ffx-'+effect+'-shaders.hpp'),header);fs.writeFileSync(path.join(out,'ffx-'+effect+'-MIT.txt'),read('LICENSE.txt'));
 const record={schema:1,repository:spec.repository,commit:spec.commit,version:spec.version,license:spec.license,source:spec,owned:hash(fs.readFileSync(fileURLToPath(import.meta.url))),adaptations:{boundedLogicalImages:true,originalDispatch:true,float32Arithmetic:true,exactSourceAlphaBoundary:true,callbacks:{sourceSha256:hash(original),appliedSha256:hash(callbacks)},...(algorithm?{algorithm:{sourceSha256:spec.files['sdk/include/FidelityFX/gpu/blur/ffx_blur.h'],appliedSha256:hash(algorithm),unpackedFloat32Cache:true,smallImageSignedLoopBounds:true,paddedThreadsParticipateInBarriers:true}}:{})},shaders:shaders.map(({source,...s})=>s),headerSha256:hash(header),tools:Object.fromEntries(['dxc','spirv-cross','spirv-val'].map(name=>[name,hash(fs.readFileSync(path.join(tools,name)))]))};
 fs.writeFileSync(path.join(out,'ffx-'+effect+'-source.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({effect,output:out,kernels:shaders.length}));
}
