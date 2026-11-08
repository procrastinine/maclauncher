import {addLicenses,includeLicenses} from '../../../../scripts/license-files.mjs';
// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isolateCompiler} from './compiler-isolation.mjs';
import {buildSceneLibrary} from './libplacebo/scene-source.mjs';
import {buildDependencies,profile} from './libplacebo/dependencies-build.mjs';
const directory=path.dirname(fileURLToPath(import.meta.url)),repository=path.resolve(directory,'../../../..');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run=(program,args)=>execFileSync(program,args,{stdio:'pipe',encoding:'utf8'});
export const MOLTENVK=Object.freeze({version:'1.4.2',sha256:'aef00b13bcc808adf15b85bef9ae67393d92be7ed5dfe41cad16fa809e4a4c5f',source:'https://github.com/KhronosGroup/MoltenVK/releases/tag/v1.4.2',archive:Object.freeze({url:'https://github.com/KhronosGroup/MoltenVK/releases/download/v1.4.2/MoltenVK-macos.tar',sha256:'f95765a6229cb7b915990a2890ce12ebe36a730b021545d3d52ae69ce4c4024e'})});
function inventory(output){const files=[];function visit(relative=''){for(const row of fs.readdirSync(path.join(output,relative),{withFileTypes:true})){const file=relative?relative+'/'+row.name:row.name;if(row.isDirectory())visit(file);else if(file!=='provider.json')files.push({path:file,size:fs.statSync(path.join(output,file)).size,sha256:hash(path.join(output,file))});}}visit();return files.sort((a,b)=>a.path.localeCompare(b.path));}
export function build({moltenvk,headers,output,sceneLibrary,dependencies,architecture}){
 if(fs.existsSync(output))throw Error('Choose a new libplacebo output directory.');
 if(sceneLibrary.architecture!==architecture||hash(sceneLibrary.library)!==sceneLibrary.sha256)throw Error('The source-built libplacebo library changed.');
 const lib=path.join(output,'libplacebo');fs.mkdirSync(lib,{recursive:true});
 const mvk=path.join(moltenvk,'MoltenVK/MoltenVK/dynamic/dylib/macOS/libMoltenVK.dylib');if(hash(mvk)!==MOLTENVK.sha256)throw Error('The MoltenVK binary input changed.');
 const inputs=[['libplacebo.360.dylib',sceneLibrary.library],['libshaderc_shared.1.dylib',path.join(dependencies.inputs,'shaderc/shaderc/'+profile.shadercVersion+'/lib/libshaderc_shared.1.dylib')],['liblcms2.2.dylib',path.join(dependencies.inputs,'little-cms2/little-cms2/'+profile.lcmsVersion+'/lib/liblcms2.2.dylib')],['libMoltenVK.dylib',mvk]];
 for(const [name,source]of inputs){const file=path.join(lib,name);fs.copyFileSync(source,file);fs.chmodSync(file,0o755);run('install_name_tool',['-id','@rpath/'+(name==='libplacebo.360.dylib'?'libplacebo/':'')+name,file]);
  for(const line of run('otool',['-arch',architecture,'-L',file]).split('\n').slice(2)){const dependency=line.trim().split(' (')[0];if(!dependency||dependency.startsWith('/System/')||dependency.startsWith('/usr/lib/'))continue;let next=path.basename(dependency);if(next.startsWith('liblcms2.'))next='liblcms2.2.dylib';if(next.startsWith('libvulkan.'))next='libMoltenVK.dylib';if(dependency!=='@loader_path/'+next)run('install_name_tool',['-change',dependency,'@loader_path/'+next,file]);}
  if(name==='libshaderc_shared.1.dylib')isolateCompiler(file,[['pirv_cross','pplc_cross'],['spvtools','spvplctl'],['glslang','mclplcg'],['3spv','3plv']]);run('codesign',['--force','-s','-',file]);}
 const {library:_library,include:_include,...provenance}=sceneLibrary;fs.writeFileSync(path.join(output,architecture==='arm64'?'scene-source.json':'scene-source.x86_64.json'),JSON.stringify(provenance,null,2)+'\n');
 addLicenses(output,'MoltenVK',moltenvk);
 includeLicenses(output,`${sceneLibrary.include}/../licenses`);
 addLicenses(output,'compiler-dependencies',dependencies.inputs);
 const native=path.join(directory,'native'),common=['clang++','-std=c++17','-O2','-fobjc-arc','-Wno-deprecated-declarations','-Werror=unguarded-availability-new','-DVK_USE_PLATFORM_METAL_EXT','-DMACFX_LIBPLACEBO_SCENE_INPUTS=1','-arch',architecture,'-mmacosx-version-min='+profile.minimumMacOS,'-ffile-prefix-map='+repository+'=.','-ffile-prefix-map='+headers+'=upstream','-I'+native,'-I'+headers,'-I'+sceneLibrary.include,'-I'+path.join(moltenvk,'MoltenVK/MoltenVK/include')];
 const provider=path.join(output,'libmacfx-libplacebo.dylib');run('xcrun',[...common,'-dynamiclib',path.join(native,'libplacebo-node.mm'),'-L'+lib,'-lplacebo.360','-lMoltenVK','-Wl,-rpath,@loader_path/libplacebo','-Wl,-rpath,@loader_path','-Wl,-install_name,@rpath/libmacfx-libplacebo.dylib','-framework','Foundation','-framework','Metal','-o',provider]);
 const helper=path.join(output,'libplacebo-prepare');run('xcrun',[...common,path.join(native,'libplacebo-prepare.mm'),'-L'+output,'-lmacfx-libplacebo','-Wl,-rpath,@executable_path','-framework','Foundation','-framework','Metal','-o',helper]);for(const file of[provider,helper]){run('strip',['-x',file]);run('codesign',['--force','-s','-',file]);}
 const catalog=JSON.parse(run(helper,['--filters']));
 const metadata={schema:1,provider:'libplacebo',version:'7.360.1',derivedPlanes:true,imageFiltersAPI:catalog.imageFiltersAPI,imageFilters:catalog.imageFilters,sceneInputsAPI:catalog.sceneInputsAPI||0,sceneInputRoles:catalog.sceneInputRoles||[],architectures:[architecture],minimumMacOS:profile.minimumMacOS,library:'libmacfx-libplacebo.dylib',helper:'libplacebo-prepare',filters:catalog.filters,files:inventory(output),inputs:[{name:'libplacebo',...sceneLibrary.source,architecture,sha256:sceneLibrary.sha256,overlaySha256:sceneLibrary.overlaySha256,recipeSha256:sceneLibrary.recipeSha256,headerInputs:sceneLibrary.headerInputs,source:sceneLibrary.source.origin,dependencies:[sceneLibrary.vulkanHeaders,...(sceneLibrary.fastFloat?[sceneLibrary.fastFloat]:[])]},...dependencies.source.map(row=>({...row,name:row.id,architecture})),{name:'MoltenVK',...MOLTENVK}]};fs.writeFileSync(path.join(output,'provider.json'),JSON.stringify(metadata,null,2)+'\n');return metadata;
}
export async function buildSceneArchitecture(options){
 const {work,output,arch,meson,ninja,python}=options,architecture=arch==='x64'?'x86_64':'arm64';if(!work||fs.existsSync(work))throw Error('Choose an unused source build workspace.');fs.mkdirSync(work,{recursive:true});
 const dependencies=await buildDependencies({work:path.join(work,'dependencies'),architecture,meson,ninja,python});
 const library=buildSceneLibrary({...options,inputs:dependencies.inputs,dependencyHeaders:dependencies.inputs,architecture,output:path.join(work,architecture),python});
 return build({...options,output,sceneLibrary:library,dependencies,architecture});
}
export async function buildSceneUniversal(options){
 const {work,output}=options;if(fs.existsSync(work)||fs.existsSync(output))throw Error('Choose new Universal source/output directories.');fs.mkdirSync(work,{recursive:true});
 const stages=[];for(const arch of['arm64','x64']){const stage=path.join(work,arch+'-provider');const metadata=await buildSceneArchitecture({...options,arch,work:path.join(work,arch+'-work'),output:stage});stages.push({stage,metadata});}
 return combineStages({stages,output});
}
export function combineStages({stages,output}){
 if(fs.existsSync(output)||stages.length!==2||stages[0].metadata.architectures.join()!=='arm64'||stages[1].metadata.architectures.join()!=='x86_64')throw Error('Choose complete ARM and Intel provider stages and a new output directory.');
 fs.mkdirSync(output,{recursive:true});fs.cpSync(stages[0].stage,output,{recursive:true});
 for(const row of stages[0].metadata.files){const destination=path.join(output,row.path);if((row.path.endsWith('.dylib')||row.path==='libplacebo-prepare')&&hash(path.join(stages[0].stage,row.path))!==hash(path.join(stages[1].stage,row.path))){run('lipo',['-create',...stages.map(({stage})=>path.join(stage,row.path)),'-output',destination+'.fat']);fs.renameSync(destination+'.fat',destination);run('codesign',['--force','-s','-',destination]);}}
 fs.copyFileSync(path.join(stages[1].stage,'scene-source.x86_64.json'),path.join(output,'scene-source.x86_64.json'));
 const metadata={...stages[0].metadata,architectures:['arm64','x86_64'],inputs:stages.flatMap(({metadata})=>metadata.inputs),files:inventory(output)};fs.writeFileSync(path.join(output,'provider.json'),JSON.stringify(metadata,null,2)+'\n');return metadata;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options={};for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i].replace(/^--/,'').replace(/-([a-z])/g,(_m,c)=>c.toUpperCase());if(!['moltenvk','headers','output','source','vulkanSource','work','meson','ninja','python','arch'].includes(name)||!process.argv[i+1])throw Error('Expected explicit build input paths.');options[name]=name==='arch'?process.argv[i+1]:path.resolve(process.argv[i+1]);}
 for(const name of['source','vulkanSource','moltenvk','headers','output','work','meson','ninja'])if(!options[name])throw Error('Missing '+name);
 (options.arch&&options.arch!=='universal'?buildSceneArchitecture(options):buildSceneUniversal(options)).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
}
