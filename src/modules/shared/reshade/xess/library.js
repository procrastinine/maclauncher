// Copyright (c) MacLauncher contributors. MIT license.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const Source=require("./source.json"),Writable=require("../../writable-input"),Download=require("../../runtime/download-utils");
const Components=require("./components.json");
const {withRuntimeMutation}=require("../../../../core/coordinated-runtime-managers"),{runDownloadTask}=require("../../runtime/download-manager"),{downloadApproved}=require("../../runtime/tool-install");
const cache=new Map();
function assertVersion(context){const version=context.version&&context.version!=="auto"?context.version:context.settings?.runtimes?.[Source.managerId]?.defaultVersion;if(version&&version!=="auto"&&version!==Source.version)throw Error("The selected Intel SDK version does not match the included XeSS adapter.");}
const fileIdentity=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(":");
function directory(userDataDir){if(!path.isAbsolute(userDataDir||""))throw Error("Launcher data directory is unavailable.");return path.join(userDataDir,"runtimes",Source.managerId,Source.version);}
function read(userDataDir){try{
  const root=directory(userDataDir);Writable.assertOwnDirectory(userDataDir,root,{create:false});const file=path.join(root,"runtime.json"),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)return null;
  const record=JSON.parse(fs.readFileSync(file,"utf8"));if(record.schema!==1||record.version!==Source.version||record.sha256!==Source.sha256||typeof record.external!=="boolean")return null;
  const library=record.external?record.file:path.join(root,Source.file);if(!path.isAbsolute(library||""))return null;const source=fs.lstatSync(library);if(!source.isFile()||source.isSymbolicLink()||source.size!==Source.bytes)return null;
  return {version:Source.version,versionLabel:"Intel XeSS",runtimePath:library,library,sourcePath:library,installDir:root,external:record.external,ready:true,sourceUrl:Source.sourceUrl};
}catch{return null;}}
function readComponents(userDataDir){try{
  const root=directory(userDataDir);Writable.assertOwnDirectory(userDataDir,root,{create:false});
  const file=path.join(root,"interpolation.json"),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)return null;
  const record=JSON.parse(fs.readFileSync(file,"utf8"));
  if(record.schema!==1||record.version!==Source.version||record.commit!==Components.commit||Components.commit!==Source.commit)return null;
  const libraries={};let external=false;
  for(const spec of Components.files){const row=record.files?.[spec.id];if(!row||typeof row.external!=="boolean")return null;const library=row.external?row.file:path.join(root,spec.file);if(!path.isAbsolute(library||""))return null;const item=fs.lstatSync(library);if(!item.isFile()||item.isSymbolicLink()||item.size!==spec.bytes)return null;libraries[spec.id]=library;external||=row.external;}
  return {version:Source.version,versionLabel:"Intel XeSS",operation:"interpolate",library:libraries.frameGeneration,runtimePath:libraries.frameGeneration,sourcePath:libraries.frameGeneration,libraries,installDir:root,external,ready:true,sourceUrl:Source.sourceUrl};
}catch{return null;}}
function listInstalled(userDataDir){if(!userDataDir)return [];const sr=read(userDataDir),fg=readComponents(userDataDir),value=sr||fg;return value?[{...value,capabilities:[...(sr?["superresolution"]:[]),...(fg?["interpolate"]:[])]}]:[];}
async function inspect(file,signal,spec=Source){
  const library=fs.realpathSync(file),stat=fs.lstatSync(library);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==spec.bytes)throw Error("Choose the compatible original Intel XeSS runtime DLL.");
  const identity=fileIdentity(stat),key=library+":"+spec.sha256;if(cache.get(key)!==identity){const hash=crypto.createHash("sha256");for await(const bytes of fs.createReadStream(library,{flags:fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW,signal}))hash.update(bytes);if(hash.digest("hex")!==spec.sha256)throw Error("The XeSS runtime does not match the supported Intel release.");if(fileIdentity(fs.lstatSync(library))!==identity)throw Error("The XeSS runtime changed while being read.");if(cache.size>=32)cache.delete(cache.keys().next().value);cache.set(key,identity);}
  return library;
}
async function resolve(userDataDir,context={}){assertVersion(context);const {signal,useRuntime,operation}=context;const record=operation==="interpolate"?readComponents(userDataDir):read(userDataDir);if(!record)throw Object.assign(new Error("Install or import the Intel XeSS runtime in Graphics."),{code:"GRAPHICS_XESS_RUNTIME_MISSING",managerId:Source.managerId});if(operation==="interpolate"){for(const spec of Components.files)record.libraries[spec.id]=await inspect(record.libraries[spec.id],signal,spec);record.library=record.sourcePath=record.runtimePath=record.libraries.frameGeneration;for(const sourcePath of Object.values(record.libraries))await useRuntime?.({managerId:Source.managerId,sectionId:"interpolation",version:record.version,sourcePath});}else{record.library=await inspect(record.library,signal);await useRuntime?.({managerId:Source.managerId,sectionId:"default",version:record.version,sourcePath:record.library});}return record;}
function receipt(userDataDir,file,external){const root=directory(userDataDir);Writable.assertOwnDirectory(userDataDir,root);const license=fs.readFileSync(path.join(__dirname,Source.licenseFile));if(crypto.createHash("sha256").update(license).digest("hex")!==Source.licenseSha256)throw Error("The XeSS runtime notice changed.");Writable.atomicWrite(path.join(root,Source.licenseFile),license,{root:userDataDir});Writable.atomicWrite(path.join(root,"runtime.json"),JSON.stringify({schema:1,version:Source.version,sha256:Source.sha256,file:external?file:Source.file,external,sourceUrl:Source.sourceUrl}),{root:userDataDir});return read(userDataDir);}
async function importRuntime(context={}){if(context.operation==="interpolate"||fs.statSync(context.runtimePath).isDirectory()||path.basename(context.runtimePath).toLowerCase()==="libxess_fg.dll")return importComponents(context);const file=await inspect(context.runtimePath,context.signal);return withRuntimeMutation({managerId:Source.managerId,sectionId:"default",version:Source.version,sourcePath:file},()=>{
  const root=directory(context.userDataDir),current=read(context.userDataDir);
  if(current&&file===current.library)return current;
  if(file===root||file.startsWith(root+path.sep))throw Error("Choose an original XeSS runtime outside its managed storage.");
  return receipt(context.userDataDir,file,true);
},{userDataDir:context.userDataDir});}
// Downloads need a consent result; explicit manager actions supply their own.
async function install(context={}){
  assertVersion(context);
  if(context.operation==="interpolate")return installComponents(context);
  const present=read(context.userDataDir);if(present)return resolve(context.userDataDir,context);
  if(!await downloadApproved(context,{managerId:Source.managerId,version:Source.version,label:"Intel XeSS runtime",message:"Download Intel XeSS runtime?",detail:"Required for the selected Intel XeSS effect. Download size: "+Math.ceil(Source.bytes/1e6)+" MB.",downloadBytes:Source.bytes,requiresDownload:true,kind:"tool",sourceUrl:Source.sourceUrl,confirmLabel:"Download and Continue"}))return null;
  return runDownloadTask(context.downloads,{managerId:Source.managerId,sectionId:"default",version:Source.version,label:"Intel XeSS runtime",kind:"download",dedupeKey:"xess-runtime:"+context.userDataDir},async task=>{
    const signal=context.signal&&task.signal?AbortSignal.any([context.signal,task.signal]):context.signal||task.signal;
    return withRuntimeMutation({managerId:Source.managerId,sectionId:"default",version:Source.version,sourcePath:path.join(directory(context.userDataDir),Source.file)},async()=>{
      const existing=read(context.userDataDir);if(existing){await inspect(existing.library,signal);return existing;}
      const root=directory(context.userDataDir);Writable.assertOwnDirectory(context.userDataDir,root);const temporary=path.join(root,".download-"+crypto.randomUUID()),limit=new AbortController(),bounded=signal?AbortSignal.any([signal,limit.signal]):limit.signal;let oversized=false;
      try{
        await Download.downloadToFile(Source.url,temporary,{signal:bounded,onProgress:progress=>{if(progress.downloaded>Source.bytes||progress.total>Source.bytes){oversized=true;limit.abort();}task.onProgress?.(progress);}});
        await inspect(temporary,bounded);await fs.promises.rename(temporary,path.join(root,Source.file));return receipt(context.userDataDir,path.join(root,Source.file),false);
      }catch(error){if(oversized&&!signal?.aborted)throw Error("The XeSS runtime download exceeds the supported release size.");throw error;}finally{await fs.promises.rm(temporary,{force:true});}
    },{userDataDir:context.userDataDir});
  },{onProgress:context.onProgress});
}
async function remove(context={}){const record=read(context.userDataDir)||readComponents(context.userDataDir);if(!record)return;return withRuntimeMutation({managerId:Source.managerId,version:record.version},()=>fs.promises.rm(directory(context.userDataDir),{recursive:true,force:true}),{userDataDir:context.userDataDir});}
function componentsReceipt(userDataDir,files,external){
  const root=directory(userDataDir);Writable.assertOwnDirectory(userDataDir,root);
  const license=fs.readFileSync(path.join(__dirname,Source.licenseFile));if(crypto.createHash("sha256").update(license).digest("hex")!==Source.licenseSha256)throw Error("The XeSS runtime notice changed.");
  Writable.atomicWrite(path.join(root,Source.licenseFile),license,{root:userDataDir});
  Writable.atomicWrite(path.join(root,"interpolation.json"),JSON.stringify({schema:1,version:Source.version,commit:Components.commit,files:Object.fromEntries(Components.files.map(spec=>[spec.id,{file:external?files[spec.id]:spec.file,external}]))}),{root:userDataDir});
  return readComponents(userDataDir);
}
async function inspectComponents(input,signal){
  let root=fs.statSync(input).isDirectory()?input:path.dirname(input);
  if(!fs.existsSync(path.join(root,Components.files[0].file))&&fs.existsSync(path.join(root,"bin",Components.files[0].file)))root=path.join(root,"bin");
  const files={};for(const spec of Components.files)files[spec.id]=await inspect(path.join(root,spec.file),signal,spec);return files;
}
async function importComponents(context={}){
  const files=await inspectComponents(context.runtimePath,context.signal),root=directory(context.userDataDir);
  const current=readComponents(context.userDataDir);
  if(current&&Object.keys(files).every(id=>files[id]===current.libraries[id]))return current;
  if(Object.values(files).some(file=>file===root||file.startsWith(root+path.sep)))throw Error("Choose original XeSS files outside their managed storage.");
  return withRuntimeMutation({managerId:Source.managerId,sectionId:"interpolation",version:Source.version,sourcePath:files.frameGeneration},()=>componentsReceipt(context.userDataDir,files,true),{userDataDir:context.userDataDir});
}
async function installComponents(context={}){
  if(readComponents(context.userDataDir))return resolve(context.userDataDir,{...context,operation:"interpolate"});
  // An existing SDK can supply separately verified companions without copying
  // the SDK or granting those files to an unrelated SR host.
  const existing=read(context.userDataDir);
  if(existing?.external){try{return await importComponents({...context,runtimePath:path.dirname(existing.library)});}catch(error){context.signal?.throwIfAborted();if(error.name==="AbortError")throw error;}}
  const bytes=Components.files.reduce((sum,spec)=>sum+spec.bytes,0);
  if(!await downloadApproved(context,{managerId:Source.managerId,version:Source.version,label:Components.label,message:"Download Intel XeSS frame generation?",detail:"Includes the required XeLL runtime. Download size: "+Math.ceil(bytes/1e6)+" MB.",downloadBytes:bytes,requiresDownload:true,kind:"tool",sourceUrl:Source.sourceUrl,confirmLabel:"Download and Continue"}))return null;
  context.signal?.throwIfAborted();
  return runDownloadTask(context.downloads,{managerId:Source.managerId,sectionId:"interpolation",version:Source.version,label:Components.label,kind:"download",dedupeKey:"xess-interpolation:"+context.userDataDir},async task=>{
    const signal=context.signal&&task.signal?AbortSignal.any([context.signal,task.signal]):context.signal||task.signal,root=directory(context.userDataDir);
    return withRuntimeMutation({managerId:Source.managerId,sectionId:"interpolation",version:Source.version,sourcePath:path.join(root,Components.files[0].file)},async()=>{
      if(readComponents(context.userDataDir))return resolve(context.userDataDir,{signal,operation:"interpolate"});
      Writable.assertOwnDirectory(context.userDataDir,root);const files={};let completed=0;
      for(const spec of Components.files){
        signal?.throwIfAborted();const destination=path.join(root,spec.file);
        try{files[spec.id]=await inspect(destination,signal,spec);completed+=spec.bytes;continue;}catch{signal?.throwIfAborted();}
        const temporary=path.join(root,".download-"+crypto.randomUUID()),limit=new AbortController(),bounded=signal?AbortSignal.any([signal,limit.signal]):limit.signal;let oversized=false;
        try{await Download.downloadToFile("https://raw.githubusercontent.com/intel/xess/"+Components.commit+"/bin/"+spec.file,temporary,{signal:bounded,onProgress:progress=>{if(progress.downloaded>spec.bytes||progress.total>spec.bytes){oversized=true;limit.abort();}task.onProgress?.({downloaded:completed+progress.downloaded,total:bytes});}});await inspect(temporary,bounded,spec);await fs.promises.rename(temporary,destination);files[spec.id]=destination;completed+=spec.bytes;}
        catch(error){if(oversized&&!signal?.aborted)throw Error("The XeSS download exceeds the supported release size.");throw error;}
        finally{await fs.promises.rm(temporary,{force:true});}
      }
      return componentsReceipt(context.userDataDir,files,false);
    },{userDataDir:context.userDataDir});
  },{onProgress:context.onProgress});
}
module.exports={Source,Components,directory,listInstalled,inspect,resolve,importRuntime,importComponents,readComponents,install,remove};
