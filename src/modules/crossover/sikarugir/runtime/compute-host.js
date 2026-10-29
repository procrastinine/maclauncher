// Copyright (c) MacLauncher contributors. MIT license.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {spawnSync}=require("node:child_process");
const Manager=require("./manager"),Launch=require("../launch"),Graphics=require("../graphics");
const Writable=require("../../../shared/writable-input"),Rosetta=require("../../../shared/runtime/rosetta");
const Catalog=require("./catalog"),{versionAtLeast,systemVersionSync}=require("../../../shared/runtime/bundled-native");
const {confirmToolInstall}=require("../../../shared/runtime/tool-install"),{withRuntimeMutation}=require("../../../../core/coordinated-runtime-managers");
let physicalArchitecture;
function architecture(){
  if(physicalArchitecture)return physicalArchitecture;
  physicalArchitecture=process.arch;
  if(process.platform==="darwin"&&process.arch==="x64"){
    const result=spawnSync("/usr/sbin/sysctl",["-n","hw.optional.arm64"],{encoding:"utf8",timeout:1000});
    if(!result.error&&result.status===0&&result.stdout.trim()==="1")physicalArchitecture="arm64";
  }
  return physicalArchitecture;
}
const digest=value=>crypto.createHash("sha256").update(value).digest("hex");
function capabilities(install){
  try{return Graphics.capabilitiesFor(install,install.templateRoot||install.supportRoot||path.join(install.installDir,"support"),{arch:architecture()});}
  catch{return {};}
}
function state({userDataDir,settings}={}){
  const selected=Manager.resolveSelection(null,settings,userDataDir,{verification:"status"}),runtime=Manager.getState({userDataDir,settings:settings?.runtimes?.sikarugir}),available=runtime.installed;
  const candidates=[selected.ready&&selected.install,...available.filter(row=>row.ready!==false)].filter(Boolean);
  const installs={};for(const install of candidates){const caps=capabilities(install);if(caps.d3dmetal&&!installs.d3d12)installs.d3d12=install;if(caps.kosmickrisp&&!installs.vulkan)installs.vulkan=install;}
  const backends=Object.keys(installs);
  const plans={};
  if(process.platform==="darwin"&&architecture()==="arm64"){
    const candidates=Manager.core.listCatalog({userDataDir}).filter(pin=>Catalog.validateEntry(pin)&&(runtime.catalog?.installableVersions||[]).includes(pin.version));
    for(const backend of ["d3d12","vulkan"]){
      if(installs[backend]||!versionAtLeast(systemVersionSync(),backend==="vulkan"?"26.0":"14.0"))continue;
      const pin=backend==="d3d12"?candidates.find(row=>Number(row.engineVersion.split(".")[0])>=11):candidates.find(row=>row.version===selected.version)||candidates[0];
      if(pin)plans[backend]={managerId:"sikarugir",version:pin.version,label:"Sikarugir GPU helper",requiresDownload:true,
        installOptions:{sectionId:"default"},detail:"Required for the selected XeSS GPU backend. GPU support is checked after installation."};
    }
  }
  const preparableBackends=Object.keys(plans);
  return {id:"sikarugir-gpu",label:"Sikarugir",backends,preparableBackends,available:backends.length>0,preparable:preparableBackends.length>0,installs,plans,
    ...(backends.length||preparableBackends.length?{}:{reason:"A compatible Windows GPU host is required."})};
}
function regular(file){const actual=fs.realpathSync(file);if(!fs.statSync(actual).isFile())throw Error("The GPU helper file is unavailable.");return actual;}
async function prepare(request,context={}){
  const {userDataDir,signal}=context;signal?.throwIfAborted();
  if(!["d3d12","vulkan"].includes(request.backend))throw Error("Choose a supported GPU compute backend.");
  const selected=state(context);let install=selected.installs[request.backend];
  if(!install&&selected.plans[request.backend]){
    if(request.prefixDirectory)throw Error("The selected existing GPU environment requires its installed runtime.");
    const plan=selected.plans[request.backend];
    await confirmToolInstall(context,{...plan,manager:Manager});
    install=await withRuntimeMutation({managerId:"sikarugir",version:plan.version},()=>Manager.installRuntime({...context,version:plan.version,...plan.installOptions}),{userDataDir});
    signal?.throwIfAborted();context.onRuntimeStateChange?.();
    const actual=capabilities(install);
    if(!(request.backend==="d3d12"?actual.d3dmetal:actual.kosmickrisp))throw Error("The installed GPU helper does not support the selected backend on this Mac.");
  }
  if(!install)throw Object.assign(new Error(selected.reason||"The selected GPU backend is unavailable."),{code:"GRAPHICS_COMPUTE_HOST_MISSING",managerId:"sikarugir"});
  if(install.needsRosetta)await Rosetta.ensure(context);
  const hostPath=regular(request.hostPath),originalLibrary=regular(request.originalLibrary),nativeRoot=fs.realpathSync(request.nativeRoot);
  if(request.originalLibraries&&(!Array.isArray(request.originalLibraries)||!request.originalLibraries.length||request.originalLibraries.length>16))throw Error("The GPU helper library list is invalid.");
  const originalLibraries=request.originalLibraries?.map(regular);
  if(originalLibraries&&(originalLibraries[0]!==originalLibrary||new Set(originalLibraries).size!==originalLibraries.length))throw Error("The GPU helper library identities are invalid.");
  if(!fs.statSync(nativeRoot).isDirectory())throw Error("The GPU helper directory is unavailable.");
  const identity=digest(JSON.stringify([1,install.version,request.backend])),directory=path.join(userDataDir,"graphics/compute-hosts",identity.slice(0,24));
  Writable.assertOwnDirectory(userDataDir,directory);
  for(const name of ["home","tmp"])Writable.assertOwnDirectory(directory,path.join(directory,name));
  const prefix=request.prefixDirectory?fs.realpathSync(request.prefixDirectory):path.join(directory,"prefix");
  if(request.prefixDirectory&&(!fs.statSync(prefix).isDirectory()||!fs.existsSync(path.join(prefix,"system.reg"))||!fs.existsSync(path.join(prefix,"user.reg"))))throw Error("The selected Windows GPU environment is incomplete.");
  const helperLibraries=(request.helperLibraries||[]).map(item=>({name:item.name,windows:regular(item.windows),unix:regular(item.unix)}));
  const viewIdentity=digest(JSON.stringify([hostPath,helperLibraries.map(item=>[item.name,digest(fs.readFileSync(item.windows)),digest(fs.readFileSync(item.unix))])])).slice(0,24);
  const settings={graphicsBackend:request.backend==="d3d12"?"d3dmetal":"wined3d",vulkanBackend:request.backend==="vulkan"?"kosmickrisp":"auto",synchronization:"auto",dlss:false,environment:[],windowsVersion:"win10"};
  const graphics=await Graphics.prepareGraphicsView({install,settings,prefixPath:prefix,viewRoot:path.join(directory,"views",viewIdentity),host:{arch:architecture()},executableArchitecture:"x64",helperLibraries,signal});
  if(!request.prefixDirectory)await Launch.ensurePrefix(install,prefix,directory,settings,graphics,context);
  const {environment}=Launch.buildEnvironment(settings,install,directory,prefix,graphics,{baseEnvironment:require("../../../shared/runtime/macos-sandbox").environment(context.environment||process.env)});
  signal?.throwIfAborted();await context.useRuntime?.({managerId:"sikarugir",sectionId:"default",version:install.version,sourcePath:install.installDir});
  return {schema:1,backend:request.backend,executable:graphics.executablePath,arguments:[],environment,hostPath,nativeRoot,originalLibrary,
    ...(originalLibraries?{originalLibraries}:{}),
    resources:{read:[hostPath,...(originalLibraries||[originalLibrary]),...helperLibraries.flatMap(item=>[item.windows,item.unix])],
      codeDirectories:[install.installDir,graphics.viewRoot],writableDirectories:[directory,prefix],
      executables:[graphics.executablePath,path.join(graphics.wineRoot,"lib/wine/x86_64-unix/wine"),graphics.serverPath],runtimeVersion:install.version,ownsPrefix:!request.prefixDirectory}};
}
module.exports={id:"sikarugir-gpu",label:"Sikarugir",backends:["d3d12","vulkan"],getState:state,prepare};
