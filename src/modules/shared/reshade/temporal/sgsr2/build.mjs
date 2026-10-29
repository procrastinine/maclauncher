#!/usr/bin/env node
// Offline GLSL -> SPIR-V -> Metal translation of Qualcomm's two-pass SGSR2.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),spec=JSON.parse(fs.readFileSync(path.join(here,'source.json'),'utf8'));
const options={};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(key==='--native-only'&&!options[key]){options[key]=true;i--;continue;}if(!['--source','--tools','--shaderc-library','--shaderc-headers','--shader-cache','--output'].includes(key)||!process.argv[i+1]||options[key])throw new Error('Expected unique named build input paths.');options[key]=path.resolve(process.argv[i+1]);}
for(const key of ['--source','--output',...(options['--native-only']?['--shader-cache']:['--tools','--shaderc-library','--shaderc-headers'])])if(!options[key])throw new Error('Missing '+key);
if(options['--shader-cache']&&!options['--native-only'])throw new Error('--shader-cache requires --native-only.');
const run=(exe,args)=>execFileSync(exe,args,{encoding:'utf8',maxBuffer:16*1024*1024});
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const source=options['--source'],out=options['--output'],tools=options['--tools'];
if(run('git',['-C',source,'rev-parse','HEAD']).trim()!==spec.commit)throw new Error('SGSR source differs from the registered exact commit.');
if(fs.existsSync(out))throw new Error('Choose a new immutable output directory.');
for(const [filename,expected] of Object.entries(spec.shaders))if(hash(path.join(source,'sgsr/v2/include/glsl_2_pass_cs',filename))!==expected)throw new Error('SGSR shader input changed: '+filename);
fs.mkdirSync(path.join(out,'sgsr2'),{recursive:true});
const adaptations=[];let buildInputs;
if(options['--native-only']){
  const cache=options['--shader-cache'],metadata=JSON.parse(fs.readFileSync(path.join(cache,'provider.json'),'utf8'));
  if(metadata.providerABI!==1||metadata.complete!==true||metadata.methods?.join()!=='sgsr2'||metadata.source?.repository!==spec.repository||metadata.source?.commit!==spec.commit||metadata.owned?.['source.json']!==hash(path.join(here,'source.json'))||metadata.owned?.['../../shaderc-offline.cpp']!==hash(path.join(here,'../../shaderc-offline.cpp')))throw new Error('SGSR2 shader cache differs from the registered shader inputs.');
  for(const [file,sourceSha256] of Object.entries(spec.shaders))if(!metadata.adaptations?.some(row=>row.file===file&&row.sourceSha256===sourceSha256))throw new Error('SGSR2 shader cache adaptations are incomplete.');
  for(const relative of ['convert','upscale'].flatMap(pass=>['metal','json'].map(ext=>'sgsr2/'+pass+'.'+ext))){const file=path.join(cache,relative),row=metadata.files?.find(row=>row.path===relative);if(!row||!fs.statSync(file).isFile()||row.size!==fs.statSync(file).size||row.sha256!==hash(file))throw new Error('SGSR2 shader cache file changed: '+relative);fs.copyFileSync(file,path.join(out,relative));}
  adaptations.push(...metadata.adaptations);buildInputs=metadata.buildInputs;
}else{
const compiler=path.join(out,'shaderc-offline');
run('xcrun',['clang++','-std=c++17','-O2','-I',options['--shaderc-headers'],path.join(here,'../../shaderc-offline.cpp'),'-o',compiler]);
for(const [filename,expected] of Object.entries(spec.shaders)){
  const original=path.join(source,'sgsr/v2/include/glsl_2_pass_cs',filename);
  if(hash(original)!==expected)throw new Error('SGSR shader input changed: '+filename);
  let text=fs.readFileSync(original,'utf8');
  // GLSL's image/sampler namespaces become unique Vulkan descriptor bindings.
  text=text.replace(/layout\(binding = (\d+)\)( uniform highp [u]?sampler2D)/g,(_all,slot,decl)=>`layout(binding = ${32+Number(slot)})${decl}`)
    .replace(/layout\(binding = (\d+), (rgba16f|r32ui)\)/g,(_all,slot,format)=>`layout(binding = ${64+Number(slot)}, ${format})`);
  const convert=filename.includes('convert');
  text=text.replace('void main()\n{',`void main()\n{\n    if(any(greaterThanEqual(gl_GlobalInvocationID.xy, params.${convert?'renderSize':'displaySize'}))) return;`);
  if(convert){
    const begin=text.indexOf('    vec2 motion;'),end=text.indexOf('    ////////////compute luma',begin);
    if(begin<0||end<0)throw new Error('SGSR motion input boundary changed.');
    // The common contract supplies every pixel's real motion. Do not interpret
    // signed motion as Unreal's packed encoding or invent projection matrices.
    text=text.slice(0,begin)+'    vec2 motion = EncodedVelocity.xy;\n\n'+text.slice(end);
  }else{
    const from='texelFetch(YCoCgColor, InputPosBtmRight, 0)';
    if(!text.includes(from))throw new Error('SGSR edge load changed.');
    text=text.replace(from,'texelFetch(YCoCgColor, clamp(InputPosBtmRight, ivec2(0), textureSize(YCoCgColor, 0) - ivec2(1)), 0)');
  }
  const base=path.join(out,'sgsr2',convert?'convert':'upscale'),input=base+'.comp',spv=base+'.spv',metal=base+'.metal';
  fs.writeFileSync(input,text);
  run(compiler,['--library',options['--shaderc-library'],'--input',input,'--output',spv,'--language','glsl','--stage','compute']);
  run(path.join(tools,'spirv-val'),['--target-env','vulkan1.1',spv]);
  run(path.join(tools,'spirv-cross'),[spv,'--msl','--msl-version','23000','--output',metal]);
  const msl=fs.readFileSync(metal,'utf8'),entry=/kernel\s+void\s+(\w+)\s*\(([\s\S]*?)\)\s*\{/.exec(msl);
  if(!entry)throw new Error('Translated Metal compute entry is missing.');
  const reflection=JSON.parse(run(path.join(tools,'spirv-cross'),[spv,'--reflect']));
  const bindings=[...entry[2].matchAll(/(\w+)\s*\[\[(buffer|texture|sampler)\((\d+)\)\]\]/g)].map(match=>({name:match[1],kind:match[2],index:Number(match[3])}));
  const ubo=reflection.ubos.find(value=>value.name==='Params');
  if(!ubo||ubo.block_size!==136)throw new Error('SGSR uniform layout changed.');
  fs.writeFileSync(base+'.json',JSON.stringify({entry:entry[1],threads:reflection.entryPoints[0].workgroup_size,bindings,uniformBytes:ubo.block_size},null,2)+'\n');
  adaptations.push({file:filename,sourceSha256:expected,appliedSha256:hash(input),changes:['descriptor-namespaces','bounded-dispatch',...(convert?['native-signed-motion']:['clamped-edge-load'])]});
  fs.rmSync(input);fs.rmSync(spv);
}
buildInputs={shadercLibrary:hash(options['--shaderc-library']),shadercHeader:hash(path.join(options['--shaderc-headers'],'shaderc/shaderc.h')),spirvCross:hash(path.join(tools,'spirv-cross')),spirvVal:hash(path.join(tools,'spirv-val'))};
}
for(const arch of ['arm64','x86_64'])run('xcrun',['clang++','-std=c++17','-O2','-fobjc-arc','-arch',arch,'-mmacosx-version-min=13.0','-dynamiclib',path.join(here,'backend.mm'),'-framework','Metal','-framework','Foundation','-install_name','@rpath/libmaclauncher-sgsr2.dylib','-o',path.join(out,`libmaclauncher-sgsr2-${arch}.dylib`)]);
const library=path.join(out,'libmaclauncher-sgsr2.dylib');
run('lipo',['-create',...['arm64','x86_64'].map(arch=>path.join(out,`libmaclauncher-sgsr2-${arch}.dylib`)),'-output',library]);
run('codesign',['--force','--sign','-',library]);
const license=path.join(source,'LICENSE');fs.copyFileSync(license,path.join(out,'SGSR-LICENSE.txt'));
const files=[];for(const relative of ['libmaclauncher-sgsr2.dylib','SGSR-LICENSE.txt',...['convert','upscale'].flatMap(pass=>['metal','json'].map(ext=>'sgsr2/'+pass+'.'+ext))])files.push({path:relative,size:fs.statSync(path.join(out,relative)).size,sha256:hash(path.join(out,relative))});
const owned=Object.fromEntries(['source.json','build.mjs','backend.mm','descriptor.js','../frame.h','../command-order.hpp','../../shaderc-offline.cpp'].map(name=>[name,hash(path.join(here,name))]));
fs.writeFileSync(path.join(out,'provider.json'),JSON.stringify({providerABI:1,complete:true,methods:['sgsr2'],minimumMacOS:spec.minimumMacOS,architectures:['arm64','x86_64'],libraries:['libmaclauncher-sgsr2.dylib'],shaders:['sgsr2'],resourcePreparation:1,files,source:{repository:spec.repository,commit:spec.commit},owned,adaptations,notices:[{name:'Snapdragon Game Super Resolution 2',license:spec.license,path:'SGSR-LICENSE.txt',sourceUrl:spec.repository}],buildInputs},null,2)+'\n');
console.log('Built SGSR2 Metal provider: '+out);
