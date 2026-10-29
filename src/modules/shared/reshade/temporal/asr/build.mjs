#!/usr/bin/env node
// Offline translation of the original Arm ASR mixed fragment/compute graph.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname,spec=JSON.parse(fs.readFileSync(path.join(here,'source.json'))),options={};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(key==='--native-only'){options[key]=true;i--;continue;}if(!['--source','--tools','--output'].includes(key)||!process.argv[i+1]||options[key])throw Error('Expected unique source, tools and output paths.');options[key]=path.resolve(process.argv[i+1]);}
for(const key of ['--source','--tools','--output'])if(!options[key])throw Error('Missing '+key);
const source=options['--source'],tools=options['--tools'],out=options['--output'];
const run=(exe,args)=>execFileSync(exe,args,{encoding:'utf8',maxBuffer:16*1024*1024}),hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(run('git',['-C',source,'rev-parse','HEAD']).trim()!==spec.commit)throw Error('Arm ASR source differs from its registered exact revision.');
run('git',['-C',source,'diff','--exit-code','HEAD','--']);
if(fs.existsSync(out)&&!options['--native-only'])throw Error('Choose a new ASR output directory.');fs.mkdirSync(out,{recursive:true});
const shaderRoot=path.join(source,'src/backends/vk/shaders/fsr2/hlsl'),gpu=path.join(source,'include/gpu');
for(const [file,digest]of Object.entries(spec.shaders))if(hash(path.join(shaderRoot,file))!==digest)throw Error('Arm ASR shader input changed: '+file);
const shaderOverlay=path.join(out,'shader-overlay'),rgbOriginal=path.join(source,spec.rgbBoundary.file),rgbOverlay=path.join(shaderOverlay,'fsr2/ffxm_fsr2_callbacks_hlsl.h');
if(hash(rgbOriginal)!==spec.rgbBoundary.sha256)throw Error('ASR RGB load boundary source changed.');
let rgbHeader=fs.readFileSync(rgbOriginal,'utf8');for(const [texture,component]of [['r_input_color_jittered','rgb'],['r_prepared_input_color','xyz']]){
 const anchor='return '+texture+'[iPxPos].'+component+';';if(rgbHeader.split(anchor).length!==2)throw Error('ASR RGB load callback changed.');
 rgbHeader=rgbHeader.replace(anchor,'return '+texture+'[FfxUInt32x2(clamp(FfxInt32x2(iPxPos), FfxInt32x2(0, 0), RenderSize() - FfxInt32x2(1, 1)))].'+component+';');
}
// The SDK allocates this texture at maxRenderSize, while these gather UVs are
// normalized to the current RenderSize. Resolve the same four point taps in
// logical scene coordinates so dynamic resolution cannot read an older region.
const gather=/void GatherPreparedInputColorRGBQuad\([\s\S]*?\n}\n/.exec(rgbHeader);
if(!gather||!gather[0].includes('r_prepared_input_color.GatherRed(s_PointClamp, fUV)'))throw Error('ASR prepared RGB gather contract changed.');
const signature=gather[0].slice(0,gather[0].indexOf('\n{'));
rgbHeader=rgbHeader.replace(gather[0],signature+'\n{\n    FfxInt32x2 base = FfxInt32x2(floor(fUV * FfxFloat32x2(RenderSize()) - FfxFloat32x2(0.5f, 0.5f)));\n    col00 = LoadPreparedInputColor(base);\n    col10 = LoadPreparedInputColor(base + FfxInt32x2(1, 0));\n    col01 = LoadPreparedInputColor(base + FfxInt32x2(0, 1));\n    col11 = LoadPreparedInputColor(base + FfxInt32x2(1, 1));\n}\n');
fs.mkdirSync(path.dirname(rgbOverlay),{recursive:true});fs.writeFileSync(rgbOverlay,rgbHeader);
const historyOriginal=path.join(source,spec.sdrHistory.file),historyOverlay=path.join(shaderOverlay,'fsr2/ffxm_fsr2_accumulate.h');
if(hash(historyOriginal)!==spec.sdrHistory.sha256)throw Error('ASR SDR accumulation source changed.');
let historyHeader=fs.readFileSync(historyOriginal,'utf8');const accumulate=/void Accumulate\([\s\S]*?\n}\n/.exec(historyHeader);
if(!accumulate||accumulate[0].split('#if FFXM_FSR2_OPTION_HDR_COLOR_INPUT').length!==3)throw Error('ASR accumulation color-domain contract changed.');
historyHeader=historyHeader.replace(accumulate[0],accumulate[0].replaceAll('#if FFXM_FSR2_OPTION_HDR_COLOR_INPUT','#if FFXM_FSR2_OPTION_HDR_COLOR_INPUT || FFXM_SHADER_QUALITY_OPT_TONEMAPPED_RGB_PREPARED_INPUT_COLOR'));
fs.writeFileSync(historyOverlay,historyHeader);
const passFiles=['depth_clip_pass_fs','reconstruct_previous_depth_pass_fs','lock_pass','accumulate_pass_fs','accumulate_pass_fs','rcas_pass_fs','compute_luminance_pyramid_pass','autogen_reactive_pass_fs'];
function targets(profile,pass){
 const ultra=profile===4,balanced=profile===2||profile===3;
 if(pass===0)return ['rw_dilated_reactive_masks',...(!ultra?['rw_prepared_input_color']:[])];
 if(pass===1)return ultra?['rw_dilated_depth_motion_vectors_input_luma']:['rw_dilatedDepth','rw_dilated_motion_vectors','rw_lock_input_luma'];
 if(pass===3||pass===4)return ['rw_internal_upscaled_color',...(balanced?['rw_internal_temporal_reactive']:[]),'rw_lock_status',...(!ultra&&!balanced?['rw_luma_history']:[]),...(pass===3?['rw_upscaled_output']:[])];
 if(pass===5)return ['rw_upscaled_output'];if(pass===7)return ['rw_output_autoreactive'];return [];
}
function translate(file,base,stage,defines,rt=[]){
 const spv=base+'.spv',metal=base+'.metal';fs.mkdirSync(path.dirname(base),{recursive:true});
 run(path.join(tools,'dxc'),['-spirv','-fspv-target-env=vulkan1.1spirv1.4','-T',stage+'_6_2','-E','main','-O3','-enable-16bit-types','-fvk-t-shift','32','0','-fvk-u-shift','64','0','-I',shaderOverlay,'-I',gpu,'-I',path.join(gpu,'fsr2'),...Object.entries(defines).flatMap(([k,v])=>['-D',k+'='+v]),file,'-Fo',spv]);
 run(path.join(tools,'spirv-val'),['--target-env','vulkan1.1spv1.4',spv]);
 run(path.join(tools,'spirv-cross'),[spv,'--msl','--msl-version','23000','--output',metal]);
 const reflected=JSON.parse(run(path.join(tools,'spirv-cross'),[spv,'--reflect']));let msl=fs.readFileSync(metal,'utf8');
 // Vulkan permits a three-component output into an RGBA image. Metal requires
 // all attachment components; source alpha is restored in the final GPU copy.
 for(let index=0;index<rt.length;index++)if(rt[index]==='rw_upscaled_output'){
  const field='out_var_SV_TARGET'+index,declaration='float3 '+field+' [[color('+index+')]];',assignment=new RegExp('out\\.'+field+' = ([^;]+);','g');
  if(msl.split(declaration).length!==2||[...msl.matchAll(assignment)].length!==1)throw Error('ASR RGB output storage contract changed.');
  msl=msl.replace(declaration,'float4 '+field+' [[color('+index+')]];').replace(assignment,'out.'+field+' = float4($1, 1.0f);');
 }fs.writeFileSync(metal,msl);
 const entry=new RegExp('(?:kernel|fragment|vertex)\\s+\\w+\\s+(\\w+)\\s*\\(([\\s\\S]*?)\\)\\s*\\{').exec(msl);
 if(!entry)throw Error('Translated ASR shader entry is missing.');
 const bindings=[...entry[2].matchAll(/(\w+)\s*\[\[(buffer|texture|sampler)\((\d+)\)\]\]/g)].map(m=>({name:m[1],kind:m[2],index:Number(m[3])}));
 if(stage==='ps'&&(reflected.outputs?.length!==rt.length||reflected.outputs.some((r,i)=>r.location!==i)))throw Error('ASR fragment output contract changed.');
 fs.writeFileSync(base+'.json',JSON.stringify({entry:entry[1],stage,threads:reflected.entryPoints[0].workgroup_size||[1,1,1],bindings,targets:rt.map((name,index)=>({name,index}))},null,2)+'\n');fs.rmSync(spv);
}
if(!options['--native-only'])translate(path.join(shaderRoot,'ffxm_fsr2_vs.hlsl'),path.join(out,'asr/vertex'),'vs',{FFXM_GPU:1,FFXM_HLSL:1,FFXM_HLSL_6_2:1});
for(let profile=1;!options['--native-only']&&profile<=4;profile++)for(let flags=0;flags<16;flags++)for(let pass=0;pass<8;pass++){
 const d={FFXM_GPU:1,FFXM_HLSL:1,FFXM_HLSL_6_2:1,FFXM_HALF:1,FFXM_FSR2_OPTION_HDR_COLOR_INPUT:flags&1?1:0,FFXM_FSR2_OPTION_INVERTED_DEPTH:flags&2?1:0,FFXM_FSR2_OPTION_LOW_RESOLUTION_MOTION_VECTORS:flags&4?0:1,FFXM_FSR2_OPTION_JITTERED_MOTION_VECTORS:flags&8?1:0,FFXM_FSR2_OPTION_APPLY_SHARPENING:pass===4?1:0,FFXM_FSR2_OPTION_SHADER_OPT_BALANCED:profile===2||profile===3?1:0,FFXM_FSR2_OPTION_SHADER_OPT_PERFORMANCE:profile===3?1:0,FFXM_FSR2_OPTION_SHADER_OPT_ULTRA_PERFORMANCE:profile===4?1:0};
 translate(path.join(shaderRoot,'ffxm_fsr2_'+passFiles[pass]+'.hlsl'),path.join(out,'asr',String(profile),String(flags),String(pass)),pass===2||pass===6?'cs':'ps',d,targets(profile,pass));
}
const overlay=path.join(out,'host-overlay');fs.mkdirSync(overlay,{recursive:true});
const original=path.join(source,'include/host/ffxm_fsr2.h'),header=fs.readFileSync(original,'utf8'),anchor='#define FFXM_FSR2_CONTEXT_SIZE (24576)';if(header.split(anchor).length!==2)throw Error('ASR context capacity changed.');
fs.writeFileSync(path.join(overlay,'ffxm_fsr2.h'),header.replace(anchor,'#define FFXM_FSR2_CONTEXT_SIZE (24576 * (sizeof(wchar_t) / 2))'));
const args=['-std=c++17','-O2','-DNDEBUG','-DFFXM_GCC','-mmacosx-version-min=13.0','-I',overlay,'-I',path.join(source,'include/host'),'-I',gpu,'-I',source,'-include',path.join(here,'host-compat.hpp'),'-ffile-prefix-map='+source+'=ArmASR','-ffile-prefix-map='+path.resolve(here,'../../../../../..')+'=MacLauncher','-ffile-prefix-map='+out+'=ASRBuild'];
for(const arch of ['arm64','x86_64']){
 const objects=[];for(const file of ['src/components/fsr2/ffxm_fsr2.cpp','src/shared/ffxm_assert.cpp','src/shared/ffxm_object_management.cpp']){const object=path.join(out,arch+'-'+path.basename(file)+'.o');run('xcrun',['clang++',...args,'-arch',arch,'-c',path.join(source,file),'-o',object]);objects.push(object);}
 run('xcrun',['clang++',...args,'-arch',arch,'-fobjc-arc','-dynamiclib',path.join(here,'backend.mm'),...objects,'-framework','Metal','-framework','Foundation','-install_name','@rpath/libmaclauncher-asr.dylib','-o',path.join(out,'libmaclauncher-asr-'+arch+'.dylib')]);
}
run('lipo',['-create',...['arm64','x86_64'].map(a=>path.join(out,'libmaclauncher-asr-'+a+'.dylib')),'-output',path.join(out,'libmaclauncher-asr.dylib')]);run('codesign',['--force','--sign','-',path.join(out,'libmaclauncher-asr.dylib')]);
fs.copyFileSync(path.join(source,'LICENSES/MIT.txt'),path.join(out,'ASR-MIT.txt'));
const ownedNames=['source.json','build.mjs','backend.mm','descriptor.js','host-compat.hpp','../frame.h','../command-order.hpp'],owned=Object.fromEntries(ownedNames.map(n=>[n,hash(path.join(here,n))]));
function inventory(dir,prefix=''){return fs.readdirSync(path.join(dir,prefix),{withFileTypes:true}).flatMap(e=>{const r=path.posix.join(prefix,e.name);return e.isDirectory()?inventory(dir,r):[{path:r,size:fs.statSync(path.join(dir,r)).size,sha256:hash(path.join(dir,r))}];});}
const files=[{path:'libmaclauncher-asr.dylib',size:fs.statSync(path.join(out,'libmaclauncher-asr.dylib')).size,sha256:hash(path.join(out,'libmaclauncher-asr.dylib'))},{path:'ASR-MIT.txt',size:fs.statSync(path.join(out,'ASR-MIT.txt')).size,sha256:hash(path.join(out,'ASR-MIT.txt'))},...inventory(out,'asr')];
fs.writeFileSync(path.join(out,'provider.json'),JSON.stringify({providerABI:1,complete:true,methods:['asr'],minimumMacOS:spec.minimumMacOS,architectures:['arm64','x86_64'],libraries:['libmaclauncher-asr.dylib'],shaders:['asr'],resourcePreparation:1,shaderProfiles:['quality','balanced','performance','ultra-performance'],files,owned,source:{repository:spec.repository,commit:spec.commit},adaptations:[{file:'include/host/ffxm_fsr2.h',sourceSha256:hash(original),appliedSha256:hash(path.join(overlay,'ffxm_fsr2.h')),changes:['Darwin-wchar-context-capacity']},{file:spec.rgbBoundary.file,sourceSha256:hash(rgbOriginal),appliedSha256:hash(rgbOverlay),changes:['Clamp-integer-RGB-loads-to-logical-render-region']},{file:spec.sdrHistory.file,sourceSha256:hash(historyOriginal),appliedSha256:hash(historyOverlay),changes:['Match-SDR-Performance-history-to-tonemapped-prepared-color']}],notices:[{name:'Arm ASR',license:'MIT',path:'ASR-MIT.txt',sourceUrl:spec.repository}],buildInputs:Object.fromEntries(['dxc','spirv-cross','spirv-val'].map(n=>[n,hash(path.join(tools,n))]))},null,2)+'\n');
console.log('Built Arm ASR Metal provider: '+out);
