// Copyright (c) MacLauncher contributors. MIT license.
import fs from "node:fs";
import {isolateCompiler} from "./compiler-isolation.mjs";
const isolateShaderCompiler=file=>isolateCompiler(file,[["pirv_cross","pplc_cross"],["spvtools","spvplctl"],["glslang","mclplcg"],["3spv","3plv"]]);
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {buildSceneLibrary} from "./libplacebo/scene-source.mjs";
const directory=path.dirname(fileURLToPath(import.meta.url)), repository=path.resolve(directory,"../../../..");
const hash=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run=(program,args)=>execFileSync(program,args,{stdio:"pipe",encoding:"utf8"});
function sceneNotice(library,destination){
  const {library:_library,include:_include,notices=[],...provenance}=library;
  fs.writeFileSync(destination,JSON.stringify(provenance,null,2)+"\n");
  for(const notice of notices){if(hash(notice.file)!==notice.sha256||path.basename(notice.name)!==notice.name)throw new Error("The source library notice changed.");fs.copyFileSync(notice.file,path.join(path.dirname(destination),notice.name));}
}
// Homebrew bottle and MoltenVK release identities of the binary inputs.
const bottle=(formula,sha256)=>"https://ghcr.io/v2/homebrew/core/"+formula+"/blobs/sha256:"+sha256;
export const MOLTENVK=Object.freeze({version:"1.4.2",sha256:"aef00b13bcc808adf15b85bef9ae67393d92be7ed5dfe41cad16fa809e4a4c5f",license:"Apache-2.0",source:"https://github.com/KhronosGroup/MoltenVK/releases/tag/v1.4.2",
  archive:Object.freeze({url:"https://github.com/KhronosGroup/MoltenVK/releases/download/v1.4.2/MoltenVK-macos.tar",sha256:"f95765a6229cb7b915990a2890ce12ebe36a730b021545d3d52ae69ce4c4024e"})});
