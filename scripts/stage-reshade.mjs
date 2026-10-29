import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import Native from "../src/modules/shared/runtime/local-native.js";
import { validateEffectSources } from "./reshade-effect-sources.mjs";
import { verifyReShadeCompiler } from "./reshade-compiler-contract.mjs";
import Content from "./runtime-content.cjs";
import Production from "../src/modules/shared/runtime/production-source.js";
import { productionOwnedFiles, copyPinnedReShadeSources } from "./stage-reshade-source.mjs";
import {stageTemporalProvider} from "./stage-temporal-provider.mjs";
import {stageNativeImageFilters} from "./stage-native-image-filters.mjs";
import {stageFSR4Provider} from "./stage-fsr4-provider.mjs";
import {generationMethodsHeader} from "./generate-graphics-contracts.mjs";
import {SCENE_SHADER_INPUTS} from "../src/modules/shared/effects/operation-contracts.mjs";
import {sceneRoleHeader} from "../src/modules/shared/reshade/native/scene-role-header.mjs";
import {stageLibplaceboScene} from "./stage-libplacebo-scene.mjs";
import {stageStreamlineSnapshots} from "./stage-streamline-snapshots.mjs";
import {pruneGraphicsRuntimes} from "./prune-graphics-runtimes.mjs";
const features = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../src/modules/shared/reshade/features.json"), "utf8"));
const effectSources = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../src/modules/shared/reshade/effect-sources.json"), "utf8"));
const declarationPath=path.resolve(import.meta.dirname,"../src/modules/shared/reshade/distribution-supplementals.json");
const priorDeclaration=fs.existsSync(declarationPath)?fs.readFileSync(declarationPath):null;

if (process.argv[2] === "--effects-only") {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/stage-reshade.mjs --effects-only");
  const { stageReShadeEffects } = await import("./stage-reshade-effects.mjs");
  console.log(JSON.stringify(stageReShadeEffects({ effectSources })));
  process.exit(0);
}
const args = process.argv.slice(2), source = args.shift();
if (!source) throw new Error("A ReShade macOS source directory is required.");
const build = path.resolve(source, args[0] && !args[0].startsWith("--") ? args.shift() : "build-physical");
const options = {};
while (args.length) {
  const key = args.shift(), value = args.shift();
  if (!["--owned-source", "--isf", "--xess-host", "--xess-host-source", "--fsr", "--fsr4", "--fsr4-source", "--asr", "--asr-source", "--sgsr2", "--sgsr2-source", "--fsr3-generation", "--godot", "--streamline", "--dxmt", "--xess", "--retroarch", "--libplacebo", "--neural"].includes(key) || !value || value.startsWith("--") || options[key])
    throw new Error("Usage: node scripts/stage-reshade.mjs <source> [build] [--owned-source <source>] [--isf <payload>] [--xess-host <payload>] [--xess-host-source <source>] [--fsr <payload>] [--fsr4 <payload>] [--fsr4-source <checkout>] [--asr <payload>] [--asr-source <checkout>] [--sgsr2 <payload>] [--sgsr2-source <checkout>] [--fsr3-generation <payload>] [--godot <payload>] [--streamline <payload>] [--dxmt <payload>] [--xess <payload>] [--retroarch <payload>] [--libplacebo <payload>] [--neural <payload>]");
  options[key] = path.resolve(value);
}
if(options["--xess-host-source"]&&!options["--xess-host"])throw Error("An owned XeSS source snapshot requires its exact GPU host payload.");
if(features.graphics.xessGenerationAPI===1&&!options["--xess-host"])throw Error("The declared XeSS frame-generation operation requires its complete original GPU host.");
// Owned adaptations may be built outside the read-only pinned checkout. Vendor
// revisions and license sources still come from that original checkout.
const ownedSource = options["--owned-source"] || source;
const resourceRoot = path.resolve(import.meta.dirname, "../src/resources/native-runtimes");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const owned = productionOwnedFiles(ownedSource);
const sourcePolicy = ["scripts/stage-reshade-source.mjs", "src/modules/shared/runtime/production-source.js", "src/modules/shared/runtime/runtime-content.js"]
  .map(file => fs.readFileSync(path.resolve(import.meta.dirname, "..", file)));
let sourceHash = digest(Buffer.concat([Buffer.from("production-source-v1\0"), ...sourcePolicy,
  ...owned.map(name => Buffer.concat([Buffer.from(name + "\0"), fs.readFileSync(path.join(ownedSource, name))]))]));
const consumed = new Set(["third_party/reshade", "third_party/reshade/deps/spirv", "third_party/spirv-cross", "third_party/reshade-shaders", "third_party/mako", "third_party/vkd3d", "third_party/fsr"]);
const registeredSources = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,
  "../src/modules/shared/reshade/native/processor-sources.json"), "utf8"));
const pins = registeredSources.sources.map(entry => {
  if (!consumed.has(entry.sourcePath)) throw new Error("The graphics source profile contains an undeclared dependency.");
  const directory = path.resolve(import.meta.dirname, "..", entry.submodulePath);
  const actual = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
  if (actual !== entry.commit) throw new Error("Initialize the selected graphics source commit: " + entry.submodulePath);
  execFileSync("git", ["-C", directory, "diff", "--exit-code", "HEAD", "--"], {stdio: "pipe"});
  return ` ${actual} ${entry.sourcePath}`;
});
if (pins.length !== consumed.size || new Set(pins.map(line => line.trim().split(/\s+/)[1])).size !== consumed.size)
  throw new Error("Consumed graphics sources must match their recorded commits.");
