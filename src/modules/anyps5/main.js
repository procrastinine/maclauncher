const fs=require("node:fs");
const path=require("node:path");
const manifest=require("./manifest.json");
const {detectGame}=require("./detect");
const manager=require("./runtime/manager");
const {gameDirectory,saveDirectory,resolveSaveLocations,resolveProgram,prepareGame,prepareFexGame,applicationIdentity}=require("./prepare");
const {spawnForegroundNativeGame}=require("../shared/runtime/native-focus");
const Vulkan=require("../shared/vulkan");
const Tools=require("./tools");
const Input=require("./input");
const Bundled=require("../shared/runtime/bundled-native");
const Architecture=require("../shared/runtime/architecture");
const TranslatorEnvironment=require("../shared/runtime/translator-environment-launch");
const Writable=require("../shared/writable-input");
const GameIdentity=require("../shared/runtime/game-identity");
const GameData=require("../shared/game-data");
const DockIcon=require("../shared/dock-icon");

// A ready selection carries its measured route, and a listed version its project's; a ready one without a route is
// a converter install, and a version still to be chosen is the FEX package Automatic installs on Apple Silicon.
const routeOf=selected=>selected.route||(!Architecture.requiresRosetta("x64")?"native":selected.ready?"rosetta":"fex");
function cpuRoute(entry,context){
  return routeOf(manager.resolveSelection(entry,context?.settings,context?.userDataDir));
}
const vulkanOptions=route=>({architecture:route==="fex"?"arm64":"x64",preferredBackend:"kosmickrisp"});
// Translator environments of a launch: AnyPS5's own and its Vulkan driver's.
const translatorIds=vulkan=>["anyps5",...(vulkan?.backend?[vulkan.backend]:[])];
function selectedVulkan(context,route){try{return Vulkan.resolve(context,vulkanOptions(route));}catch{return null;}}
const withSettings=(context,payload)=>({...context,runtimeSettings:{...context.runtimeSettings,...payload?.runtimeSettings}});

function launchEnvironment(entry,context,vulkan,directory,input){
  const environment={...(vulkan.backend==="kosmickrisp"?{KK_EMULATION:"performance,-denorm_preserve,-denorm_flush"}:{}),
    APS5_PLAYGO_UNLISTED_CHUNKS:"installed",...process.env,...TranslatorEnvironment.forLaunch(entry,context,translatorIds(vulkan)).values,
    ...Vulkan.environment(vulkan,directory),...input,ANYPS5_VULKAN_LIBRARY:vulkan.library};
  delete environment.ANYPS5_MOUSE_ROUTING;
  return environment;
}
// Both native backends receive the same game identity for their app, menu and Dock.
async function gameIdentity(entry,context,identity){
  let icon=identity.iconFile;
  try {
    const directory=GameData.resolveGameIconsDir(context.userDataDir,entry.gameId);
    Writable.assertOwnDirectory(context.userDataDir,directory);
    icon=await DockIcon.prepare(identity.iconFile,directory,{signal:context.signal});
  } catch(error) {context.signal?.throwIfAborted?.();context.logger?.debug?.("[anyps5] Dock icon: "+error.message);}
  return GameIdentity.environment({...entry,name:identity.title,iconPath:icon},{});
}

module.exports={id:manifest.id,manifest,detectGame,resolveSaveLocations,runtimeManagers:[manager],normalizeRuntimeId:value=>value==="inspection"?value:"anyps5",
  filterRuntimeSupport:entry=>entry.moduleData?.inspectionOnly?["inspection"]:["anyps5"],
  canLaunchRuntime:(runtimeId,entry)=>runtimeId==="anyps5"&&entry.moduleData?.inspectionOnly!==true,
  onImport:(entry,context)=>{entry.defaultSaveDir=saveDirectory(entry,context);},
  onRuntimeChange:(entry,context)=>{entry.defaultSaveDir=saveDirectory(entry,context);},
  resolveGraphicsInputs:(entry,context)=>({architecture:cpuRoute(entry,context||{})==="fex"?"arm64":"x86_64"}),
  ensureRuntime:(entry,context)=>{
    if(entry.moduleData?.inspectionOnly) return null;
    const selected=manager.resolveSelection(entry,context.settings,context.userDataDir);
    return selected.ready?null:{managerId:manager.id,version:selected.version,automatic:selected.automatic,
      ...(selected.discoveryRequired ? {discoveryRequired:true} : {}),installOptions:{}};
  },
  getRuntimeRequirements:(entry,context)=>entry.moduleData?.inspectionOnly?[]:Vulkan.requirements(context,{...vulkanOptions(cpuRoute(entry,context)),required:true}),
  launchRuntime:async(runtimeId,entry,context)=>{
    if(runtimeId!=="anyps5") return null;
    const selected=manager.resolveSelection(entry,context.settings,context.userDataDir),route=routeOf(selected);
    if(!selected.ready) throw new Error(selected.reason);
    const inputRouting=Input.routingEnvironment(context.runtimeSettings,selected.install);
    Bundled.verifyPayload(selected.install.root,selected.install.declaration);
    context.recordRuntimeUse?.({managerId:manager.id,version:selected.version,sectionId:"default",sourcePath:selected.install.installDir});
    const needsRosetta=route==="rosetta";
    if(needsRosetta) await context.ensureRosetta?.();
    const launch=route==="fex"?await prepareFexGame(entry,context,selected.install):await prepareGame(entry,context,selected.install);
    const identity=launch.identity||applicationIdentity(entry,context);
    const input=Input.prepare(entry,context,selected.install),vulkan=Vulkan.resolve(context,vulkanOptions(route));
    if(!vulkan) throw new Error("A compatible "+(route==="fex"?"Apple silicon":"Intel")+" Vulkan runtime is required. Install one in Runtimes.");
    const environment={...launchEnvironment(entry,context,vulkan,launch.directory,input),
      ...await gameIdentity(entry,context,identity),...launch.environment,...inputRouting};
    context.onEntryChange?.({defaultSaveDir:entry.defaultSaveDir,moduleData:entry.moduleData});
    return spawnForegroundNativeGame({context,executablePath:launch.executable,args:launch.args||context.gameArguments||[],needsRosetta,
      options:{cwd:launch.directory,gameArguments:false,env:environment}});
  },
  cleanupGameData:(entry,context)=>{fs.rmSync(gameDirectory(entry,context),{recursive:true,force:true});return true;},
  settingsActions:{listVulkanRuntimes:(payload,context)=>{const merged=withSettings(context,payload);return Vulkan.choices(merged,vulkanOptions(cpuRoute({},merged)));}},
  actions:{runtimeStatus:(entry,_payload,context)=>manager.resolveSelection(entry,context.settings,context.userDataDir),
    listVulkanRuntimes:(entry,payload,context)=>{const merged=withSettings(context,payload);return Vulkan.choices(merged,vulkanOptions(cpuRoute(entry,merged)));},
    listTranslatorEnvironments:(entry,payload,context)=>{const merged=withSettings(context,payload);return {translatorEnvironments:translatorIds(selectedVulkan(merged,cpuRoute(entry||{},merged)))};},
    inspectProgram:Tools.inspectExecutable,inspectPackage:Tools.inspectPackage,decompile:Tools.decompile,revealExport:Tools.revealExport}
};
