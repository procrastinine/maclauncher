const fs=require("node:fs");
const manifest=require("./manifest.json");
const {detectGame}=require("./detect");
const manager=require("./runtime/manager");
const {gameDirectory,saveDirectory,prepareGame}=require("./prepare");
const {spawnForegroundNativeGame}=require("../shared/runtime/native-focus");
const Vulkan=require("../shared/vulkan");
const Tools=require("./tools");
const Input=require("./input");
const Bundled=require("../shared/runtime/bundled-native");
const vulkanOptions=Object.freeze({architecture:"x64",preferredBackend:"kosmickrisp"});

module.exports={id:manifest.id,manifest,detectGame,runtimeManagers:[manager],normalizeRuntimeId:value=>value==="inspection"?value:"anyps5",
  filterRuntimeSupport:entry=>entry.moduleData?.inspectionOnly?["inspection"]:["anyps5"],
  canLaunchRuntime:(runtimeId,entry)=>runtimeId==="anyps5"&&entry.moduleData?.inspectionOnly!==true,
  onImport:(entry,context)=>{entry.defaultSaveDir=saveDirectory(entry,context);},
  onRuntimeChange:(entry,context)=>{entry.defaultSaveDir=saveDirectory(entry,context);},
  resolveGraphicsInputs:()=>({architecture:"x86_64"}),
  ensureRuntime:(entry,context)=>{
    if(entry.moduleData?.inspectionOnly) return null;
    const selected=manager.resolveSelection(entry,context.settings,context.userDataDir);
    return selected.ready?null:{managerId:manager.id,version: selected.version, ...(selected.discoveryRequired ? { discoveryRequired: true } : {}),installOptions:{}};
  },
  getRuntimeRequirements:(entry,context)=>entry.moduleData?.inspectionOnly?[]:Vulkan.requirements(context,{...vulkanOptions,required:true}),
  launchRuntime:async(runtimeId,entry,context)=>{
    if(runtimeId!=="anyps5") return null;
    const selected=manager.resolveSelection(entry,context.settings,context.userDataDir);
    if(!selected.ready) throw new Error(selected.reason);
    const inputRouting=Input.routingEnvironment(context.runtimeSettings,selected.install);
    Bundled.verifyPayload(selected.install.root,selected.install.declaration);
    context.recordRuntimeUse?.({managerId:manager.id,version:selected.version,sectionId:"default",sourcePath:selected.install.installDir});
    await context.ensureRosetta?.();
    const launch=await prepareGame(entry,context,selected.install);
    const input=Input.prepare(entry,context,selected.install);
    const vulkan=Vulkan.resolve(context,vulkanOptions);
    if(!vulkan) throw new Error("A compatible Intel Vulkan runtime is required. Install one in Runtimes.");
    const environment={...process.env,...Vulkan.environment(vulkan,launch.directory),...input,ANYPS5_VULKAN_LIBRARY:vulkan.library};
    delete environment.ANYPS5_MOUSE_ROUTING;
    Object.assign(environment,inputRouting);
    context.onEntryChange?.({defaultSaveDir:entry.defaultSaveDir,moduleData:entry.moduleData});
    return spawnForegroundNativeGame({context,executablePath:launch.executable,args:context.gameArguments||[],needsRosetta:true,
      options:{cwd:launch.directory,gameArguments:false,env:environment}});
  },
  cleanupGameData:(entry,context)=>{fs.rmSync(gameDirectory(entry,context),{recursive:true,force:true});return true;},
  settingsActions:{listVulkanRuntimes:(_payload,context)=>Vulkan.choices(context,vulkanOptions)},
  actions:{runtimeStatus:(entry,_payload,context)=>manager.resolveSelection(entry,context.settings,context.userDataDir),
    listVulkanRuntimes:(_entry,_payload,context)=>Vulkan.choices(context,vulkanOptions),
    inspectProgram:Tools.inspectExecutable,inspectPackage:Tools.inspectPackage,decompile:Tools.decompile,revealExport:Tools.revealExport}
};