export const INPUTS=Object.freeze([
  {name:"libplacebo.360.dylib",formula:"libplacebo",file:"libplacebo/libplacebo/7.360.1/lib/libplacebo.360.dylib",sha256:"e92e4ec234f59d449f7458c60699e252f26fe804b7b3663bee8cbe340fa666d3",version:"7.360.1",archiveSha256:"8b89e9ee2c276bded52d69bbfc3b645625c975e9edc3ba93873c18d661ef241c",license:"LGPL-2.1-or-later",source:"https://code.videolan.org/videolan/libplacebo/-/archive/v7.360.1/libplacebo-v7.360.1.tar.bz2",notice:"libplacebo/libplacebo/7.360.1/LICENSE"},
  {name:"libshaderc_shared.1.dylib",formula:"shaderc",file:"shaderc/shaderc/2026.4/lib/libshaderc_shared.1.dylib",sha256:"77d64f5c9ef95f78e3f3214c310792b63c1337cc5a381faa980e61816c1ffbf7",version:"2026.4",archiveSha256:"1313ffbae9ac1559f7160cc89657ecd5fc324895ff46e15a4bd198ec3bbebec0",license:"Apache-2.0",source:"https://github.com/google/shaderc/archive/refs/tags/v2026.4.tar.gz",notice:"shaderc/shaderc/2026.4/LICENSE"},
  {name:"liblcms2.2.dylib",formula:"little-cms2",file:"little-cms2/little-cms2/2.19.1/lib/liblcms2.2.dylib",sha256:"f4c2fe0d303e63e65e627271e0bceada3ca664486f9bb9f07077083dd0ff2540",version:"2.19.1",archiveSha256:"823125475a9f5bfd1f2ddda2910143aa47c018c4cd6c55867b7461553d1719e1",license:"MIT",source:"https://downloads.sourceforge.net/project/lcms/lcms/2.19.1/lcms2-2.19.1.tar.gz",notice:"little-cms2/little-cms2/2.19.1/LICENSE"},
]);
export function build({inputs,moltenvk,headers,output,sceneLibrary}){
  for(const item of INPUTS)if(hash(path.join(inputs,item.file))!==item.sha256)throw new Error("A libplacebo binary input changed: "+item.name);
  const mvk=path.join(moltenvk,"MoltenVK/MoltenVK/dynamic/dylib/macOS/libMoltenVK.dylib");
  if(hash(mvk)!==MOLTENVK.sha256)throw new Error("The MoltenVK binary input changed.");
  if(fs.existsSync(output))throw new Error("The output already exists; choose a new build directory.");
  const lib=path.join(output,"libplacebo"),notices=path.join(output,"notices/libplacebo");fs.mkdirSync(lib,{recursive:true});fs.mkdirSync(notices,{recursive:true});
  for(const item of INPUTS){fs.copyFileSync(path.join(inputs,item.file),path.join(lib,item.name));fs.copyFileSync(path.join(inputs,item.notice),path.join(notices,item.name+".LICENSE"));}
  if(sceneLibrary){if(sceneLibrary.architecture!=="arm64"||hash(sceneLibrary.library)!==sceneLibrary.sha256)throw new Error("The source-built libplacebo library changed.");fs.chmodSync(path.join(lib,"libplacebo.360.dylib"),0o755);fs.copyFileSync(sceneLibrary.library,path.join(lib,"libplacebo.360.dylib"));sceneNotice(sceneLibrary,path.join(notices,"scene-source.json"));}
  fs.copyFileSync(mvk,path.join(lib,"libMoltenVK.dylib"));fs.copyFileSync(path.join(moltenvk,"MoltenVK/LICENSE"),path.join(notices,"MoltenVK.LICENSE"));
  for(const name of [...INPUTS.map(item=>item.name),"libMoltenVK.dylib"]){const file=path.join(lib,name);fs.chmodSync(file,0o755);run("install_name_tool",["-id","@rpath/"+(sceneLibrary&&name==="libplacebo.360.dylib"?"libplacebo/":"")+name,file]);
    for(const line of run("otool",["-L",file]).split("\n").slice(2)){const dependency=line.trim().split(" (")[0];if(!dependency.startsWith("@@HOMEBREW_PREFIX@@"))continue;let next=path.basename(dependency);if(next.startsWith("libvulkan."))next="libMoltenVK.dylib";run("install_name_tool",["-change",dependency,"@loader_path/"+next,file]);}
    if(name==="libshaderc_shared.1.dylib")isolateShaderCompiler(file);
    run("codesign",["--force","-s","-",file]);
  }
  const native=path.join(directory,"native"),include=sceneLibrary?.include||path.join(inputs,"libplacebo/libplacebo/7.360.1/include"),vulkan=path.join(moltenvk,"MoltenVK/MoltenVK/include");
  const common=["clang++","-std=c++17","-O2","-fobjc-arc","-Wno-deprecated-declarations","-DVK_USE_PLATFORM_METAL_EXT","-arch","arm64","-mmacosx-version-min=15.0","-ffile-prefix-map="+repository+"=.","-ffile-prefix-map="+headers+"=upstream", "-I"+native,"-I"+headers,"-I"+include,"-I"+vulkan];
  if(sceneLibrary)common.push("-DMACFX_LIBPLACEBO_SCENE_INPUTS=1");
  const provider=path.join(output,"libmacfx-libplacebo.dylib");
  run("xcrun",[...common,"-dynamiclib",path.join(native,"libplacebo-node.mm"),"-L"+lib,"-lplacebo.360","-lMoltenVK","-Wl,-rpath,@loader_path/libplacebo",...(sceneLibrary?["-Wl,-rpath,@loader_path"]:[]),"-Wl,-install_name,@rpath/libmacfx-libplacebo.dylib","-framework","Foundation","-framework","Metal","-o",provider]);
  const helper=path.join(output,"libplacebo-prepare");run("xcrun",[...common,path.join(native,"libplacebo-prepare.mm"),"-L"+output,"-lmacfx-libplacebo","-Wl,-rpath,@executable_path","-framework","Foundation","-framework","Metal","-o",helper]);
  for(const file of [provider,helper]){run("strip",["-x",file]);run("codesign",["--force","-s","-",file]);}
  const catalog=JSON.parse(run(helper,["--filters"])),filters=catalog.filters;if(!Array.isArray(filters)||catalog.imageFiltersAPI!==1||catalog.imageFilters?.join()!=="deband")throw new Error("The original libplacebo filter catalog is unavailable.");
  const entries=[];function visit(relative=""){for(const entry of fs.readdirSync(path.join(output,relative),{withFileTypes:true})){const file=relative?relative+"/"+entry.name:entry.name;if(entry.isDirectory())visit(file);else entries.push({path:file,size:fs.statSync(path.join(output,file)).size,sha256:hash(path.join(output,file))});}}visit();
  const metadata={schema:1,provider:"libplacebo",version:"7.360.1",derivedPlanes:true,imageFiltersAPI:catalog.imageFiltersAPI,imageFilters:catalog.imageFilters,sceneInputsAPI:catalog.sceneInputsAPI||0,sceneInputRoles:catalog.sceneInputRoles||[],architectures:["arm64"],minimumMacOS:"15.0",library:"libmacfx-libplacebo.dylib",helper:"libplacebo-prepare",filters,files:entries.sort((a,b)=>a.path.localeCompare(b.path)),inputs:[...INPUTS.filter(row=>!sceneLibrary||row.name!=="libplacebo.360.dylib").map(({file,notice,formula,...row})=>({...row,url:bottle(formula,row.archiveSha256)})),...(sceneLibrary?[{name:"libplacebo",...sceneLibrary.source,sha256:sceneLibrary.sha256,overlaySha256:sceneLibrary.overlaySha256,recipeSha256:sceneLibrary.recipeSha256,headerInputs:sceneLibrary.headerInputs,source:sceneLibrary.source.origin,dependencies:[sceneLibrary.vulkanHeaders,...(sceneLibrary.fastFloat?[sceneLibrary.fastFloat]:[])]}]:[]),{name:"MoltenVK",version:MOLTENVK.version,sha256:MOLTENVK.sha256,license:MOLTENVK.license,source:MOLTENVK.source}]};
  fs.writeFileSync(path.join(output,"provider.json"),JSON.stringify(metadata,null,2)+"\n");return metadata;
}
export const INTEL_INPUTS=Object.freeze([
  {name:"libplacebo.360.dylib",formula:"libplacebo",file:"libplacebo/libplacebo/7.360.1/lib/libplacebo.360.dylib",sha256:"45f1ae15ab2f70125908132deea3ccdb355dff5e1fa975e29c29025bb12be9ff",version:"7.360.1",archiveSha256:"a6a5f1fefe34a81d3fde35cdab8481899afc47b90efff12b912b0b1675f90861",source:"https://code.videolan.org/videolan/libplacebo/-/archive/v7.360.1/libplacebo-v7.360.1.tar.bz2",license:"LGPL-2.1-or-later"},
  {name:"libshaderc_shared.1.dylib",formula:"shaderc",file:"shaderc/shaderc/2026.3/lib/libshaderc_shared.1.dylib",sha256:"208459d3bec3e1a9461011c42e817b4d966b668a77f10c41a2f584a7f5354d92",version:"2026.3",archiveSha256:"56086be512d92867582d5a72558cc524cab54f6c32a95df6606caedd007d79b0",source:"https://github.com/google/shaderc/archive/refs/tags/v2026.3.tar.gz",license:"Apache-2.0",formulaCommit:"810444a765ade9a9abd195ef39bce1453523e509"},
  {name:"liblcms2.2.dylib",formula:"little-cms2",file:"little-cms2/little-cms2/2.19.1/lib/liblcms2.2.dylib",sha256:"1f95583cf9dd7d064d9c2d89beaeb088323746f0a72f0af0468b7edc558edc47",version:"2.19.1",archiveSha256:"b6a008c02dff9c51ddee68a8a4cbf2b031f9ab2e6c8554d92ffbbf982a31f1ed",source:"https://downloads.sourceforge.net/project/lcms/lcms/2.19.1/lcms2-2.19.1.tar.gz",license:"MIT",formulaCommit:"d862babb72a86f5d526428841c4960dc18e5321d"},
]);
// Add verified stock Intel slices to an already sealed arm64 product. The
// working arm64 stage is read-only; this never rebuilds or replaces it.
export function buildUniversal({armStage,intelInputs,inputs,moltenvk,headers,output,sceneLibrary}){
  const arm=JSON.parse(fs.readFileSync(path.join(armStage,"provider.json"),"utf8"));
  if(arm.schema!==1||arm.provider!=="libplacebo"||arm.architectures?.join()!=="arm64"||!Array.isArray(arm.files))throw new Error("Choose the sealed arm64 libplacebo stage.");
  if(Boolean(sceneLibrary)!==Boolean(arm.sceneInputsAPI))throw new Error("Both architectures must expose the same libplacebo scene-input API.");
  if(sceneLibrary&&(sceneLibrary.architecture!=="x86_64"||hash(sceneLibrary.library)!==sceneLibrary.sha256))throw new Error("The Intel source-built libplacebo library changed.");
  if(fs.existsSync(output))throw new Error("The output already exists; choose a new build directory.");
  for(const item of INTEL_INPUTS)if(hash(path.join(intelInputs,item.file))!==item.sha256)throw new Error("An Intel libplacebo input changed: "+item.name);
  const files=arm.files.map(row=>{if(typeof row.path!=="string"||path.isAbsolute(row.path)||row.path.split("/").some(part=>!part||part===".."))throw new Error("The arm64 inventory path is invalid.");const file=path.join(armStage,row.path);if(!fs.lstatSync(file).isFile()||fs.statSync(file).size!==row.size||hash(file)!==row.sha256)throw new Error("The sealed arm64 stage changed.");return row.path;});
  fs.mkdirSync(output,{recursive:true});for(const file of files){fs.mkdirSync(path.dirname(path.join(output,file)),{recursive:true});fs.copyFileSync(path.join(armStage,file),path.join(output,file));}
  const temporary=path.join(output,".intel-build"),lib=path.join(temporary,"libplacebo");fs.mkdirSync(lib,{recursive:true});
  try{
    for(const row of INTEL_INPUTS){const file=path.join(lib,row.name);fs.copyFileSync(sceneLibrary&&row.name==="libplacebo.360.dylib"?sceneLibrary.library:path.join(intelInputs,row.file),file);fs.chmodSync(file,0o755);run("install_name_tool",["-id","@rpath/"+(sceneLibrary&&row.name==="libplacebo.360.dylib"?"libplacebo/":"")+row.name,file]);
      for(const line of run("otool",["-L",file]).split("\n").slice(2)){const dependency=line.trim().split(" (")[0];if(!dependency.startsWith("@@HOMEBREW_PREFIX@@"))continue;const name=path.basename(dependency);run("install_name_tool",["-change",dependency,"@loader_path/"+(name.startsWith("libvulkan.")?"libMoltenVK.dylib":name),file]);}
      if(row.name==="libshaderc_shared.1.dylib")isolateShaderCompiler(file);
      run("codesign",["--force","-s","-",file]);
      const originalNotice=path.join(intelInputs,path.dirname(path.dirname(row.file)),"LICENSE"),includedNotice=path.join(output,"notices/libplacebo",row.name+".LICENSE");
      if(hash(originalNotice)!==hash(includedNotice))fs.copyFileSync(originalNotice,path.join(output,"notices/libplacebo",row.name+".x86_64.LICENSE"));
    }
    if(sceneLibrary)sceneNotice(sceneLibrary,path.join(output,"notices/libplacebo/scene-source.x86_64.json"));
    fs.copyFileSync(path.join(armStage,"libplacebo/libMoltenVK.dylib"),path.join(lib,"libMoltenVK.dylib"));
    const native=path.join(directory,"native");
    // Headers are a separate build input, not delivered runtime resources.
    const placeboHeaders=sceneLibrary?.include||path.join(inputs,"libplacebo/libplacebo/7.360.1/include");
    if(!fs.existsSync(path.join(placeboHeaders,"libplacebo/vulkan.h")))throw new Error("The matching libplacebo7.360.1 headers are required.");
    const vulkanHeaders=path.join(moltenvk,"MoltenVK/MoltenVK/include");
    const common=["clang++","-std=c++17","-O2","-fobjc-arc","-Wno-deprecated-declarations","-DVK_USE_PLATFORM_METAL_EXT","-arch","x86_64","-mmacosx-version-min=15.0","-ffile-prefix-map="+repository+"=.","-ffile-prefix-map="+headers+"=upstream","-I"+native,"-I"+headers,"-I"+placeboHeaders,"-I"+vulkanHeaders];
    if(sceneLibrary)common.push("-DMACFX_LIBPLACEBO_SCENE_INPUTS=1");
    const provider=path.join(temporary,"libmacfx-libplacebo.dylib");run("xcrun",[...common,"-dynamiclib",path.join(native,"libplacebo-node.mm"),"-L"+lib,"-lplacebo.360","-lMoltenVK","-Wl,-rpath,@loader_path/libplacebo",...(sceneLibrary?["-Wl,-rpath,@loader_path"]:[]),"-Wl,-install_name,@rpath/libmacfx-libplacebo.dylib","-framework","Foundation","-framework","Metal","-o",provider]);
    const helper=path.join(temporary,"libplacebo-prepare");run("xcrun",[...common,path.join(native,"libplacebo-prepare.mm"),"-L"+temporary,"-lmacfx-libplacebo","-Wl,-rpath,@executable_path","-framework","Foundation","-framework","Metal","-o",helper]);
    for(const file of [provider,helper])run("strip",["-x",file]);
    for(const relative of ["libmacfx-libplacebo.dylib","libplacebo-prepare",...INTEL_INPUTS.map(row=>"libplacebo/"+row.name)]){
      const fat=path.join(output,relative+".universal");run("lipo",["-create",path.join(armStage,relative),path.join(temporary,relative),"-output",fat]);fs.renameSync(fat,path.join(output,relative));run("codesign",["--force","-s","-",path.join(output,relative)]);
    }
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  const inventory=[];function visit(relative=""){for(const entry of fs.readdirSync(path.join(output,relative),{withFileTypes:true})){const file=relative?relative+"/"+entry.name:entry.name;if(entry.isDirectory())visit(file);else inventory.push({path:file,size:fs.statSync(path.join(output,file)).size,sha256:hash(path.join(output,file))});}}visit();
  const catalog=JSON.parse(run(path.join(output,"libplacebo-prepare"),["--filters"])),filters=catalog.filters;if(!Array.isArray(filters)||catalog.imageFiltersAPI!==1||catalog.imageFilters?.join()!=="deband")throw new Error("The original libplacebo filter catalog is unavailable.");
  const metadata={...arm,filters,imageFiltersAPI:catalog.imageFiltersAPI,imageFilters:catalog.imageFilters,sceneInputsAPI:catalog.sceneInputsAPI||0,sceneInputRoles:catalog.sceneInputRoles||[],architectures:["arm64","x86_64"],files:inventory.sort((a,b)=>a.path.localeCompare(b.path)),inputs:[...arm.inputs.map(row=>({...row,architecture:row.name==="MoltenVK"?"universal":"arm64"})),...INTEL_INPUTS.filter(row=>!sceneLibrary||row.name!=="libplacebo.360.dylib").map(({file,formula,...row})=>({...row,architecture:"x86_64",url:bottle(formula,row.archiveSha256)})),...(sceneLibrary?[{name:"libplacebo",...sceneLibrary.source,architecture:"x86_64",sha256:sceneLibrary.sha256,overlaySha256:sceneLibrary.overlaySha256,recipeSha256:sceneLibrary.recipeSha256,headerInputs:sceneLibrary.headerInputs,source:sceneLibrary.source.origin,dependencies:[sceneLibrary.vulkanHeaders,...(sceneLibrary.fastFloat?[sceneLibrary.fastFloat]:[])]}]:[])]};
  fs.writeFileSync(path.join(output,"provider.json"),JSON.stringify(metadata,null,2)+"\n");return metadata;
}

export function buildSceneUniversal(options){
  const {work,inputs,intelInputs,output}=options;if(!work||fs.existsSync(work))throw new Error("Choose an unused source build workspace.");fs.mkdirSync(work,{recursive:true});
  const armLibrary=buildSceneLibrary({...options,architecture:"arm64",output:path.join(work,"arm64")});
  const armStage=path.join(work,"provider-arm64");build({...options,output:armStage,sceneLibrary:armLibrary});
  const intelLibrary=buildSceneLibrary({...options,inputs:intelInputs,dependencyHeaders:inputs,architecture:"x86_64",output:path.join(work,"x86_64")});
  return buildUniversal({...options,inputs,intelInputs,output,armStage,sceneLibrary:intelLibrary});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const options={};for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i].replace(/^--/,"").replace(/-([a-z])/g,(_match,c)=>c.toUpperCase());if(!["inputs","moltenvk","headers","output","armStage","intelInputs","source","vulkanSource","fastFloatSource","work","meson","ninja"].includes(name)||!process.argv[i+1])throw new Error("Expected build input paths.");options[name]=path.resolve(process.argv[i+1]);}
  if(options.source){for(const name of["source","vulkanSource","inputs","intelInputs","moltenvk","headers","output","work","meson","ninja"])if(!options[name])throw new Error("Missing "+name);console.log(JSON.stringify(buildSceneUniversal(options),null,2));process.exit(0);}
  const universal=Boolean(options.armStage);for(const name of universal?["armStage","intelInputs","inputs","moltenvk","headers","output"]:["inputs","moltenvk","headers","output"])if(!options[name])throw new Error("Missing "+name);
  console.log(JSON.stringify(universal?buildUniversal(options):build(options),null,2));
}
