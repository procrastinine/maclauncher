// Copyright (c) MacLauncher contributors. MIT license.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const Manager=require("./manager"),Launch=require("./launch"),Loader=require("./graphics-loader");
const Writable=require("../../shared/writable-input"),Rosetta=require("../../shared/runtime/rosetta");
const digest=value=>crypto.createHash("sha256").update(value).digest("hex");
function supports(install){return Boolean(install?.ready&&fs.existsSync(path.join(install.crossoverRoot,"lib64/apple_gptk/wine/x86_64-windows/d3d12.dll")));}
function state({userDataDir,settings}={}){
  const selected=Manager.resolveSelection(null,settings,userDataDir,{version:null});
  const candidates=Manager.core.listInstalled(userDataDir),install=supports(selected.install)?selected.install:candidates.find(supports);
  return {id:"crossover-d3d12",label:"D3D12",backends:["d3d12"],available:Boolean(install),install:install||null,
    ...(install?{}:{reason:"A compatible Windows GPU host is required."})};
}
function regular(file){const canonical=fs.realpathSync(file),stat=fs.statSync(canonical);if(!stat.isFile())throw Error("The Windows GPU helper file is unavailable.");return canonical;}
function sanitized(environment){const allowed=["PATH","HOME","TMPDIR","USER","LOGNAME","SHELL","LANG","LC_ALL","__CF_USER_TEXT_ENCODING"];return Object.fromEntries(allowed.filter(key=>typeof environment[key]==="string").map(key=>[key,environment[key]]));}
async function prepare(request,context={}){
  const {userDataDir,signal}=context;signal?.throwIfAborted();const selected=state(context);
  if(!selected.available)throw Object.assign(new Error(selected.reason),{code:"GRAPHICS_COMPUTE_HOST_MISSING",managerId:"crossover"});
  if(request.backend!=="d3d12")throw Error("This graphics compute host implements D3D12.");
  const install=selected.install;if(install.needsRosetta)await Rosetta.ensure(context);
  const hostPath=regular(request.hostPath),originalLibrary=regular(request.originalLibrary),nativeRoot=fs.realpathSync(request.nativeRoot);
  if(request.originalLibraries&&(!Array.isArray(request.originalLibraries)||!request.originalLibraries.length||request.originalLibraries.length>16))throw Error("The GPU helper library list is invalid.");
  const originalLibraries=request.originalLibraries?.map(regular);
  if(originalLibraries&&(originalLibraries[0]!==originalLibrary||new Set(originalLibraries).size!==originalLibraries.length))throw Error("The GPU helper library identities are invalid.");
  if(!fs.statSync(nativeRoot).isDirectory())throw Error("The graphics compute helper directory is unavailable.");
  const identity=digest(JSON.stringify([1,install.version,"d3d12"]));
  const directory=path.join(userDataDir,"graphics/compute-hosts",identity.slice(0,24));Writable.assertOwnDirectory(userDataDir,directory);
  // Existing user-selected environments are reused in place. Ordinary
  // preparation otherwise owns a reusable environment shared by its helpers.
  const bottlePath=request.prefixDirectory?fs.realpathSync(request.prefixDirectory):path.join(directory,"bottle");
  if(request.prefixDirectory){if(!fs.statSync(bottlePath).isDirectory()||!fs.existsSync(path.join(bottlePath,"system.reg"))||!fs.existsSync(path.join(bottlePath,"cxbottle.conf")))throw Error("The selected Windows GPU environment is incomplete.");}
  else await Launch.ensureBottle(install,bottlePath,directory,{bottleTemplate:"win10_64",graphicsBackend:"d3dmetal"},context);
  const loader=await Loader.prepare(install,directory,{signal,execute:context.execute,helperLibraries:request.helperLibraries||[]});
  const settings={graphicsBackend:"d3dmetal",synchronization:"auto",dlss:false,environment:{}};
  const built=Launch.buildEnvironment(settings,install,directory,bottlePath,{baseEnvironment:sanitized(context.environment||process.env),executableArchitecture:"x86_64"});
  const overrides={...built.overrides,...Loader.environment(loader,built.environment,{installation:install})};
  const wine=path.resolve(path.dirname(loader),"../lib/wine");
  // The helper's unique PE/Unix pair belongs to the primary prepared loader.
  // Keep the selected D3DMetal and ordinary Wine libraries as exact fallbacks.
  overrides.WINEDLLPATH=[path.join(wine,"x86_64-windows"),wine,
    path.join(install.crossoverRoot,"lib64/apple_gptk/wine/x86_64-windows"),path.join(install.crossoverRoot,"lib64/apple_gptk/wine"),
    path.join(install.crossoverRoot,"lib/wine/x86_64-windows"),path.join(install.crossoverRoot,"lib/wine")].join(path.delimiter);
  overrides.WINEDLLOVERRIDES=[built.overrides.WINEDLLOVERRIDES,"d3d12,dxgi=n,b",
    ...(request.helperLibraries||[]).map(row=>row.name+"=b")].filter(Boolean).join(";");
  const environment={...built.environment,...overrides};
  const argumentsList=["--bottle",bottlePath,"--wait-children","--workdir",path.dirname(hostPath),"--env",Launch.wineEnvironmentString(overrides),"--"];
  signal?.throwIfAborted();await context.useRuntime?.({managerId:"crossover",sectionId:"default",version:install.version,sourcePath:install.appPath});
  return {schema:1,executable:install.executablePath,arguments:argumentsList,environment,hostPath,nativeRoot,originalLibrary,
    ...(originalLibraries?{originalLibraries}:{}),
    resources:{read:[hostPath,...(originalLibraries||[originalLibrary]),...(request.helperLibraries||[]).flatMap(row=>[regular(row.windows),regular(row.unix)])],
      codeDirectories:[install.appPath,path.dirname(path.dirname(loader))],writableDirectories:[directory,bottlePath],
      executables:[install.executablePath,loader,install.serverPath],runtimeVersion:install.version,ownsPrefix:!request.prefixDirectory}};
}
module.exports={id:"crossover-d3d12",label:"D3D12",backends:["d3d12"],getState:state,prepare};