const nativeFiles = ["libreshade-macos.dylib", "libvkd3d-shader.dylib", "fx-compile"];
if(fs.existsSync(path.join(build,"shaderc-offline")))nativeFiles.push("shaderc-offline");
if(fs.existsSync(path.join(build,"maclauncher-graphics-video"))) nativeFiles.push("maclauncher-graphics-video");
if(features.graphics.hardwareQueryAPI===1){
  if(!fs.existsSync(path.join(build,"maclauncher-graphics-hardware")))throw Error("The declared graphics device query helper is missing.");
  nativeFiles.push("maclauncher-graphics-hardware");
}
const retroarchInputs = new Map();
const extraSources=[];
const temporalProviderNotices=[];
const restorationNotices=[
  ["Real-ESRGAN","BSD-3-Clause","Real-ESRGAN-BSD-3-CLAUSE.txt","https://github.com/xinntao/Real-ESRGAN"],
  ["SRVGG Swift","MIT","SRVGG-Swift-MIT.txt","https://github.com/xocialize/mlx-realesrgan-swift"],
  ["Real-CUGAN","MIT","REAL-CUGAN-MIT.txt","https://github.com/bilibili/ailab"],
  ["NAFNet","MIT","NAFNET-ORIGINAL-MIT.txt","https://github.com/megvii-research/NAFNet"],
  ["NAFNet Swift","MIT","NAFNET-SWIFT-MIT.txt","https://github.com/xocialize/mlx-nafnet-swift"],
  ["NAFNet notices","MIT","NAFNET-NOTICE.txt","https://github.com/xocialize/mlx-nafnet-swift"],
  ["RIFE","MIT","RIFE-MIT.txt","https://github.com/hzwer/Practical-RIFE"],
  ["RIFE ncnn","MIT","RIFE-NCNN-MIT.txt","https://github.com/nihui/rife-ncnn-vulkan"],
  ["ncnn","BSD-3-Clause","NCNN-BSD-3-CLAUSE.txt","https://github.com/Tencent/ncnn"]
].map(([name,license,file,sourceUrl])=>({name,license,path:"neural/notices/"+file,sourceUrl}));
const depthNotices=[
  {name:"Depth Anything V2 Small",license:"Apache-2.0",path:"neural/notices/DEPTH-ANYTHING-APACHE-2.0.txt",sourceUrl:"https://github.com/DepthAnything/Depth-Anything-V2"},
  {name:"Depth Anything V2 adaptation",license:"Apache-2.0",path:"neural/notices/DEPTH-ANYTHING-NOTICE.txt",sourceUrl:"https://github.com/DepthAnything/Depth-Anything-V2"}
];
const optionalInputs=new Map(),optionalLoad=new Map(),extraOwned=new Map();
if(options["--xess-host"]){
  const directory=options["--xess-host"],ownedRoot=path.resolve(import.meta.dirname,"../src/modules/shared/reshade/xess"),source=JSON.parse(fs.readFileSync(path.join(ownedRoot,"source.json"))),metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json")));
  const generation=metadata.generation;
  const owned=["host.cpp","host-vulkan.cpp",...(generation?["host-fg.cpp","offscreen-swapchain.hpp","xess-fg-protocol.h"]:[]),"bridge.c","bridge.mm","xess-protocol.h","xess-wire.hpp","build.mjs","vulkan-source.json","KHRONOS-APACHE-2.0.txt"],required=new Set(["INTEL-LICENSE.txt","INTEL-THIRD-PARTY.txt","LICENSE.txt","source/source.json",...owned.map(name=>"source/"+name),"x86_64-windows/maclauncher-xess-host.exe","x86_64-windows/maclauncher-xess-gpu.dll","x86_64-unix/maclauncher-xess-gpu.so"]);
  const backends=metadata.backends,hostPaths=metadata.hostPaths;
  if(metadata.schema!==1||metadata.providerABI!==1||metadata.backend!=="d3d12"||metadata.architecture!=="x86_64"||metadata.sdk?.repository!==source.repository||metadata.sdk?.commit!==source.commit||metadata.sdk?.sha256!==source.sha256||metadata.sdk?.bytes!==source.bytes||metadata.hostPath!=="x86_64-windows/maclauncher-xess-host.exe"||!Array.isArray(backends)||backends[0]!=="d3d12"||backends.length>2||backends.some((name,index)=>index&&name!=="vulkan")||hostPaths?.d3d12!==metadata.hostPath||Object.keys(hostPaths||{}).sort().join()!==[...backends].sort().join()||metadata.bridge?.name!=="maclauncher-xess-gpu"||metadata.bridge?.windows!=="x86_64-windows/maclauncher-xess-gpu.dll"||metadata.bridge?.unix!=="x86_64-unix/maclauncher-xess-gpu.so"||!Array.isArray(metadata.files)||!Array.isArray(metadata.source?.ownedFiles)||metadata.source.ownedFiles.length!==owned.length)throw Error("A complete compatible original XeSS GPU host is required.");
  const nativeSource=options["--xess-host-source"]||path.join(ownedRoot,"native");
  for(const name of owned){const row=metadata.source.ownedFiles.find(row=>row.path===name),file=path.join(nativeSource,name);if(!row||digest(fs.readFileSync(file))!==row.sha256)throw Error("The XeSS GPU host source changed: "+name);extraOwned.set("maclauncher/xess/native/"+name,file);}
  extraOwned.set("maclauncher/xess/source.json",path.join(ownedRoot,"source.json"));
  if(generation){
    const componentFile=path.join(ownedRoot,"components.json"),components=JSON.parse(fs.readFileSync(componentFile,"utf8"));
    if(generation.providerABI!==1||generation.hostPath!=="x86_64-windows/maclauncher-xess-fg-host.exe"||generation.backend!=="d3d12"||generation.operation!=="interpolate"||generation.maxInterpolatedFrames!==1||
        JSON.stringify(generation.requires)!==JSON.stringify(["color","depth","motion","viewMatrix","projectionMatrix"])||JSON.stringify(generation.formats)!==JSON.stringify(["rgba8-srgb","rgb10a2-pq-bt2020"])||
        components.commit!==source.commit||generation.componentsSha256!==digest(fs.readFileSync(componentFile))||digest(fs.readFileSync(path.join(directory,"source/components.json")))!==generation.componentsSha256||
        components.files.some(row=>{const item=generation.sdk?.[row.id];return !item||item.path!=="bin/"+row.file||item.sha256!==row.sha256||item.bytes!==row.bytes;}))throw Error("The original XeSS frame-generation inputs differ from their declared identities.");
    required.add(generation.hostPath);required.add("source/components.json");extraOwned.set("maclauncher/xess/components.json",componentFile);
  }else if(features.graphics.xessGenerationAPI===1)throw Error("The declared XeSS frame-generation operation requires its complete original GPU host.");
  const upstream=path.resolve(import.meta.dirname,"../src/external/xess"),actual=execFileSync("git",["-C",upstream,"rev-parse","HEAD"],{encoding:"utf8"}).trim();if(actual!==source.commit)throw Error("The original XeSS SDK pin differs from the GPU host.");execFileSync("git",["-C",upstream,"diff","--exit-code","HEAD","--"],{stdio:"pipe"});pins.push(` ${actual} third_party/xess-original`);
  if(backends.includes("vulkan")){
    const headers=JSON.parse(fs.readFileSync(path.join(ownedRoot,"native/vulkan-source.json"))),headerRoot=path.resolve(import.meta.dirname,"../src/external/krkrsdl2/external/SDL");
    if(hostPaths.vulkan!=="x86_64-windows/maclauncher-xess-vulkan-host.exe"||JSON.stringify(metadata.source.vulkanHeaders)!==JSON.stringify(headers)||headers.repository!=="https://github.com/libsdl-org/SDL"||headers.license!=="Apache-2.0"||!Array.isArray(headers.headers)||headers.headers.length!==3||execFileSync("git",["-C",headerRoot,"rev-parse","HEAD"],{encoding:"utf8"}).trim()!==headers.commit||execFileSync("git",["-C",headerRoot,"remote","get-url","origin"],{encoding:"utf8"}).trim().replace(/\.git$/,"")!==headers.repository)throw Error("The XeSS Vulkan header source differs from its declared pin.");
    execFileSync("git",["-C",headerRoot,"diff","--exit-code","HEAD","--"],{stdio:"pipe"});
    required.add(hostPaths.vulkan);required.add("KHRONOS-APACHE-2.0.txt");
    for(const row of headers.headers){
      if(!["vulkan.h","vulkan_core.h","vk_platform.h"].includes(row.path)||!/^\w{64}$/.test(row.sha256))throw Error("Invalid XeSS Vulkan header identity.");
      const file=path.join(headerRoot,headers.headerDirectory,row.path),snapshot=path.join(directory,"source/vulkan",row.path);
      if(digest(fs.readFileSync(file))!==row.sha256||digest(fs.readFileSync(snapshot))!==row.sha256)throw Error("The XeSS Vulkan header changed: "+row.path);
      required.add("source/vulkan/"+row.path);extraOwned.set("maclauncher/xess/native/vulkan/"+row.path,file);
    }
    pins.push(` ${headers.commit} third_party/xess-vulkan-headers`);
  }else if(metadata.source.vulkanHeaders)throw Error("The XeSS Vulkan source is declared without its GPU host.");
  for(const row of metadata.files){if(typeof row.path!=="string"||!required.delete(row.path))throw Error("The XeSS GPU host contains an undeclared resource.");const file=path.join(directory,row.path),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==row.size||digest(fs.readFileSync(file))!==row.sha256)throw Error("The XeSS GPU host resource changed: "+row.path);if(!row.path.startsWith("source/"))optionalInputs.set("xess/"+row.path,file);if(row.path.endsWith(".so"))optionalLoad.set("xess/"+row.path,{architectures:["x86_64"],minimumMacOS:metadata.minimumMacOS});}
  if(required.size||digest(fs.readFileSync(path.join(directory,"source/source.json")))!==digest(fs.readFileSync(path.join(ownedRoot,"source.json"))))throw Error("The XeSS GPU host source closure is incomplete.");
  optionalInputs.set("xess/provider.json",path.join(directory,"provider.json"));optionalInputs.set("xess/INTEL-HEADERS-MIT.txt",path.join(upstream,"inc/MIT.txt"));features.graphics.xessSceneAPI=1;
}
if(options["--isf"]){
  const directory=options["--isf"],ownedRoot=path.resolve(import.meta.dirname,"../src/modules/shared/reshade/isf"),source=JSON.parse(fs.readFileSync(path.join(ownedRoot,"source.json"))),metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json")));
  if(metadata.schema!==source.schema||metadata.providerABI!==source.providerABI||metadata.library!==source.library||metadata.minimumMacOS!==source.minimumMacOS||JSON.stringify(metadata.architectures)!==JSON.stringify(source.architectures)||JSON.stringify(metadata.sources)!==JSON.stringify(source.sources)||JSON.stringify(metadata.compilerLibraries)!==JSON.stringify(source.compilerLibraries)||!Array.isArray(metadata.files))throw Error("A compatible complete ISF shader provider is required.");
  const ownedNames=["source.json","build.mjs","isolate-compiler.mjs","../compiler-isolation.mjs","CMakeLists.txt","provider.mm","index.js",
    ...(metadata.sceneInputsAPI===1?["../../effects/operation-contracts.mjs"]:[])];
  if(!metadata.owned||Object.keys(metadata.owned).sort().join()!==ownedNames.sort().join())throw Error("The ISF owned source closure is incomplete.");
  for(const name of ownedNames)if(digest(fs.readFileSync(path.join(ownedRoot,name)))!==metadata.owned[name])throw Error("The ISF owned source changed: "+name);
  if(!metadata.headerInputs||Object.keys(metadata.headerInputs).length<1||Object.keys(metadata.headerInputs).length>128)throw Error("The ISF native header closure is missing.");
  for(const [relative,sha256]of Object.entries(metadata.headerInputs)){
    if(!/^[a-zA-Z0-9_.\/-]+\.(?:h|hpp)$/.test(relative)||relative.split("/").some(part=>!part||part==="."||part===".."))throw Error("The ISF native header path is invalid.");
    if(digest(fs.readFileSync(path.resolve(ownedRoot,"../native",relative)))!==sha256)throw Error("The ISF native header changed: "+relative);
  }
  for(const entry of source.sources){
    const upstream=path.resolve(import.meta.dirname,"..",entry.path),actual=execFileSync("git",["-C",upstream,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
    if(actual!==entry.commit)throw Error("The ISF source pin differs from its provider: "+entry.path);
    execFileSync("git",["-C",upstream,"diff","--exit-code","HEAD","--"],{stdio:"pipe"});pins.push(` ${actual} third_party/isf/${path.basename(entry.path)}`);
  }
  const required=new Set([source.library,...source.compilerLibraries.map(file=>path.basename(file)),"default.metallib","ISF-LICENSE.txt","VVMetalKit-LICENSE.txt","ISFGLSLGenerator-LICENSE.txt","PINCache-LICENSE.txt","PINOperation-LICENSE.txt"]);
  for(const row of metadata.files){
    if(typeof row.path!=="string"||!required.delete(row.path))throw Error("The ISF provider contains an undeclared or duplicate resource.");
    const file=path.join(directory,row.path),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==row.size||digest(fs.readFileSync(file))!==row.sha256)throw Error("The ISF provider resource changed: "+row.path);
    optionalInputs.set("isf/"+row.path,file);if(row.path.endsWith(".dylib"))optionalLoad.set("isf/"+row.path,{architectures:source.architectures,minimumMacOS:source.minimumMacOS});
  }
  if(required.size||fs.readdirSync(directory).length!==metadata.files.length+1)throw Error("The ISF provider dependency and license closure is incomplete.");
  optionalInputs.set("isf/provider.json",path.join(directory,"provider.json"));
  for(const name of ownedNames)extraOwned.set(path.posix.normalize("maclauncher/isf/"+name),path.join(ownedRoot,name));
  features.shaders.formats=[...new Set([...(features.shaders.formats||[]),"isf"])];features.shaders.providers??={};features.shaders.providers.isf={nodeABI:1,architectures:source.architectures,minimumMacOS:source.minimumMacOS};
  if(metadata.sceneInputsAPI!==undefined){
    const roles=SCENE_SHADER_INPUTS.filter(name=>!["viewMatrix","projectionMatrix"].includes(name));
    if(metadata.sceneInputsAPI!==1||JSON.stringify(metadata.sceneInputRoles)!==JSON.stringify(roles))throw Error("The ISF scene input contract differs from its supported image roles.");
    const exports=execFileSync("/usr/bin/nm",["-gU",path.join(directory,source.library)],{encoding:"utf8"});
    for(const name of ["rsISFSceneInputsAPI","rsISFBindSceneInputs"])if(!new RegExp("\\b_"+name+"\\b").test(exports))throw Error("The ISF named input API is missing: "+name);
    Object.assign(features.shaders.providers.isf,{sceneInputsAPI:1,sceneInputRoles:[...roles]});
  }
}
if (options["--neural"]) {
  const directory = options["--neural"], source = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../src/modules/shared/reshade/neural/source.json"), "utf8"));
  const descriptor = JSON.parse(fs.readFileSync(path.join(directory, "provider.json"), "utf8"));
  if (descriptor.providerABI !== source.providerABI || descriptor.commit !== source.commit || descriptor.library !== source.library ||
      descriptor.minimumMacOS !== source.minimumMacOS || descriptor.architectures?.join() !== "arm64" || !Array.isArray(descriptor.files)) throw new Error("A compatible neural rendering provider is required.");
  const required = new Set([source.library, "mlx.metallib", "maclauncher-neural-video"]);
  if(descriptor.supportedABIs?.includes(2))required.add("maclauncher-neural-service");
  if(descriptor.restorationAPI===1)for(const notice of restorationNotices)required.add(notice.path.slice("neural/".length));
  if(descriptor.estimatedDepthAPI!==undefined&&descriptor.estimatedDepthAPI!==1)throw Error("The neural relative-depth interface is unsupported.");
  if(descriptor.estimatedDepthAPI===1){
    if(!descriptor.operations?.includes("depth-anything-v2-small")||!descriptor.supportedABIs?.includes(2)||descriptor.service?.protocol!==3||descriptor.service?.executable!=="maclauncher-neural-service")throw Error("The scalar neural provider requires its matching GPU service and operation contract.");
    const depth=JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,"../src/modules/shared/reshade/neural/native/depth-anything-source.json"),"utf8"));
    if(depth.schema!==1||depth.operation!=="depth-anything-v2-small"||depth.architecture!=="depth-anything-v2.vits.relative.v1"||depth.output?.format!=="R32Float"||depth.output?.representation!=="relative-inverse-depth"||depth.output?.provenance!=="image-estimated"||depth.output?.metric!==false||
      [depth.source,depth.checkpointLayout].some(row=>!/^https:\/\//.test(row?.repository||"")||!/^[a-f0-9]{40}$/.test(row?.commit||""))||!/^[a-f0-9]{64}$/.test(depth.model?.sha256||""))throw Error("The scalar model's exact source and output contract are undeclared.");
    const exports=execFileSync("nm",["-gU",path.join(directory,source.library)],{encoding:"utf8"});
    for(const name of ["ml_neural_depth_api","ml_neural_prepare_depth_v1"])if(!new RegExp("\\b_"+name+"\\b").test(exports))throw Error("The scalar neural provider is missing "+name+".");
    for(const notice of depthNotices)required.add(notice.path.slice("neural/".length));
    features.graphics.estimatedDepthAPI=1;
  }
  else if(descriptor.operations?.includes("depth-anything-v2-small"))throw Error("Scalar model execution requires the versioned relative-depth interface.");
  if(descriptor.gpuTimingAPI!==undefined&&descriptor.gpuTimingAPI!==1)throw Error("The neural GPU timing interface is unsupported.");
  if(descriptor.gpuTimingAPI===1){
    required.add("timing-adaptation.json");
    if(!descriptor.supportedABIs?.includes(2)||descriptor.service?.protocol!==3||descriptor.service?.executable!=="maclauncher-neural-service")throw Error("Neural GPU timing requires its matching image API and service.");
    const exports=execFileSync("nm",["-gU",path.join(directory,source.library)],{encoding:"utf8"});
    for(const name of ["ml_neural_timing_api","ml_neural_timing_supported_v1","ml_neural_submit_timed_v1","ml_neural_submit_batch_timed_v1"])
      if(!new RegExp("\\b_"+name+"\\b").test(exports))throw Error("The timed neural provider is missing "+name+".");
    const serviceExports=execFileSync("nm",["-gU",path.join(directory,"maclauncher-neural-service")],{encoding:"utf8"});
    if(!/\b_ml_neural_service_timing_api\b/.test(serviceExports))throw Error("The neural GPU timing service is missing its matching interface.");
    const {verifyTimingReceipt}=await import("../src/modules/shared/reshade/neural/native/prepare-mlx-timing.mjs");
    await verifyTimingReceipt(JSON.parse(fs.readFileSync(path.join(directory,"timing-adaptation.json"),"utf8")));
    features.graphics.neuralGpuTimingAPI=1;
  }
  for (const entry of descriptor.files) {
    if (typeof entry.path !== "string" || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new Error("Invalid neural provider path.");
    const file = path.join(directory, entry.path), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size !== entry.size || digest(fs.readFileSync(file)) !== entry.sha256) throw new Error("The neural provider changed.");
    const relative = "neural/" + entry.path;
    optionalInputs.set(relative, file); required.delete(entry.path);
    if (/\.(dylib|so)$/.test(entry.path) || ["maclauncher-neural-video","maclauncher-neural-service"].includes(entry.path)) optionalLoad.set(relative, {architectures: ["arm64"], minimumMacOS: entry.path === "maclauncher-neural-video" ? "26.0" : source.minimumMacOS});
  }
  if (required.size) throw new Error("The neural provider dependency closure is incomplete.");
  if(descriptor.restorationAPI===1&&descriptor.operations?.includes("rife"))features.graphics.videoFrameGenerationMethods=[...new Set([...(features.graphics.videoFrameGenerationMethods||[]),"rife"])];
  optionalInputs.set("neural/provider.json", path.join(directory, "provider.json"));
  const neuralRoot = path.resolve(import.meta.dirname, "../src/modules/shared/reshade/neural");
  const upstream = path.resolve(import.meta.dirname, "../src/external/MLX-DLSS");
  const revision = execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (revision !== source.commit) throw new Error("The neural source revision differs from its provider.");
  const { patchKernelParameters, patchVideoOperations,patchOpticalFlowGPU,opticalFlowFile,opticalFlowSourceHash,patchSceneSR,sceneSRFile,sceneSRSourceHash, kernelParametersFile, kernelParametersSourceHash } = await import("../src/modules/shared/reshade/neural/native/prepare-upstream.mjs");
  const adaptation = JSON.parse(fs.readFileSync(path.join(directory, "adaptation.json"), "utf8"));
  const appliedSha256 = digest(patchKernelParameters(fs.readFileSync(path.join(upstream, kernelParametersFile), "utf8")));
  const videoFile="Sources/DLSSMLX/MLXVideoFrame.swift",videoSource=fs.readFileSync(path.join(upstream,videoFile),"utf8");
  const expected=[{id:"kernel-parameters-cache-lock-v2",file:kernelParametersFile,sourceSha256:kernelParametersSourceHash,appliedSha256}];
  if(descriptor.supportedABIs?.includes(2)){
    expected.push({id:descriptor.restorationAPI===1?"video-operations-rgb-transform-v2":"video-interpolation-phases-v1",file:videoFile,sourceSha256:digest(videoSource),appliedSha256:digest(patchVideoOperations(videoSource,{restoration:descriptor.restorationAPI===1}))});
    expected.push({id:"optical-flow-gpu-stages-v1",file:opticalFlowFile,sourceSha256:opticalFlowSourceHash,appliedSha256:digest(patchOpticalFlowGPU(fs.readFileSync(path.join(upstream,opticalFlowFile),"utf8")))});
  }
  if(descriptor.supportedABIs?.includes(3))expected.push({id:"dlss-sr-scene-guides-v1",file:sceneSRFile,sourceSha256:sceneSRSourceHash,appliedSha256:digest(patchSceneSR(fs.readFileSync(path.join(upstream,sceneSRFile),"utf8")))});
  if (adaptation.schema !== 1 || adaptation.upstreamCommit !== source.commit || adaptation.adaptations?.length !== expected.length ||
      expected.some((row,index)=>Object.entries(row).some(([key,value])=>adaptation.adaptations[index]?.[key]!==value)))
    throw new Error("The neural provider does not contain the registered source adaptation.");
  for (const relative of ["source.json", "build.mjs", "native/build.sh", "native/prepare-upstream.mjs",...(descriptor.gpuTimingAPI===1?["native/prepare-mlx-timing.mjs"]:[]), "native/Package.swift",
    "native/Package.resolved", "native/upstream.json",...(descriptor.gpuTimingAPI===1?fs.readdirSync(path.join(neuralRoot,"native/timing"),{recursive:true}).map(name=>"native/timing/"+name).filter(name=>fs.statSync(path.join(neuralRoot,name)).isFile()):[]),...(descriptor.estimatedDepthAPI===1?["native/depth-anything-source.json","native/DEPTH-ANYTHING-APACHE-2.0.txt","native/DEPTH-ANYTHING-NOTICE.txt"]:[]),...(descriptor.restorationAPI===1?["native/restoration-sources.json","native/rife-v4.6.param","native/NAFNET-NOTICE.txt","native/NAFNET-ORIGINAL-MIT.txt","native/NAFNET-SWIFT-MIT.txt","native/NCNN-BSD-3-CLAUSE.txt","native/REAL-CUGAN-MIT.txt","native/REAL-ESRGAN-BSD-3-CLAUSE.txt","native/RIFE-MIT.txt","native/RIFE-NCNN-MIT.txt","native/SRVGG-SWIFT-MIT.txt"]:[]), ...fs.readdirSync(path.join(neuralRoot, "native/Sources"), { recursive: true })
      .map(name => "native/Sources/" + name).filter(name => fs.statSync(path.join(neuralRoot, name)).isFile())]) {
    if (Content.excludedReason(relative)) throw new Error("The neural build recipe contains excluded runtime content.");
    extraOwned.set("maclauncher/neural/" + relative, path.join(neuralRoot, relative));
  }
  extraOwned.set("maclauncher/neural/adaptation.json", path.join(directory, "adaptation.json"));
  if(descriptor.gpuTimingAPI===1)extraOwned.set("maclauncher/neural/timing-adaptation.json",path.join(directory,"timing-adaptation.json"));
  extraSources.push({ directory: upstream, relative: "third_party/MLX-DLSS", commit: revision,
    scope: ["Package.swift", "Package.resolved", "Sources/DLSSCore", "Sources/DLSSMLX", "Sources/DLSSMedia", "LICENSE", "NOTICE"] });
  pins.push(` ${revision} third_party/MLX-DLSS`);
}
const processorSources=path.resolve(import.meta.dirname,"../src/modules/shared/reshade/native/processor-sources.json");
if(fs.existsSync(processorSources)) {
  const metadata=JSON.parse(fs.readFileSync(processorSources,"utf8"));
  const overlay=JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,"../src/modules/shared/reshade/native/source-overlay.json"),"utf8"));
  const observed=new Map(pins.map(line=>{const [commit,file]=line.trim().split(/\s+/);return[file,commit];}));
  if(metadata.schema!==1||metadata.baseSourceHash!==overlay.baseSourceHash||!Array.isArray(metadata.sources)||metadata.sources.length!==consumed.size||
      new Set(metadata.sources.map(item=>item.sourcePath)).size!==consumed.size||metadata.sources.some(item=>observed.get(item.sourcePath)!==item.commit))
    throw new Error("The processor source identities differ from the consumed pins.");
  extraOwned.set("maclauncher/native/processor-sources.json",processorSources);
}
let libplacebo;
if(options["--libplacebo"]) {
  const directory=options["--libplacebo"];
  const metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json"),"utf8"));
  if(metadata.schema!==1||metadata.provider!=="libplacebo"||metadata.library!=="libmacfx-libplacebo.dylib"||metadata.helper!=="libplacebo-prepare"||
      !Array.isArray(metadata.architectures)||!metadata.architectures.length||new Set(metadata.architectures).size!==metadata.architectures.length||metadata.architectures.some(arch=>!["arm64","x86_64"].includes(arch))||metadata.minimumMacOS!=="15.0"||!Array.isArray(metadata.files))throw new Error("A complete optional shader provider is required.");
  const required=new Set([metadata.library,metadata.helper,"libplacebo/liblcms2.2.dylib","libplacebo/libMoltenVK.dylib","libplacebo/libplacebo.360.dylib","libplacebo/libshaderc_shared.1.dylib"]);
  for(const entry of metadata.files) {
    if(typeof entry.path!=="string"||path.isAbsolute(entry.path)||entry.path.split(/[\\/]/).some(part=>!part||part==="."||part==="..")||optionalInputs.has(entry.path))throw new Error("Invalid optional provider path.");
    const file=path.join(directory,entry.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==entry.size||digest(fs.readFileSync(file))!==entry.sha256)throw new Error("The optional shader provider changed.");
    optionalInputs.set(entry.path,file);
    if(required.delete(entry.path))optionalLoad.set(entry.path,{architectures:metadata.architectures,minimumMacOS:metadata.minimumMacOS});
    else if(!entry.path.startsWith("notices/libplacebo/")||!entry.path.endsWith(".LICENSE")&&
      !(metadata.sceneInputsAPI===1&&["notices/libplacebo/scene-source.json","notices/libplacebo/scene-source.x86_64.json"].includes(entry.path)))throw new Error("Unexpected optional provider file.");
  }
  if(required.size)throw new Error("The optional shader provider dependency closure is incomplete.");
  const scene=stageLibplaceboScene({directory,metadata,recipeRoot:path.resolve(import.meta.dirname,"../src/modules/shared/reshade")});
  if(scene){
    features.shaders.providers??={};features.shaders.providers.libplacebo={...features.shaders.providers.libplacebo,sceneInputsAPI:1,sceneInputRoles:scene.roles};
    pins.push(...scene.pins);for(const [relative,file]of scene.owned)extraOwned.set(relative,file);
  }
  if(features.shaders.providers?.libplacebo?.imageFiltersAPI===1){
    if(metadata.imageFiltersAPI!==1||!metadata.imageFilters?.includes("deband"))throw Error("The libplacebo provider is missing its declared image-filter capability.");
    const providerExports=execFileSync("/usr/bin/nm",["-gU",path.join(directory,metadata.library)],{encoding:"utf8"});
    if(!/\b_rsLibplaceboImageFiltersABI\b/.test(providerExports))throw Error("The libplacebo library is missing native image-filter support.");
  }
  optionalInputs.set("libplacebo/provider.json",path.join(directory,"provider.json"));
  for(const [relative,file] of [
    ["maclauncher/libplacebo-build.mjs","src/modules/shared/reshade/libplacebo-build.mjs"],
    ["maclauncher/compiler-isolation.mjs","src/modules/shared/reshade/compiler-isolation.mjs"],
    ...["libplacebo-node.hpp","libplacebo-node.mm","libplacebo-prepare.mm","image-budget.hpp","test/libplacebo-node.mm"].map(name=>["maclauncher/native/"+name,"src/modules/shared/reshade/native/"+name])
  ])if(!Content.excludedReason(relative))extraOwned.set(relative,path.resolve(file));
  libplacebo=metadata;
}else if(features.shaders.formats?.includes("libplacebo"))throw new Error("The declared optional shader format requires its complete provider.");
if(options["--retroarch"]) {
  const directory=options["--retroarch"];
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,"runtime-files.json"),"utf8"));
  const required=new Set(["librashader.dylib","retroarch-prepare","notices/librashader/LICENSE.md","notices/librashader/source.json"]);
  if(!Array.isArray(manifest.files)||manifest.files.length!==required.size)throw new Error("A complete RetroArch shader payload is required.");
  for(const entry of manifest.files) {
    if(!required.delete(entry.path))throw new Error("Unexpected RetroArch shader payload file.");
    const file=path.join(directory,entry.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==entry.size||digest(fs.readFileSync(file))!==entry.sha256)
      throw new Error("The RetroArch shader payload changed.");
    retroarchInputs.set(entry.path,file);
  }
  const pin=JSON.parse(fs.readFileSync(retroarchInputs.get("notices/librashader/source.json"),"utf8"));
  const original=path.resolve(import.meta.dirname,"../src/external/librashader");
  const actual=execFileSync("git",["-C",original,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
  if(actual!==pin.commit)throw new Error("The original librashader source pin differs from its payload.");
  extraSources.push({directory:original,relative:"third_party/librashader",commit:actual});
  pins.push(` ${actual} third_party/librashader`);
  nativeFiles.push("librashader.dylib","retroarch-prepare");
  if(manifest.sceneInputsAPI!==undefined){
    if(manifest.sceneInputsAPI!==1||JSON.stringify(manifest.sceneInputRoles)!==JSON.stringify(SCENE_SHADER_INPUTS)||
        manifest.sceneInputContractSha256!==digest(fs.readFileSync(path.resolve(import.meta.dirname,"../src/modules/shared/effects/operation-contracts.mjs"))))throw Error("The Slang named input contract changed.");
    const names=["build-retroarch.mjs","retroarch-source.json","retroarch-external-overlay.mjs","retroarch-external.h","retroarch-external/external.rs","retroarch-external/capi.rs","retroarch-prepare/main.rs","retroarch-prepare/Cargo.toml","retroarch-prepare/Cargo.lock"];
    const root=path.resolve(import.meta.dirname,"../src/modules/shared/reshade/native");
    if(!manifest.ownedSource||Object.keys(manifest.ownedSource).sort().join()!==names.sort().join())throw Error("The Slang external input owned source closure is incomplete.");
    for(const name of names){const file=path.join(root,name);if(digest(fs.readFileSync(file))!==manifest.ownedSource[name])throw Error("The Slang source changed: "+name);extraOwned.set("maclauncher/native/"+name,file);}
    extraOwned.set("effects/operation-contracts.mjs",path.resolve(import.meta.dirname,"../src/modules/shared/effects/operation-contracts.mjs"));
    const exports=execFileSync("/usr/bin/nm",["-gU",retroarchInputs.get("librashader.dylib")],{encoding:"utf8"});
    for(const name of ["libra_mtl_external_inputs_api","libra_mtl_filter_chain_create_external","libra_mtl_filter_chain_set_external"])
      if(!new RegExp("\\b_"+name+"\\b").test(exports))throw Error("The Slang named input API is missing: "+name);
    if(manifest.uniformSnapshotsAPI!==undefined&&(manifest.uniformSnapshotsAPI!==1||!/\b_libra_mtl_filter_chain_uniform_snapshots\b/.test(exports)))throw Error("The Slang uniform snapshot query is missing.");
    if(manifest.uniformSnapshotCapacityAPI!==undefined){
      if(manifest.uniformSnapshotCapacityAPI!==1||manifest.uniformSnapshotsAPI!==1)throw Error("The Slang uniform snapshot capacity contract is invalid.");
      for(const name of ["libra_mtl_filter_chain_uniform_snapshot_bytes","libra_mtl_filter_chain_uniform_snapshots_available","libra_mtl_filter_chain_prepare_uniform_snapshots"])
        if(!new RegExp("\\b_"+name+"\\b").test(exports))throw Error("The Slang uniform snapshot capacity API is missing: "+name);
    }
    features.shaders.providers??={};
    for(const format of ["slangp","slang"])features.shaders.providers[format]={...features.shaders.providers[format],sceneInputsAPI:1,sceneInputRoles:[...SCENE_SHADER_INPUTS]};
  }
}else if(features.shaders.formats?.some(format=>format!=="fx"))throw new Error("The declared shader formats require the complete RetroArch shader payload.");
const temporalInputs = new Map();
if(options["--fsr4-source"]&&!options["--fsr4"])throw Error("An FSR 4 source checkout requires its provider payload.");
if(options["--fsr3-generation"]){
  const directory=options["--fsr3-generation"],ownedRoot=path.resolve(import.meta.dirname,"../src/modules/shared/reshade/generation/fsr3");
  const source=JSON.parse(fs.readFileSync(path.join(ownedRoot,"source.json"),"utf8")),metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json"),"utf8"));
  if(metadata.providerABI!==source.providerABI||metadata.complete!==true||metadata.source!==source.repository||metadata.commit!==source.commit||metadata.method!=="fsr3"||metadata.interfaces?.preparation!==1||metadata.library!=="libmaclauncher-fsr3-generation.dylib"||metadata.architectures?.join()!==source.architectures.join()||metadata.minimumMacOS!==source.minimumMacOS||metadata.shaderVariants?.opticalflow!==2||metadata.shaderVariants?.frameinterpolation!==8||metadata.shaderPasses?.opticalflow!==7||metadata.shaderPasses?.frameinterpolation!==11||["dxc","spirv-cross"].some(name=>metadata.tools?.[name]!==source.tools[name]))throw Error("A complete compatible AMD optical-flow/frame-interpolation provider is required.");
  const expected=new Set([metadata.library,"provider.json","FSR3-LICENSE.txt"]);
  for(const [effect,variants,passes]of [["opticalflow",2,7],["frameinterpolation",8,11]])for(let variant=0;variant<variants;++variant)for(let pass=0;pass<passes;++pass)for(const extension of ["metal","json"])expected.add(`${effect}/${variant}/${pass}.${extension}`);
  for(const relative of fs.readdirSync(directory,{recursive:true}).sort()){
    const file=path.join(directory,relative),stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw Error("Generation payloads require regular files and directories.");
    if(stat.isDirectory())continue;
    if(!expected.delete(relative)||Content.excludedReason(relative))throw Error("Unexpected AMD generation payload input: "+relative);
    if(relative.endsWith(".json")&&relative!=="provider.json"){
      const shader=JSON.parse(fs.readFileSync(file,"utf8"));
      if(typeof shader.entry!=="string"||!Array.isArray(shader.threads)||shader.threads.length!==3||shader.threads.some(value=>!Number.isInteger(value)||value<1)||!Array.isArray(shader.bindings))throw Error("Invalid AMD generation shader metadata.");
    }
    temporalInputs.set("generation/fsr3/"+relative,file);
  }
  if(expected.size)throw Error("The AMD generation shader and license closure is incomplete.");
  const symbols=execFileSync("/usr/bin/nm",["-gU",path.join(directory,metadata.library)],{encoding:"utf8"});
  if(!/\b_rsGetGenerationProvider\b/.test(symbols))throw Error("The AMD generation library does not export its provider interface.");
  for(const name of ["source.json","build.mjs","backend.mm","metal-backend.hpp","index.js"])extraOwned.set("maclauncher/generation/fsr3/"+name,path.join(ownedRoot,name));
  pins.push(` ${source.commit} third_party/FidelityFX-SDK-generation`);
  features.graphics.generationProviderAPI=1;features.graphics.frameGenerationMethods=[...new Set([...(features.graphics.frameGenerationMethods||[]),"fsr3"])];
}
if(options["--xess"]){
  const directory=options["--xess"],metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json"),"utf8"));
  const ownedRoot=path.resolve(import.meta.dirname,"../src/modules/crossover/temporal/xess");
  const source=JSON.parse(fs.readFileSync(path.join(ownedRoot,"source.json"),"utf8"));
  if(metadata.schema!==1||metadata.profile!==source.profile||metadata.library!==source.library||JSON.stringify(metadata.sources)!==JSON.stringify(source)||!metadata.owned)throw Error("A compatible XeSS API translation payload is required.");
  for(const [id,submodule]of [["xess","xess"],["dxmt","dxmt-camera"]]){
    const root=path.resolve(import.meta.dirname,"../src/external",submodule),commit=execFileSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
    if(commit!==source[id].revision)throw Error("The XeSS API translation source pin differs.");
    execFileSync("git",["-C",root,"diff","--exit-code","HEAD","--"],{stdio:"pipe"});
    pins.push(` ${commit} third_party/${submodule}`);
  }
  for(const [name,sha256]of Object.entries(metadata.owned)){
    if(!/^[a-zA-Z0-9_.-]+$/.test(name)||digest(fs.readFileSync(path.join(ownedRoot,name)))!==sha256)throw Error("The XeSS translation build inputs changed.");
    extraOwned.set("maclauncher/crossover/temporal/xess/"+name,path.join(ownedRoot,name));
  }
  const dependencies={
    "dxmt/camera-transport.hpp":"../dxmt/camera-transport.hpp",
    "temporal/camera.h":"../../../shared/reshade/temporal/camera.h",
    "temporal/frame.h":"../../../shared/reshade/temporal/frame.h"
  };
  if(!metadata.dependencies||Object.keys(metadata.dependencies).sort().join()!==Object.keys(dependencies).sort().join())throw Error("The XeSS translation dependency closure is incomplete.");
  for(const [name,relative]of Object.entries(dependencies)){
    const file=path.resolve(ownedRoot,relative);
    if(digest(fs.readFileSync(file))!==metadata.dependencies[name])throw Error("The XeSS translation dependency changed: "+name);
    const ownedName=name.startsWith("dxmt/")?"maclauncher/crossover/temporal/"+name:"maclauncher/shared/reshade/"+name;
    extraOwned.set(ownedName,file);
  }
  const library=path.join(directory,source.library);
  if(!fs.lstatSync(library).isFile()||fs.lstatSync(library).isSymbolicLink()||digest(fs.readFileSync(library))!==metadata.sha256)throw Error("The XeSS translation library changed.");
  for(const name of [source.library,"provider.json","XeSS-Headers-LICENSE.txt","DXMT-LICENSE.txt"])temporalInputs.set("temporal/xess/"+name,path.join(directory,name));
}
for (const name of ["fsr", "fsr4"]) {
  const directory = options["--" + name];
  if (!directory) continue;
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "provider.json"), "utf8"));
  if (metadata.providerABI !== 1 || metadata.complete !== true) throw new Error("A complete temporal provider payload is required.");
  if(name==="fsr4"){
    const staged=stageFSR4Provider({directory,upstream:options["--fsr4-source"],ownedRoot:path.resolve(import.meta.dirname,"../src/modules/shared/reshade/temporal/fsr4")});
    features.graphics.temporalProfiles={...features.graphics.temporalProfiles,fsr4:staged?.profiles||["exact-fast"]};
    if(staged){
      for(const [relative,file]of staged.files)temporalInputs.set(relative,file);
      for(const [relative,file]of staged.owned)extraOwned.set(relative,file);
      extraSources.push(staged.source);pins.push(...staged.pins);temporalProviderNotices.push(...staged.notices);
      features.graphics.temporalProfileAPI=1;continue;
    }
  }
  for (const relative of fs.readdirSync(directory, { recursive: true }).sort()) {
    const file = path.join(directory, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("Temporal payloads must contain regular files.");
    if (stat.isFile()) temporalInputs.set(`temporal/${name}/${relative}`, file);
  }
}
for(const name of ["asr","sgsr2"]){
  const directory=options["--"+name];if(!directory){if(options["--"+name+"-source"])throw Error("A temporal source checkout requires its provider payload.");continue;}
  const staged=stageTemporalProvider({name,directory,upstream:options["--"+name+"-source"],ownedRoot:path.resolve(import.meta.dirname,"../src/modules/shared/reshade/temporal",name)});
  for(const [relative,file] of staged.files)temporalInputs.set(relative,file);
  for(const [relative,file] of staged.owned)extraOwned.set(relative,file);
  extraSources.push(staged.source);pins.push(staged.pin);temporalProviderNotices.push(...staged.notices);
  features.graphics.temporalMethods=[...new Set([...(features.graphics.temporalMethods||[]),name])];
  features.graphics.temporalProviderRegistryAPI=1;
}
for (const method of features.graphics.temporalMethods || []) {
  if (["metalfx","metalfx-denoised"].includes(method)) continue;
  const name = ["fsr4","asr","sgsr2"].includes(method) ? method : "fsr";
  if (!temporalInputs.has(`temporal/${name}/libmaclauncher-${method}.dylib`)) throw new Error(`The ${method} provider payload is required by graphics capabilities.`);
}
const snapshotProviders=new Set();
for (const name of ["godot", "streamline", "dxmt"]) {
  const directory = options["--" + name];
  if (!directory) continue;
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, name === "dxmt" ? "camera-bridge.json" : "provider.json")));
  const selected = name === "godot" ? ["libmaclauncher-godot-camera.dylib", "provider.json", "GODOT-LICENSE.txt", "autoload.gd", "camera-effect.gd"]
    : name === "streamline" ? ["sl.interposer.dll", "provider.json", "Streamline-LICENSE.txt"]
    : [...Object.keys(metadata.files).filter(name=>name!=="source.tar.gz"), "camera-bridge.json", "LICENSE", "LICENSE.OLD", "COPYING.LIB"];
  if (name === "godot" ? metadata.abi !== 1 || metadata.complete !== true : metadata.schema !== 1)
    throw new Error("Unsupported camera bridge metadata.");
  if(name!=="godot"){
    const snapshots=stageStreamlineSnapshots({name,directory,metadata,recipeRoot:path.resolve(import.meta.dirname,"../src/modules/crossover/temporal")});
    if(snapshots){snapshotProviders.add(name);pins.push(snapshots.pin);for(const [relative,file]of snapshots.owned)extraOwned.set(relative,file);}
  }
  if(name==="godot"&&metadata.sceneAovAPI!==undefined){
    const programs=metadata.aovCapture?.programs,root=path.resolve(import.meta.dirname,"../src/modules/godot/graphics");
    if(metadata.sceneAovAPI!==1||metadata.sceneCopyBoundaryAPI!==1||metadata.aovCapture?.version!==1||!Array.isArray(programs)||programs.length!==4||
        new Set(programs.map(row=>row.variant)).size!==4||programs.some(row=>!Number.isInteger(row.variant)||row.variant<0||row.variant>3||row.file!==`aov-capture-${row.variant}.spv`||!Number.isSafeInteger(row.size)||row.size<1||!/^[a-f0-9]{64}$/.test(row.sha256)))
      throw Error("The Godot AOV snapshot program contract is incomplete.");
    const sourceNames=["bridge.cpp","autoload.gd","camera-effect.gd","aov-effect.gd","aov-capture.glsl",...[
      "camera.h","frame.h","scene.h","scene-matrices.h","scene-destination.h","scene-aovs.h","scene-copy-boundary.h"].map(file=>"../../shared/reshade/temporal/"+file),"../../shared/reshade/native/image-color.h"];
    if(!metadata.ownedSourceSha256||Object.keys(metadata.ownedSourceSha256).sort().join()!==sourceNames.sort().join())throw Error("The Godot AOV source closure is incomplete.");
    for(const relative of sourceNames){const file=path.join(root,relative);if(digest(fs.readFileSync(file))!==metadata.ownedSourceSha256[relative])throw Error("The Godot AOV source changed: "+relative);extraOwned.set(path.posix.normalize("maclauncher/godot/graphics/"+relative),file);}
    for(const file of ["build.mjs","source.json"])extraOwned.set("maclauncher/godot/graphics/"+file,path.join(root,file));
    for(const row of programs){const file=path.join(directory,row.file),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==row.size||digest(fs.readFileSync(file))!==row.sha256)throw Error("The Godot AOV snapshot program changed: "+row.file);}
    for(const file of ["autoload.gd","camera-effect.gd","aov-effect.gd"])if(digest(fs.readFileSync(path.join(directory,file)))!==metadata.ownedSourceSha256[file])throw Error("The Godot AOV script changed: "+file);
    const exports=execFileSync("/usr/bin/nm",["-gU",path.join(directory,metadata.library)],{encoding:"utf8"});
    for(const symbol of ["maclauncher_godot_scene_aov_api","maclauncher_godot_scene_copy_api"])if(!new RegExp("\\b_"+symbol+"\\b").test(exports))throw Error("The Godot scene recording API is missing: "+symbol);
    selected.push("aov-effect.gd",...programs.map(row=>row.file));
  }
  for (const relative of selected) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new Error("Invalid camera bridge path.");
    const file = path.join(directory, relative);
    if (!fs.lstatSync(file).isFile()) throw new Error("Camera bridges must contain regular files.");
    const expected = name === "dxmt" ? metadata.files[relative] : name === "streamline" && relative === metadata.library ? metadata.sha256 : null;
    if (expected && digest(fs.readFileSync(file)) !== expected) throw new Error("Camera bridge payload changed.");
    temporalInputs.set(`${name === "godot" ? "godot" : "temporal/" + name}/${relative}`, file);
  }
}
if(snapshotProviders.size){
  if(snapshotProviders.size!==2)throw Error("Streamline tag-time snapshots require the matching DXMT GPU recording provider.");
  features.graphics.streamlineSnapshotAPI=1;
}
const nativePaths = new Map(nativeFiles.map(file => [file, path.join(build, file)]));
for(const [relative,file] of retroarchInputs)if(nativeFiles.includes(relative))nativePaths.set(relative,file);
for(const [relative,load] of optionalLoad){nativeFiles.push(relative);nativePaths.set(relative,optionalInputs.get(relative));}
if(nativeFiles.includes("maclauncher-graphics-video")) optionalLoad.set("maclauncher-graphics-video", {architectures: ["arm64", "x86_64"], minimumMacOS: "14.0"});
for (const [relative, file] of temporalInputs) if (/\.(dylib|so)$/.test(relative)) { nativeFiles.push(relative); nativePaths.set(relative, file); }
const nativeArchitectures = new Map();
for (const file of nativeFiles) {
  const architectures = Native.readMachOArchitectures(nativePaths.get(file), { allowLibrary: /\.(dylib|so)$/.test(file) });
  const required = optionalLoad.get(file)?.architectures || (file.startsWith("temporal/dxmt/") ? ["x86_64"] : ["arm64", "x86_64"]);
  if (!required.every(arch => architectures.includes(arch))) throw new Error(`${file} is missing a required architecture.`);
  nativeArchitectures.set(file, architectures);
}
// Verify the compiler's CPU-only inspection entry point before advertising it.
let inspection;
try {
  execFileSync(path.join(build, "fx-compile"), ["--inspect-lossless", path.join(source, "LICENSE")], { stdio: "pipe", timeout: 10000 });
} catch (error) {
  if (error.status === 1) {
    try { inspection = JSON.parse(String(error.stdout)); } catch {}
  }
}
if (inspection?.schema !== 1 || typeof inspection.error !== "string") throw new Error("The ReShade compiler must support CPU-only model inspection.");
verifyReShadeCompiler(path.join(build, "fx-compile"));
const symbols = execFileSync("/usr/bin/nm", ["-gU", path.join(build, "libreshade-macos.dylib")], { encoding: "utf8" });
if(/\b_rsShaderLinearInputPolicyAPI\b/.test(symbols))features.shaders.linearInputPolicyAPI=1;
if(/\b_rsShaderSceneHistoryAPI\b/.test(symbols)){
  features.shaders.sceneHistoryAPI=1;features.shaders.providers??={};
  features.shaders.providers.fx={...features.shaders.providers.fx,sceneHistoryAPI:1};
}
if(/\b_rsMetal4SceneAPI\b/.test(symbols)){
  for(const name of ["Metal4SceneIngress6encode","Metal4ClassicBridge6encode","takeDeferredTemporalOutput"])
    if(!symbols.includes(name))throw Error("The Metal 4 scene recording implementation is incomplete: "+name);
  features.graphics.metal4SceneAPI=1;
}
if(/\b_rsShaderSceneInputsAPI\b/.test(symbols)){
  for(const name of ["rsSceneAovAPI","rsBindTemporalSceneAovs","rsSetTemporalAovsForTexturesObserved","rsSceneCopyBoundaryAPI","rsSetTemporalSceneCopyBoundary"])
    if(!new RegExp("\\b_"+name+"\\b").test(symbols))throw Error("The common scene input implementation is incomplete: "+name);
  if(fs.readFileSync(path.join(ownedSource,"src/shader-scene-roles.h"),"utf8")!==sceneRoleHeader())throw Error("The native shader role registry differs from its shared input contract.");
  Object.assign(features.graphics,{sceneAovAPI:1,sceneCopyBoundaryAPI:1,shaderSceneInputsAPI:1});
  features.shaders.sceneInputsAPI=features.graphics.shaderSceneInputsAPI;
  features.shaders.providers??={};
  for(const format of ["fx"])
    features.shaders.providers[format]={...features.shaders.providers[format],sceneInputsAPI:1,sceneInputRoles:[...SCENE_SHADER_INPUTS]};
  extraOwned.set("maclauncher/native/scene-role-header.mjs",path.resolve(import.meta.dirname,"../src/modules/shared/reshade/native/scene-role-header.mjs"));
  extraOwned.set("effects/operation-contracts.mjs",path.resolve(import.meta.dirname,"../src/modules/shared/effects/operation-contracts.mjs"));
}
if(/\b_rsMetalFxDenoisedAPI\b/.test(symbols)){
  if(!symbols.includes("makeMetalFxDenoisedEncoder"))throw Error("The declared MetalFX denoised encoder factory is missing.");
  features.graphics.metalFXDenoisedAPI=1;
  features.graphics.temporalMethods=[...new Set([...(features.graphics.temporalMethods||[]),"metalfx-denoised"])];
}else if(features.graphics.temporalMethods?.includes("metalfx-denoised"))throw Error("The declared MetalFX denoised encoder is missing.");
const nativeImageFilters=stageNativeImageFilters({ownedSource,symbols,recipeRoot:path.resolve(import.meta.dirname,"../src/modules/shared/reshade")});
if(nativeImageFilters){
  features.shaders.formats=[...new Set([...(features.shaders.formats||[]),"native"])];features.shaders.providers??={};
  features.shaders.providers.native={architectures:["arm64","x86_64"],minimumMacOS:"13.0",methods:nativeImageFilters.methods};
  pins.push(...nativeImageFilters.pins);
  for(const [relative,file]of nativeImageFilters.owned)extraOwned.set(relative,file);
}
if(nativeImageFilters?.methods.includes("estimated-depth-fog")&&features.graphics.estimatedDepthAPI!==1)throw Error("Estimated depth fog requires the complete scalar neural provider.");
if(features.graphics.estimatedDepthAPI===1&&(!symbols.includes("NeuralDepthEstimator")||!symbols.includes("makeEstimatedDepthFogNode")))throw Error("The graphics core is missing its scalar attachment and fog consumer.");
if(nativeFiles.includes("shaderc-offline")&&optionalInputs.has("libplacebo/libshaderc_shared.1.dylib")&&symbols.includes("makeMagpieShaderNode")){
  features.shaders.formats=[...new Set([...(features.shaders.formats||[]),"magpie"])];features.shaders.providers??={};
  features.shaders.providers.magpie={...features.shaders.providers.magpie,architectures:["arm64","x86_64"],minimumMacOS:"13.0",compilerMinimumMacOSByArchitecture:{arm64:"15.0",x86_64:"14.0"}};
  if(features.graphics.shaderSceneInputsAPI===1)Object.assign(features.shaders.providers.magpie,{sceneInputsAPI:1,sceneInputRoles:[...SCENE_SHADER_INPUTS]});
}
if(options["--fsr3-generation"]&&!symbols.includes("makeFSR3GenerationEncoder"))throw Error("The core graphics library must include the AMD generation adapter.");
if(options["--isf"]&&!symbols.includes("makeISFShaderNode"))throw Error("The core graphics library must include the ISF shader adapter.");
if(options["--xess-host"]&&!symbols.includes("makeXessSceneEncoder"))throw Error("The core graphics library must include the original XeSS scene adapter.");
if(features.graphics.xessGenerationAPI===1){
  if(!symbols.includes("makeXessGenerationEncoder"))throw Error("The core graphics library must include the original XeSS generation adapter.");
  for(const name of ["rsBindTemporalSceneMatrices","rsReleaseTemporalSceneMatrices"])
    if(!new RegExp("\\b_"+name+"\\b").test(symbols))throw Error("The graphics library is missing actual scene-matrix support: "+name);
}
if(features.graphics.colorPipelineAPI===1)for(const name of ["rsProcessFrameWithColor","rsCreateColorFramePresenter","rsSetColorFramePresenterHeadroom","rsProcessTemporalFrameColor"])
  if(!new RegExp("\\b_"+name+"\\b").test(symbols))throw Error("The graphics library is missing explicit color support: "+name);
