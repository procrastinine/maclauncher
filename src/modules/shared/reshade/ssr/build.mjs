#!/usr/bin/env node
// Copyright (c) MacLauncher contributors. MIT license.
// Compile the original Godot SSR kernels without changing upstream sources.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname,spec=JSON.parse(fs.readFileSync(path.join(here,'source.json'))),options={};
for(let i=2;i<process.argv.length;i+=2){
 const key=process.argv[i];
 if(!['--source','--compiler-root','--license','--output'].includes(key)||!process.argv[i+1]||options[key])throw Error('Expected unique source, compiler-root, license and output paths.');
 options[key]=path.resolve(process.argv[i+1]);
}
for(const key of ['--source','--compiler-root','--output'])if(!options[key])throw Error('Missing '+key);
const source=options['--source'],compiler=options['--compiler-root'],out=options['--output'];
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',maxBuffer:32*1024*1024});
if(fs.existsSync(path.join(source,'.git'))&&run('git',['-C',source,'rev-parse','HEAD']).trim()!==spec.commit)throw Error('Godot SSR source pin changed.');
const original={};
for(const [file,expected]of Object.entries(spec.files)){
 const bytes=fs.readFileSync(path.join(source,file));if(sha(bytes)!==expected)throw Error('Godot SSR source changed: '+file);original[file]=bytes.toString('utf8');
}
const license=fs.readFileSync(options['--license']||path.join(source,spec.licenseFile));
if(sha(license)!==spec.licenseSha256)throw Error('Godot SSR license changed.');
if(fs.existsSync(out))throw Error('Choose a new shader output directory.');
fs.mkdirSync(out,{recursive:true});
const base='servers/rendering/renderer_rd/shaders/effects/',shader=name=>original[base+name+'.glsl'];
const host=original['servers/rendering/renderer_rd/effects/ss_effects.h'];
const structs=[['SceneData','ScreenSpaceReflectionSceneData',288],['Scale','ScreenSpaceReflectionScalePushConstant',32],['Main','ScreenSpaceReflectionPushConstant',64],['Filter','ScreenSpaceReflectionFilterPushConstant',48]];
let hostHeader='// Original Godot 4.4 constants. MIT; see ssr-MIT.txt.\n#pragma once\n#include <cstdint>\nnamespace macfx::ssr_host {\n';
for(const [name,upstream,size]of structs){
 const body=new RegExp('struct '+upstream+' \\{([\\s\\S]*?)\\n\\t\\};').exec(host)?.[1];
 if(!body)throw Error('Original SSR constants changed: '+upstream);
 hostHeader+='struct '+name+' {'+body+'\n};\nstatic_assert(sizeof('+name+')=='+size+',"Original Godot SSR constants changed");\n';
}
hostHeader+='}\n';fs.writeFileSync(path.join(out,'ssr-upstream.hpp'),hostHeader);
const roles=[
 {name:'scale',file:'screen_space_reflection_scale',size:32},
 {name:'main',file:'screen_space_reflection',size:64},
 {name:'main_rough',file:'screen_space_reflection',size:64,defines:['MODE_ROUGH']},
 {name:'filter_h',file:'screen_space_reflection_filter',size:48},
 {name:'filter_v',file:'screen_space_reflection_filter',size:48,defines:['VERTICAL_PASS']},
 {name:'merge_vertex',file:'specular_merge',stage:'vertex',defines:['MODE_SSR']},
 {name:'merge_specular',file:'specular_merge',stage:'fragment',defines:['MODE_SSR']},
 {name:'merge_full',file:'specular_merge',stage:'fragment',defines:['MODE_SSR','MODE_MERGE']}
];
const results=[];
for(const role of roles){
 const stage=role.stage||'compute',sections=shader(role.file).split(/^#\[(\w+)\]\s*$/m);
 const index=sections.findIndex((value,i)=>i%2===1&&value===stage);
 if(index<0)throw Error('Original shader stage is missing: '+role.name);
 let glsl=sections[index+1];
 if(glsl.split('#VERSION_DEFINES').length!==2)throw Error('Original shader definitions changed.');
 glsl=glsl.replace('#VERSION_DEFINES',(role.defines||[]).map(name=>'#define '+name+' 1').join('\n'));
 glsl=glsl.replace(/^#include "screen_space_reflection_inc.glsl"\s*$/m,shader('screen_space_reflection_inc'));
 if(/^\s*#include\b/m.test(glsl))throw Error('An undeclared shader include remains.');
 const file=path.join(out,role.name+'.glsl'),spv=path.join(out,role.name+'.spv'),directory=path.join(out,role.name);
 fs.writeFileSync(file,glsl);
 run(path.join(compiler,'shaderc-offline'),['--library',path.join(compiler,'libplacebo/libshaderc_shared.1.dylib'),'--input',file,'--output',spv,'--stage',stage]);
 run(path.join(compiler,'fx-compile'),['--spirv-to-msl',spv,directory]);
 const msl=fs.readFileSync(path.join(directory,'shader.metal'),'utf8'),reflection=JSON.parse(fs.readFileSync(path.join(directory,'reflection.json')));
 const entry=new RegExp('(?:kernel|vertex|fragment)\\s+\\w+\\s+(\\w+)\\s*\\(([\\s\\S]*?)\\)\\s*\\{').exec(msl);
 if(!entry||reflection.stage!==stage)throw Error('The translated shader entry is invalid: '+role.name);
 const bindings=[...entry[2].matchAll(/(\w+)\s*\[\[(buffer|texture|sampler)\((\d+)\)\]\]/g)].map(([,name,kind,index])=>({name,kind,index:Number(index)}));
 for(const kind of ['buffer','texture','sampler'])if(new Set(bindings.filter(row=>row.kind===kind).map(row=>row.index)).size!==bindings.filter(row=>row.kind===kind).length)throw Error('Metal shader bindings overlap.');
 const params=bindings.find(row=>row.name==='params');
 if(role.size&&!params)throw Error('The original push-constant binding is missing.');
 if(role.size&&reflection.resources.find(row=>row.kind==='push-constant')?.size!==role.size)throw Error('The reflected original push-constant layout changed.');
 results.push({...role,stage,entry:entry[1],threads:reflection.threads||[0,0,0],bindings,reflection,...(params?{pushConstant:{...params,size:role.size}}:{}),msl,glslSha256:sha(glsl),mslSha256:sha(msl)});
}
let header='// Original Godot 4.4 SSR kernels. MIT; see ssr-MIT.txt.\n#pragma once\n#include <cstddef>\nnamespace macfx::ssr_shaders {\nstruct Binding{const char*name;const char*kind;unsigned index;};\nstruct Shader{const char*name;const char*entry;const char*source;const Binding*bindings;size_t count;unsigned x,y,z;};\n';
results.forEach((row,i)=>{
 header+=row.bindings.length?'inline constexpr Binding bindings'+i+'[]={'+row.bindings.map(binding=>'{'+JSON.stringify(binding.name)+','+JSON.stringify(binding.kind)+','+binding.index+'}').join(',')+'};\n':'inline constexpr const Binding*bindings'+i+'=nullptr;\n';
 if(row.msl.includes(')SSR_GPU"'))throw Error('Unexpected raw-string delimiter in Metal source.');
 header+='inline constexpr const char*source'+i+'=R"SSR_GPU('+row.msl+')SSR_GPU";\n';
});
header+='inline constexpr Shader shaders[]={'+results.map((row,i)=>'{'+JSON.stringify(row.name)+','+JSON.stringify(row.entry)+',source'+i+',bindings'+i+','+row.bindings.length+','+row.threads.join(',')+'}').join(',')+'};\n}\n';
fs.writeFileSync(path.join(out,'ssr-shaders.hpp'),header);fs.writeFileSync(path.join(out,'ssr-MIT.txt'),license);
const metadata={schema:1,...spec,ownedRecipeSha256:sha(fs.readFileSync(import.meta.filename)),shaders:results.map(({msl,...row})=>row)};
fs.writeFileSync(path.join(out,'ssr-source.json'),JSON.stringify(metadata,null,2)+'\n');
console.log(JSON.stringify({output:out,shaders:results.length,roles:results.map(row=>row.name)}));
