// Copyright (c) MacLauncher contributors. MIT license.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const Source=require("./source.json"),Components=require("./components.json"),Library=require("./library"),Writable=require("../../writable-input");
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const relative=value=>typeof value==="string"&&value.length<1024&&!value.split("/").some(part=>!part||part==="."||part==="..")&&!/[\\\0\r\n]/.test(value)&&!path.isAbsolute(value);
function resolve(root,options={}){
  try{
    if((options.platform||process.platform)!=="darwin")return null;
    const directory=fs.realpathSync(path.join(root,"xess")),file=path.join(directory,"provider.json"),stat=fs.statSync(file);
    if(!stat.isFile()||stat.size>65536)return null;
    const descriptor=JSON.parse(fs.readFileSync(file,"utf8"));
    if(descriptor.schema!==1||descriptor.providerABI!==1||descriptor.backend!=="d3d12"||descriptor.architecture!=="x86_64"||descriptor.sdk?.commit!==Source.commit||descriptor.sdk?.sha256!==Source.sha256||descriptor.sdk?.bytes!==Source.bytes||!Array.isArray(descriptor.files)||descriptor.files.length>64)return null;
    const backends=descriptor.backends||[descriptor.backend],paths=descriptor.hostPaths||{d3d12:descriptor.hostPath};
    if(!Array.isArray(backends)||!backends.length||new Set(backends).size!==backends.length||backends.some(key=>!["d3d12","vulkan"].includes(key)||!relative(paths[key]))||!relative(descriptor.hostPath)||!relative(descriptor.bridge?.windows)||!relative(descriptor.bridge?.unix)||!/^[a-z][a-z0-9-]{1,63}$/.test(descriptor.bridge?.name||""))return null;
    const inventory=new Map();
    for(const row of descriptor.files){if(!relative(row.path)||inventory.has(row.path)||!Number.isSafeInteger(row.size)||row.size<0||!/^[a-f0-9]{64}$/.test(row.sha256))return null;inventory.set(row.path,row);}
    const generation=descriptor.generation;
    if(generation&&(generation.providerABI!==1||generation.backend!=="d3d12"||generation.operation!=="interpolate"||generation.maxInterpolatedFrames!==1||!relative(generation.hostPath)||JSON.stringify(generation.requires)!==JSON.stringify(["color","depth","motion","viewMatrix","projectionMatrix"])||Components.files.some(row=>{const sdk=generation.sdk?.[row.id];return !sdk||sdk.sha256!==row.sha256||sdk.bytes!==row.bytes||sdk.path!=="bin/"+row.file;})))return null;
    for(const key of [...backends.map(key=>paths[key]),descriptor.bridge.windows,descriptor.bridge.unix,...(generation?[generation.hostPath]:[])]){const row=inventory.get(key),target=path.join(directory,key),item=fs.lstatSync(target);if(!row||!item.isFile()||item.isSymbolicLink()||item.size!==row.size||fs.realpathSync(target)!==target)return null;}
    return {directory,descriptor,backends,hostPaths:Object.fromEntries(backends.map(key=>[key,path.join(directory,paths[key])])),...(generation?{generation:{...generation,hostPath:path.join(directory,generation.hostPath)}}:{}),helperLibraries:[{name:descriptor.bridge.name,windows:path.join(directory,descriptor.bridge.windows),unix:path.join(directory,descriptor.bridge.unix)}],identity:hash(fs.readFileSync(file))};
  }catch{return null;}
}
function hosts(options={}){
  const registry=options.registry||require("../../../registry");
  return (registry.listGraphicsComputeHosts?.()||[]).map(provider=>({provider,state:provider.getState(options)}));
}
function state(root,options={}){
  const operation=options.operation||"superresolution",provider=resolve(root,options),candidates=provider?hosts(options):[];
  const supported=operation==="superresolution"?provider?.backends||[]:operation==="interpolate"&&provider?.generation?[provider.generation.backend]:[];
  const readyBackends=supported.filter(key=>candidates.some(row=>row.state.available&&row.state.backends?.includes(key)));
  const backends=supported.filter(key=>candidates.some(row=>row.state.available&&row.state.backends?.includes(key)||row.state.preparable&&row.state.preparableBackends?.includes(key)));
  const runtime=options.userDataDir&&Library.listInstalled(options.userDataDir).find(row=>row.capabilities?.includes(operation));
  const reason=!provider||!supported.length?"The included graphics processor has no XeSS GPU host for this operation.":!backends.length?"A compatible GPU compute host is required.":null;
  const ready=Boolean(runtime&&readyBackends.length),preparationReason=!runtime?"The Intel XeSS runtime will be prepared.":!readyBackends.length?"The GPU compute host will be prepared.":null;
  return {available:!reason,runtimeInstalled:Boolean(runtime),availableWithoutRuntime:Boolean(backends.length),ready,needsPreparation:!ready,operation,backends,readyBackends,
    ...(reason?{reason}:{}),...(preparationReason?{preparationReason}:{}),managerId:Source.managerId,provider};
}
function reserve({root,directory,launchId,...options}){
  // This is a dormant endpoint, not a running Windows environment. Exact
  // helper resources are prepared only when an enabled scene row needs them.
  if(!resolve(root,options))return null;
  const config=path.join(directory,"xess-host.json");Writable.assertOwnDirectory(options.userDataDir,directory);
  const namespace="org.maclauncher.xess."+hash(String(launchId)).slice(0,24)+".";
  const broker=require("../../runtime/gpu-compute-broker").reserve({userDataDir:options.userDataDir,launchId});
  return {config,namespace,...broker,environment:{RESHADE_XESS_CONFIG:config,RESHADE_XESS_SERVICE_NAMESPACE:namespace,RESHADE_XESS_REQUEST_ROOT:broker.requestRoot,RESHADE_XESS_RECEIPT_ROOT:broker.receiptRoot}};
}
async function prepare(options={}){
  const selected=state(options.root,options);
  if(!selected.available)throw Error(selected.reason);
  const operation=selected.operation;
  const requested=options.backend||"auto",backend=requested==="auto"?selected.readyBackends[0]||selected.backends[0]:requested;
  if(!selected.backends.includes(backend))throw Error("The selected XeSS backend has no compatible GPU compute host.");
  const candidates=hosts(options),host=candidates.find(row=>row.state.available&&row.state.backends?.includes(backend))||
    candidates.find(row=>row.state.preparable&&row.state.preparableBackends?.includes(backend));
  if(!host)throw Object.assign(Error(selected.reason),{code:"GRAPHICS_COMPUTE_HOST_MISSING"});
  let installed;
  try{installed=await Library.resolve(options.userDataDir,options);}
  catch(error){
    // Without a consent adapter the missing runtime is reported, never installed.
    if(error.code!=="GRAPHICS_XESS_RUNTIME_MISSING"||typeof options.confirmRuntimeInstall!=="function")throw error;
    const result=await Library.install(options);
    if(!result)throw Object.assign(Error("XeSS runtime installation canceled."),{name:"AbortError",code:"ABORT_ERR"});
    installed=await Library.resolve(options.userDataDir,options);
  }
  const hostPath=operation==="interpolate"?selected.provider.generation.hostPath:selected.provider.hostPaths[backend];
  const nativeFiles=selected.provider.descriptor.files.filter(row=>[path.relative(selected.provider.directory,hostPath).split(path.sep).join("/"),selected.provider.descriptor.bridge.windows,selected.provider.descriptor.bridge.unix].includes(row.path));
  for(const row of nativeFiles){
    options.signal?.throwIfAborted();if(hash(await fs.promises.readFile(path.join(selected.provider.directory,row.path)))!==row.sha256)throw Error("The XeSS GPU host changed. Reinstall the graphics processor.");
  }
  const originalLibraries=operation==="interpolate"?[installed.libraries.frameGeneration,installed.libraries.latency]:[installed.library];
  const prepared=await host.provider.prepare({backend,hostPath,nativeRoot:selected.provider.directory,originalLibrary:originalLibraries[0],...(operation==="interpolate"?{originalLibraries}:{}),helperLibraries:selected.provider.helperLibraries,...(options.prefixDirectory?{prefixDirectory:options.prefixDirectory}:{})},options);
  options.signal?.throwIfAborted();if(options.isCurrent&&options.isCurrent()!==true)throw Object.assign(Error("The graphics launch changed during XeSS preparation."),{code:"GRAPHICS_LIVE_STALE"});
  const binding=options.xessBinding||reserve({...options,launchId:options.launchId||crypto.randomUUID()});
  if(!binding)throw Error("The XeSS GPU host endpoint is unavailable.");
  // The broker writes the host table of this registration to binding.config.
  // Registration demands the request watcher; a rolled-back publication
  // restores the earlier plan's demand, which stops an idle watcher at once.
  const Broker=require("../../runtime/gpu-compute-broker"),earlier=Broker.demanded(binding);
  Broker.register(binding,prepared,{backend,operation});
  options.publication?.onRollback?.(()=>Broker.demand(binding,earlier));
  return {environment:binding.environment,settings:{xessBackend:requested,xessExecutionBackend:backend,xessIdentity:hash(JSON.stringify([operation,backend,nativeFiles,prepared]))},resources:prepared.resources,binding};
}
module.exports={resolve,state,reserve,prepare,hosts};