if(features.graphics.lsfgHDRAPI===1&&!symbols.includes("lsfgHDRAPI"))throw Error("The graphics library is missing native HDR Lossless Scaling generation support.");
if(features.graphics.shaderInputPolicyAPI===1&&!/\b_rsShaderInputPolicyAPI\b/.test(symbols))throw Error("The graphics library is missing declared shader input-policy support.");
if(features.graphics.outputColorAPI===1)for(const name of ["rsOutputColorAPI","rsVideoGetOutputColorStatus"])
  if(!new RegExp("\\b_"+name+"\\b").test(symbols))throw Error("The graphics library is missing explicit shared output color support: "+name);
if(features.graphics.neuralGpuTimingAPI===1&&!/\b_rsNeuralGpuTimingAPI\b/.test(symbols))throw Error("The graphics library is missing neural GPU timing support.");
if(features.graphics.contentPresentationAPI===1)for(const name of ["rsSubmitFramePresenterContent","rsSubmitFramePresenterContentAtTime"])
  if(!new RegExp("\\b_"+name+"\\b").test(symbols))throw Error("The graphics library is missing stamped content support: "+name);
if(features.graphics.preparationNotificationAPI===1&&!/\b_rsObserveFramePresenterPreparation\b/.test(symbols))throw Error("The graphics library is missing preparation-ready notification support.");
if(features.graphics.comparisonAPI===1&&(!/\b_rsVideoComparisonAPI\b/.test(symbols)||!symbols.includes("encodeAligned")))throw Error("The graphics library is missing shared image and video comparison support.");
if(features.graphics.adaptiveQualityAPI===1){
  if(!/\b_rsAdaptiveQualityAPI\b/.test(symbols)||!/\b_rsVideoGetQualityStatus\b/.test(symbols)||!["EffectQualitySession","observeGpuQuality","observeRuntimeAdaptiveQuality"].every(name=>symbols.includes(name)))throw Error("The graphics library is missing shared adaptive quality processing or status support.");
  if(fs.readFileSync(path.join(ownedSource,"src/generation-methods.hpp"),"utf8")!==generationMethodsHeader())throw Error("The native generation contracts differ from their shared registry.");
}
if(features.graphics.temporalProviderRegistryAPI===1&&!/\b_rsTemporalProviderMethodMask\b/.test(symbols))throw Error("The graphics library is missing the registered temporal provider dispatcher.");
if(features.graphics.temporalProfileAPI===1&&!/\b_rsTemporalProfileAPI\b/.test(symbols))throw Error("The graphics library is missing temporal profile validation support.");
if(features.graphics.sceneGuideTransformAPI===1&&!symbols.includes("SceneGuideEncoder6encode"))throw Error("The graphics library is missing shared scene-guide normalization.");
if(extraOwned.size)sourceHash=digest(Buffer.concat([Buffer.from(sourceHash+'\0'),...[...extraOwned].flatMap(([relative,file])=>[Buffer.from(relative+'\0'),fs.readFileSync(file)])]));
if(features.graphics.sceneWindowContinuationAPI===1)for(const name of ["rsSceneWindowContinuationABI","rsSetTemporalSceneDestinationFlagsForTextures"])if(!new RegExp("\\b_"+name+"\\b").test(symbols))throw Error("The graphics library is missing explicit scene-window continuation: "+name);
if(features.graphics.videoFrameGenerationMethods?.includes("rife")&&!symbols.includes("makeRifeGenerationEncoder"))throw Error("The graphics library is missing the RIFE generation adapter.");
if (!/\b_rsProcessFrame\b/.test(symbols)) throw new Error("The ReShade library must provide its shared frame encoder.");
if (!/\b_rsSubmitFramePresenterAtTimeObserved\b/.test(symbols)) throw new Error("The ReShade library must provide frame retirement callbacks for explicit presentation.");
if (features.graphics.browserFrameAPI === 1 && !/\b_rsBrowserFrameAPI\b/.test(symbols)) throw new Error("The ReShade library must provide its completed browser-window frame source.");
if (features.graphics.observedPresentationAPI === 1 && !/\b_rsSubmitFramePresenterObserved\b/.test(symbols)) throw new Error("The ReShade library must provide display-driven frame retirement callbacks.");
if (features.graphics.temporalMethods?.length && !/\b_rsProcessTemporalFrame\b/.test(symbols)) throw new Error("The ReShade library must provide its temporal frame encoder.");
if (features.graphics.temporalCameraAPI === 1) for (const name of ["rsSetTemporalCamera", "rsSetTemporalCameraForTextures", "rsClearTemporalCameraTextures", "rsGetTemporalMethod"])
  if (!new RegExp("\\b_" + name + "\\b").test(symbols)) throw new Error("The graphics library is missing camera input support.");
