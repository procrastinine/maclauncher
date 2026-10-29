#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Metal translation of Intel's original CMAA2 compute pipeline.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync}from'node:child_process';
const here=import.meta.dirname,spec=JSON.parse(fs.readFileSync(path.join(here,'source.json'))),options={};
for(let i=2;i<process.argv.length;i+=2){if(!['--source','--tools','--output'].includes(process.argv[i])||!process.argv[i+1]||options[process.argv[i]])throw Error('Expected unique --source, --tools and --output paths.');options[process.argv[i]]=path.resolve(process.argv[i+1]);}
for(const key of ['--source','--tools','--output'])if(!options[key])throw Error('Missing '+key);
const source=options['--source'],tools=options['--tools'],out=options['--output'],hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),run=(program,args)=>execFileSync(program,args,{encoding:'utf8',maxBuffer:16*1024*1024});
if(run('git',['-C',source,'rev-parse','HEAD']).trim()!==spec.commit)throw Error('CMAA2 source differs from its registered revision.');run('git',['-C',source,'diff','--exit-code','HEAD','--']);
const original=fs.readFileSync(path.join(source,spec.shader.path));if(hash(original)!==spec.shader.sha256)throw Error('CMAA2 shader source changed.');
fs.mkdirSync(out,{recursive:true});let hlsl=original.toString('utf8');
const preset=/#if CMAA2_STATIC_QUALITY_PRESET == 0[\s\S]*?#endif/.exec(hlsl);if(!preset||!preset[0].includes('lpfloat(0.05)')||!preset[0].includes('lpfloat(0.15)'))throw Error('CMAA2 quality preset contract changed.');
hlsl=hlsl.replace(preset[0],'cbuffer MacLauncherCmaaOptions : register(b0) { float mlEdgeThreshold; };\n#define g_CMAA2_EdgeThreshold lpfloat(mlEdgeThreshold)');
const load='lpfloat3 color = g_inoutColorReadonly.Load( int3( pixelPos, 0 ), offset ).rgb;';if(hlsl.split(load).length!==2)throw Error('CMAA2 color-load offset contract changed.');
hlsl=hlsl.replace(load,'uint width, height; g_inoutColorReadonly.GetDimensions(width, height);\n    lpfloat3 color = g_inoutColorReadonly.Load( int3( clamp(int2(pixelPos) + offset, int2(0, 0), int2(width-1, height-1)), 0 ) ).rgb;');
const append='uint counterIndex;  g_workingControlBuffer.InterlockedAdd( 4*12, 1, counterIndex );';if(hlsl.split(append).length!==2)throw Error('CMAA2 deferred-list append contract changed.');
hlsl=hlsl.replace(append,append+'\n    uint capacity, stride; g_workingDeferredBlendItemList.GetDimensions(capacity, stride);\n    if (counterIndex >= capacity) return;');
// Retain signed linear/HDR components and float32 blend precision. The original
// packed RGB optimization has no sign bits; the shape and blend math is unchanged.
for(const [from,to]of [
 ['RWStructuredBuffer<uint2>       g_workingDeferredBlendItemList','RWStructuredBuffer<uint4>       g_workingDeferredBlendItemList'],
 ['g_workingDeferredBlendItemList[counterIndex] = uint2( originalIndex, InternalPackColor( color ) );','g_workingDeferredBlendItemList[counterIndex] = uint4( originalIndex, asuint(color) );'],
 ['uint2 val = g_workingDeferredBlendItemList[','uint4 val = g_workingDeferredBlendItemList['],
 ['InternalUnpackColor(val.y)','asfloat(val.yzw)']
]){if(hlsl.split(from).length!==2)throw Error('CMAA2 deferred-color storage contract changed.');hlsl=hlsl.replace(from,to);}
for(const [from,to]of [
 ['return sqrt( color );','return sign(color) * sqrt(abs(color));'],
 ['dot( sqrt( linearRGB.rgb ),','dot( sign(linearRGB.rgb) * sqrt(abs(linearRGB.rgb)),']
]){if(hlsl.split(from).length!==2)throw Error('CMAA2 edge-metric domain changed.');hlsl=hlsl.replace(from,to);}
const input=path.join(out,'CMAA2-metal.hlsl');fs.writeFileSync(input,hlsl);
const shaders=[];
for(let hdr=0;hdr<2;hdr++)for(let sharp=0;sharp<2;sharp++)for(let pass=0;pass<spec.entries.length;pass++){
 const base=path.join(out,`${hdr}-${sharp}-${pass}`),spv=base+'.spv',metal=base+'.metal';
 const defines={CMAA_MSAA_SAMPLE_COUNT:1,CMAA2_EDGE_DETECTION_LUMA_PATH:1,CMAA2_SUPPORT_HDR_COLOR_RANGE:hdr,CMAA2_EXTRA_SHARPNESS:sharp,CMAA2_UAV_STORE_TYPED:1,CMAA2_UAV_STORE_TYPED_UNORM_FLOAT:0,CMAA2_UAV_STORE_CONVERT_TO_SRGB:0,CMAA2_USE_HALF_FLOAT_PRECISION:0};
 run(path.join(tools,'dxc'),['-spirv','-fspv-target-env=vulkan1.1spirv1.4','-T','cs_6_2','-E',spec.entries[pass],'-O3','-fvk-t-shift','32','0','-fvk-u-shift','64','0',...Object.entries(defines).flatMap(([k,v])=>['-D',k+'='+v]),input,'-Fo',spv]);
 run(path.join(tools,'spirv-val'),['--target-env','vulkan1.1spv1.4',spv]);run(path.join(tools,'spirv-cross'),[spv,'--msl','--msl-version','23000','--output',metal]);
 const reflected=JSON.parse(run(path.join(tools,'spirv-cross'),[spv,'--reflect'])),msl=fs.readFileSync(metal,'utf8'),entry=/kernel\s+\w+\s+(\w+)\s*\(([\s\S]*?)\)\s*\{/.exec(msl);if(!entry)throw Error('The translated CMAA2 entry is unavailable.');
 const bindings=[...entry[2].matchAll(/(\w+)\s*\[\[(buffer|texture|sampler)\((\d+)\)\]\]/g)].map(m=>({name:m[1],kind:m[2],index:Number(m[3])}));
 const item={hdr,sharp,pass,entry:entry[1],threads:reflected.entryPoints[0].workgroup_size,bindings,sha256:hash(msl)};shaders.push({...item,source:msl});fs.writeFileSync(base+'.json',JSON.stringify(item,null,2)+'\n');fs.rmSync(spv);
}
let header='// Copyright (c) 2018 Intel Corporation. Apache-2.0; see cmaa2-APACHE-2.0.txt.\n// Generated by cmaa2/build.mjs from the declared original source.\n#pragma once\n#include <cstddef>\nnamespace macfx::cmaa2_shaders {\nstruct Binding {const char*name;const char*kind;unsigned index;};\nstruct Shader {const char*entry;const char*source;const Binding*bindings;size_t count;unsigned x,y,z;};\n';
for(let i=0;i<shaders.length;i++){const s=shaders[i];header+=`inline constexpr Binding bindings${i}[]={${s.bindings.map(b=>'{'+JSON.stringify(b.name)+','+JSON.stringify(b.kind)+','+b.index+'}').join(',')}};\ninline constexpr const char*source${i}=R"CMAA_SHADER(${s.source})CMAA_SHADER";\n`;}
header+='inline constexpr Shader shaders[2][2][4]={';for(let hdr=0;hdr<2;hdr++){header+='{';for(let sharp=0;sharp<2;sharp++){header+='{';for(let pass=0;pass<4;pass++){const index=hdr*8+sharp*4+pass,s=shaders[index];header+=`{${JSON.stringify(s.entry)},source${index},bindings${index},sizeof(bindings${index})/sizeof(Binding),${s.threads.join(',')}},`;}header+='},';}header+='},';}header+='};\n}\n';
fs.writeFileSync(path.join(out,'cmaa2-shaders.hpp'),header);fs.writeFileSync(path.join(out,'translation.json'),JSON.stringify({schema:1,repository:spec.repository,commit:spec.commit,license:spec.license,source:spec,owned:hash(fs.readFileSync(import.meta.filename)),adaptation:{qualityThresholdUniform:true,logicalColorLoadClamp:true,signedEdgeMetric:true,dynamicTextureOffsetCoordinates:true,deferredAppendCapacityGuard:true,deferredColorStorage:"signed-float32-rgb",sourceSha256:spec.shader.sha256,appliedSha256:hash(hlsl)},shaders:shaders.map(({source,...item})=>item),headerSha256:hash(header),tools:Object.fromEntries(['dxc','spirv-cross','spirv-val'].map(name=>[name,hash(fs.readFileSync(path.join(tools,name)))]))},null,2)+'\n');console.log('Translated original CMAA2 pipeline: '+out);
