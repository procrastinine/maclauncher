const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const Native=require("../shared/decompilation/native");
const {getUiServices}=require("../shared/ui-services");
const {confirmToolInstall}=require("../shared/runtime/tool-install");
const {throwIfAborted}=require("../shared/runtime/download-utils");
const {inside,readBytes}=require("./detect");
const Package=require("./package");
const {gameDirectory,resolveProgram,unwrapFile}=require("./prepare");
const manager=require("./runtime/manager");
const Bundled=require("../shared/runtime/bundled-native");

function inspectPackage(entry,_payload,context) {
  throwIfAborted(context.signal);
  const file=entry.moduleData?.packagePath;
  if(!path.isAbsolute(file||"")||fs.realpathSync(file)!==fs.realpathSync(entry.gamePath)) throw new Error("The imported PS5 package is unavailable.");
  const report=Package.inspect(file,null,readBytes);
  if(!report) throw new Error("The PS5 package header is invalid.");
  const root=gameDirectory(entry,context);fs.mkdirSync(root,{recursive:true});
  const outputRoot=fs.mkdtempSync(path.join(root,"package-inspection-")),result={...report,outputRoot};
  fs.writeFileSync(path.join(outputRoot,"inspection.json"),JSON.stringify(result,null,2)+"\n");
  entry.moduleData={...entry.moduleData,...report,nativeInspectionRoot:outputRoot};context.onEntryChange?.({moduleData:entry.moduleData});
  return result;
}

function inspectExecutable(entry,_payload,context) {
  throwIfAborted(context.signal);
  const program=resolveProgram(entry),root=gameDirectory(entry,context);fs.mkdirSync(root,{recursive:true});
  const outputRoot=fs.mkdtempSync(path.join(root,"program-inspection-"));
  const result={...program,titleId:entry.moduleData?.titleId,contentVersion:entry.moduleData?.contentVersion,outputRoot};
  const registry=path.join(root,"launch","eboot.registry.json");
  try {
    const stat=fs.lstatSync(registry);
    if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<32*1024*1024) {
      const imports=JSON.parse(fs.readFileSync(registry,"utf8"));
      if(Array.isArray(imports)) { result.importCount=imports.length;fs.copyFileSync(registry,path.join(outputRoot,"imports.json")); }
    }
  } catch(error) { if(error.code!=="ENOENT") {fs.rmSync(outputRoot,{recursive:true,force:true});throw error;} }
  fs.writeFileSync(path.join(outputRoot,"inspection.json"),JSON.stringify(result,null,2)+"\n");
  entry.moduleData={...entry.moduleData,nativeInspectionRoot:outputRoot};context.onEntryChange?.({moduleData:entry.moduleData});return result;
}
async function decompile(entry,payload,context,dependencies={}) {
  throwIfAborted(context.signal);
  if(entry.moduleData?.inspectionOnly) throw new Error(entry.moduleData.inspectionReason||"An unpacked PS5 executable is required for decompilation.");
  const program=resolveProgram(entry);
  let binary=program.executablePath;
  if(program.format==="self") {
    const selectedManager=dependencies.runtimeManager||manager;
    let selected=selectedManager.resolveSelection(entry,context.settings,context.userDataDir);
    if(!selected.ready) {
      await confirmToolInstall(context,{manager:selectedManager,version:selected.version||"latest",requiresDownload:true,detail:"Required to extract the PS5 executable for inspection."});
      await selectedManager.installRuntime({...context,version:selected.version||"latest"});context.onRuntimeStateChange?.();
      selected=selectedManager.resolveSelection(entry,context.settings,context.userDataDir);
    }
    if(!selected.ready) throw new Error(selected.reason);
    Bundled.verifyPayload(selected.install.root,selected.install.declaration);
    const root=gameDirectory(entry,context),directory=path.join(root,"unwrapped");fs.mkdirSync(directory,{recursive:true});
    binary=path.join(directory,crypto.randomUUID()+".elf");unwrapFile(program.executablePath,binary,selected.install);
  }
  return Native.inspect(entry,payload||{},context,{...dependencies,moduleId:"anyps5",resolveInput:()=>binary});
}
function revealExport(entry,_payload,context) {
  const outputRoot=entry.moduleData?.nativeInspectionRoot,root=gameDirectory(entry,context);
  if(!path.isAbsolute(outputRoot||"")||!fs.existsSync(outputRoot)||!inside(fs.realpathSync(root),fs.realpathSync(outputRoot))) throw new Error("No PS5 program export is available.");
  getUiServices(context).shell.showItemInFolder(outputRoot);return {outputRoot};
}
module.exports={inspectExecutable,inspectPackage,decompile,revealExport};