// The optional DXMT bridge has the selected Windows runtime's own macOS floor.
const floors = nativeFiles.filter(file => !file.startsWith("temporal/dxmt/")&&!optionalLoad.has(file)).flatMap(file =>
  [...execFileSync("xcrun", ["vtool", "-show-build", nativePaths.get(file)], { encoding: "utf8" }).matchAll(/minos\s+(\d+(?:\.\d+)+)/g)].map(match => match[1]));
if (!floors.length) throw new Error("Cannot determine the ReShade macOS requirement.");
const minimumMacOS = floors.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
const inputs = new Map([
  ...(nativeImageFilters?.inputs||[]),
  ...nativePaths,
  ...retroarchInputs,
  ...optionalInputs,
  ...temporalInputs,
  ["licenses/MacFX.txt", path.join(source, "LICENSE")], ["licenses/THIRD_PARTY.md", path.join(ownedSource, "THIRD_PARTY.md")],
  ["licenses/ReShade.txt", path.join(source, "third_party/reshade/LICENSE.md")],
  ["licenses/MAKO.txt", path.join(source, "third_party/mako/LICENSE.md")],
  ["licenses/FSR1.txt", path.join(source, "third_party/fsr/license.txt")],
  ["licenses/vkd3d.txt", path.join(source, "third_party/vkd3d/COPYING")],
  ["licenses/SPIRV-Cross.txt", path.join(source, "third_party/spirv-cross/LICENSE")],
  ["licenses/SPIRV-Headers.txt", path.join(source, "third_party/reshade/deps/spirv/LICENSE")]
]);
if(nativeFiles.includes("shaderc-offline")){
  const metadata=JSON.parse(fs.readFileSync(path.join(ownedSource,"compat/shaderc/source.json"),"utf8"));
  if(metadata.repository!=="https://github.com/google/shaderc"||metadata.commit!=="d393a813c9b67c709d37b329203d72beb69d719e"||metadata.version!=="2026.4"||metadata.license!=="Apache-2.0"||metadata.files?.length!==4)throw Error("The shader compiler API source pin is invalid.");
  for(const row of metadata.files)if(!["shaderc.h","env.h","status.h","visibility.h"].includes(row.path)||digest(fs.readFileSync(path.join(ownedSource,"compat/shaderc",row.path)))!==row.sha256)throw Error("A shader compiler API declaration changed.");
  inputs.set("licenses/shaderc-api.txt",path.join(ownedSource,"compat/shaderc/LICENSE"));pins.push(` ${metadata.commit} third_party/shaderc-headers`);
}
if(fs.existsSync(path.join(ownedSource,"src/color-source.json"))){
  const colorSource=JSON.parse(fs.readFileSync(path.join(ownedSource,"src/color-source.json"),"utf8"));
  if(colorSource.repository!=="https://github.com/KhronosGroup/ToneMapping"||!/^\w{40}$/.test(colorSource.commit)||colorSource.license!=="Apache-2.0"||colorSource.licenseFile!=="color-tone-mapping-LICENSE.txt")throw Error("Invalid color implementation source metadata.");
  inputs.set("licenses/Khronos-ToneMapping.txt",path.join(ownedSource,"src",colorSource.licenseFile));
  pins.push(` ${colorSource.commit} third_party/Khronos-ToneMapping`);
}
for (const name of ["ReShade.fxh", "ReShadeUI.fxh"]) inputs.set("include/" + name, path.join(source, "third_party/reshade-shaders/Shaders", name));
const effects = path.resolve(import.meta.dirname, "../src/modules/shared/reshade/effects");
for (const name of fs.readdirSync(effects)) inputs.set("effects/" + name, path.join(effects, name));
const effectNotices = validateEffectSources(effectSources, [...inputs].map(([relative, input]) => ({ path: relative, sha256: digest(fs.readFileSync(input)) })));
// Presets, includes and notices belong to the same immutable payload as the
// native binaries. An effect-only update must not overwrite an older version
// while a running game still refers to that version's files.
const payloadHash = digest(Buffer.concat([Buffer.from("adhoc-signature-v1\0" + pins.join("\n") + "\0" + JSON.stringify(features) + "\0" + JSON.stringify(effectSources) + "\0"),
  ...[...extraOwned].flatMap(([relative,file])=>[Buffer.from(relative+'\0'),fs.readFileSync(file)]),
  ...[...inputs].sort(([a], [b]) => a.localeCompare(b)).flatMap(([relative, input]) =>
    [Buffer.from(relative + "\0"), fs.readFileSync(input)])]));
const version = "0.1.0-" + sourceHash.slice(0, 8) + "-" + payloadHash.slice(0, 8);
const directoryRelative = `reshade/${version}/universal`;
const destination = path.join(resourceRoot, directoryRelative);
fs.mkdirSync(destination, { recursive: true });
for (const directory of ["include", "effects", "licenses"]) fs.mkdirSync(path.join(destination, directory), { recursive: true });
const files = [];
for (const [relative, input] of inputs) {
  const output = path.join(destination, relative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(input, output, fs.constants.COPYFILE_FICLONE);
  const executable = nativeFiles.includes(relative);
  fs.chmodSync(output, executable ? 0o755 : 0o644);
  if (executable) execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", output], { stdio: "pipe" });
  files.push({ path: relative, sha256: digest(fs.readFileSync(output)), size: fs.statSync(output).size,
    mode: executable ? 0o755 : 0o644, ...(executable ? { architectures: nativeArchitectures.get(relative),
      ...(relative.startsWith("temporal/dxmt/") ? { executionArchitecture: "x86_64" } : {}),
      ...(optionalLoad.has(relative)?{optionalLoad:optionalLoad.get(relative)}:{}) } : {}) });
}
// The camera provider's source is available in the tagged producer repository.
if(options["--xess-host"]){
  const relative="xess/provider.json",file=path.join(destination,relative),metadata=JSON.parse(fs.readFileSync(file));
  metadata.files=metadata.files.filter(row=>!row.path.startsWith("source/")).map(row=>{const actual=files.find(item=>item.path==="xess/"+row.path);return {...row,size:actual.size,sha256:actual.sha256};});
  fs.writeFileSync(file,JSON.stringify(metadata,null,2)+"\n");Object.assign(files.find(row=>row.path===relative),{sha256:digest(fs.readFileSync(file)),size:fs.statSync(file).size});
}
if (inputs.has('temporal/dxmt/camera-bridge.json')) {
  const relative='temporal/dxmt/camera-bridge.json',file=path.join(destination,relative),metadata=JSON.parse(fs.readFileSync(file));
  delete metadata.files['source.tar.gz'];fs.writeFileSync(file,JSON.stringify(metadata,null,2)+'\n');
  Object.assign(files.find(entry=>entry.path===relative),{sha256:digest(fs.readFileSync(file)),size:fs.statSync(file).size});
}
// Source and owned build recipes are delivered by the tagged producer repository.
function record(relative) {
  const file = path.join(destination, relative); fs.chmodSync(file, 0o644);
  return { path: relative, sha256: digest(fs.readFileSync(file)), size: fs.statSync(file).size, mode: 0o644 };
}
fs.writeFileSync(path.join(destination, "runtime.json"), JSON.stringify({ schema: 1, version,
  minimumMacOS, architectures: ["arm64", "x86_64"], features, effectSources, sourceHash, sourcePins: pins.map(line => line.trim()), files }, null, 2) + "\n");
const manifest = record("runtime.json"); files.push(manifest);
const declaration = { id: "reshade", version, arch: "universal", launcherArchitectures: ["arm64", "x64"], minimumMacOS,
  sourceRelative: null, sourceSha256: sourceHash, directoryRelative,
  manifestRelative: manifest.path, manifestSha256: manifest.sha256, files,
  notices: [
    ...temporalProviderNotices,
    ...(nativeImageFilters?.notices||[]),
    ...restorationNotices.filter(notice=>inputs.has(notice.path)),
    ...depthNotices.filter(notice=>inputs.has(notice.path)),
    ...(inputs.has("licenses/shaderc-api.txt")?[{name:"shaderc public interfaces",license:"Apache-2.0",path:"licenses/shaderc-api.txt",sourceUrl:"https://github.com/google/shaderc"}]:[]),
    { name: "ReShade macOS adapter", license: "BSD-3-Clause", path: "licenses/MacFX.txt" },
    { name: "ReShade", license: "BSD-3-Clause", path: "licenses/ReShade.txt", sourceUrl: "https://github.com/crosire/reshade" },
    { name: "vkd3d shader translator", license: "LGPL-2.1-or-later", path: "licenses/vkd3d.txt", sourceUrl: "https://codeberg.org/vkd3d/vkd3d" },
    { name: "MAKO model processing and frame pacing", license: "GPL-3.0-or-later", path: "licenses/MAKO.txt", sourceUrl: "https://github.com/eugeniosegala/MAKO" },
    { name: "AMD FidelityFX FSR1", license: "MIT", path: "licenses/FSR1.txt", sourceUrl: "https://github.com/GPUOpen-Effects/FidelityFX-FSR" },
    { name: "SPIRV-Cross", license: "Apache-2.0 OR MIT", path: "licenses/SPIRV-Cross.txt", sourceUrl: "https://github.com/KhronosGroup/SPIRV-Cross" },
    { name: "SPIRV-Headers", license: "MIT", path: "licenses/SPIRV-Headers.txt", sourceUrl: "https://github.com/KhronosGroup/SPIRV-Headers" },
    { name: "ReShade shader headers", license: "CC0-1.0", path: "include/ReShade.fxh", sourceUrl: "https://github.com/crosire/reshade-shaders" },
    ...(inputs.has("licenses/Khronos-ToneMapping.txt")?[{name:"Khronos PBR Neutral tone mapping",license:"Apache-2.0",path:"licenses/Khronos-ToneMapping.txt",sourceUrl:"https://github.com/KhronosGroup/ToneMapping"}]:[]),
    ...(options["--isf"]?[
      {name:"ISFMSLKit and shader compiler dependencies",license:"MIT AND BSD-3-Clause AND Apache-2.0",path:"isf/ISF-LICENSE.txt",sourceUrl:"https://github.com/mrRay/ISFMSLKit"},
      {name:"VVMetalKit",license:"MIT AND LicenseRef-Apple-Sample-Code",path:"isf/VVMetalKit-LICENSE.txt",sourceUrl:"https://github.com/mrRay/VVMetalKit"},
      {name:"ISFGLSLGenerator",license:"BSD-3-Clause",path:"isf/ISFGLSLGenerator-LICENSE.txt",sourceUrl:"https://github.com/mrRay/ISFGLSLGenerator"},
      {name:"PINCache",license:"Apache-2.0",path:"isf/PINCache-LICENSE.txt",sourceUrl:"https://github.com/mrRay/PINCache"},
      {name:"PINOperation",license:"Apache-2.0",path:"isf/PINOperation-LICENSE.txt",sourceUrl:"https://github.com/pinterest/PINOperation"}
    ]:[]),
    ...(options["--retroarch"] ? [{name:"librashader",license:"MPL-2.0",path:"notices/librashader/LICENSE.md",sourceUrl:"https://github.com/SnowflakePowered/librashader"}] : []),
    ...(options["--neural"] ? [
      { name: "MLX-DLSS", license: "Apache-2.0", path: "neural/notices/MLX-DLSS-LICENSE", sourceUrl: "https://github.com/iamwavecut/MLX-DLSS" },
      { name: "MLX", license: "MIT", path: "neural/notices/MLX-LICENSE", sourceUrl: "https://github.com/ml-explore/mlx" },
      { name: "MLX Swift", license: "MIT", path: "neural/notices/MLX-Swift-LICENSE", sourceUrl: "https://github.com/ml-explore/mlx-swift" },
      { name: "Swift Argument Parser", license: "Apache-2.0", path: "neural/notices/Swift-Argument-Parser-LICENSE", sourceUrl: "https://github.com/apple/swift-argument-parser" },
      { name: "Swift Numerics", license: "Apache-2.0", path: "neural/notices/Swift-Numerics-LICENSE", sourceUrl: "https://github.com/apple/swift-numerics" }
    ] : []),
    ...(libplacebo?[
      {name:"libplacebo",license:"LGPL-2.1-or-later",path:"notices/libplacebo/libplacebo.360.dylib.LICENSE",sourceUrl:libplacebo.inputs.find(item=>["libplacebo.360.dylib","libplacebo"].includes(item.name)).source},
      {name:"shaderc",license:"Apache-2.0",path:"notices/libplacebo/libshaderc_shared.1.dylib.LICENSE",sourceUrl:libplacebo.inputs.find(item=>item.name==="libshaderc_shared.1.dylib").source},
      {name:"Little CMS",license:"MIT",path:"notices/libplacebo/liblcms2.2.dylib.LICENSE",sourceUrl:libplacebo.inputs.find(item=>item.name==="liblcms2.2.dylib").source},
      {name:"MoltenVK",license:"Apache-2.0",path:"notices/libplacebo/MoltenVK.LICENSE",sourceUrl:"https://github.com/KhronosGroup/MoltenVK"}
    ]:[]),
    ...(options["--fsr"] ? [
      { name: "AMD FidelityFX FSR2", license: "MIT", path: "temporal/fsr/FSR2-LICENSE.txt", sourceUrl: "https://github.com/GPUOpen-Effects/FidelityFX-FSR2" },
      { name: "AMD FidelityFX FSR3 upscaler", license: "MIT", path: "temporal/fsr/FSR3-LICENSE.txt", sourceUrl: "https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK" }
    ] : []),
    ...(options["--fsr4"] ? [
      { name: "FSR4 Metal provider", license: "MIT", path: "temporal/fsr4/NOTICE.md", sourceUrl: "https://github.com/UzenUPoZiTiV4ik/fsr4-native-macos" },
      { name: "FSR4 shader implementation", license: "MIT", path: "temporal/fsr4/third_party/fsr411/LICENSE", sourceUrl: "https://github.com/int3rrobang/fsr4-int8-reverse-engineering" },
      { name: "AMD FSR4 model and helpers", license: "MIT", path: "temporal/fsr4/third_party/fsr411/LICENSE.AMD.md", sourceUrl: "https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK" }
    ] : []),
    ...(options["--fsr3-generation"]?[{name:"AMD FidelityFX optical flow and frame interpolation",license:"MIT",path:"generation/fsr3/FSR3-LICENSE.txt",sourceUrl:"https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK"}]:[]),
    ...(options["--xess-host"]?[{name:"Intel XeSS runtime terms",license:"LicenseRef-Intel-Simplified-Software-October-2022",path:"xess/INTEL-LICENSE.txt",sourceUrl:"https://github.com/intel/xess"},{name:"Intel XeSS public interfaces",license:"MIT",path:"xess/INTEL-HEADERS-MIT.txt",sourceUrl:"https://github.com/intel/xess"},{name:"Intel XeSS third-party notices",license:"LicenseRef-XeSS-Notices",path:"xess/INTEL-THIRD-PARTY.txt",sourceUrl:"https://github.com/intel/xess"},...(inputs.has("xess/KHRONOS-APACHE-2.0.txt")?[{name:"Vulkan public interfaces",license:"Apache-2.0",path:"xess/KHRONOS-APACHE-2.0.txt",sourceUrl:"https://github.com/KhronosGroup/Vulkan-Headers"}]:[])]:[]),
    ...(options["--godot"] ? [{ name: "Godot extension interface", license: "MIT", path: "godot/GODOT-LICENSE.txt", sourceUrl: "https://github.com/godotengine/godot" }] : []),
    ...(options["--streamline"] ? [{ name: "NVIDIA Streamline interface", license: "MIT", path: "temporal/streamline/Streamline-LICENSE.txt", sourceUrl: "https://github.com/NVIDIA-RTX/Streamline" }] : []),
    ...(options["--xess"] ? [
      {name:"Intel XeSS public interfaces",license:"MIT",path:"temporal/xess/XeSS-Headers-LICENSE.txt",sourceUrl:"https://github.com/intel/xess"},
      {name:"DXMT temporal interface",license:"LGPL-2.1-or-later",path:"temporal/xess/DXMT-LICENSE.txt",sourceUrl:"https://github.com/3Shain/dxmt"}
    ] : []),
    ...(options["--dxmt"] ? [
      { name: "DXMT camera integration", license: "LGPL-2.1-or-later", path: "temporal/dxmt/LICENSE", sourceUrl: "https://github.com/3Shain/dxmt" },
      { name: "DXMT Wine interfaces", license: "LGPL-2.1-or-later", path: "temporal/dxmt/COPYING.LIB", sourceUrl: "https://github.com/3Shain/dxmt" },
      { name: "DXMT third-party components", license: "LicenseRef-DXMT-Notices", path: "temporal/dxmt/LICENSE.OLD", sourceUrl: "https://github.com/3Shain/dxmt" }
    ] : []),
    ...effectNotices
  ] };
const { validateDeclaration } = await import("./native-supplementals.cjs");
validateDeclaration(declaration);
if(priorDeclaration?!fs.readFileSync(declarationPath).equals(priorDeclaration):fs.existsSync(declarationPath))throw Error("The graphics selection changed during staging; the newer selection was preserved.");
const declarationTemporary=declarationPath+"."+crypto.randomBytes(8).toString("hex")+".tmp";
try{
  fs.writeFileSync(declarationTemporary,JSON.stringify([declaration],null,2)+"\n",{flag:"wx",mode:0o644});
  fs.renameSync(declarationTemporary,declarationPath);
}finally{if(fs.existsSync(declarationTemporary))fs.unlinkSync(declarationTemporary);}
// Earlier generations other than the previous selection are removed from the
// repository resource directory only; installed runtimes are never touched.
let pruned=[];
try{pruned=pruneGraphicsRuntimes(path.join(resourceRoot,"reshade"),{selected:version,previous:priorDeclaration&&JSON.parse(priorDeclaration)[0]?.version});}
catch(error){console.warn("Graphics runtime cleanup: "+error.message);}
console.log(JSON.stringify({ destination, version, minimumMacOS, files: files.length, sourceHash, pruned }));
