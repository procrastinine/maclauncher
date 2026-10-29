const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const PE=require("../streamline/pe-exports"),Profile=require("../catalog").FIDELITYFX_PROFILE;
const Writable=require("../../../shared/writable-input");
const libraries={vk:Profile.library,dx12:"amd_fidelityfx_dx12.dll"};
const ORIGINAL=Profile.original,RECORD=".maclauncher-fidelityfx-vulkan.json";
const hash=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const same=(left,right)=>Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every(row=>right.some(other=>other.name===row.name&&other.ordinal===row.ordinal));
function provider(root){try{
 const record=JSON.parse(fs.readFileSync(path.join(root,"provider.json"),"utf8"));
 if(record.schema!==1||record.profile!==Profile.id||libraries[record.backend]!==record.library)return null;
 const library=path.join(root,record.library);
 if(!same(PE.inspect(library),record.exports)||hash(library)!==record.sha256)return null;
 return {...record,library};
}catch{return null;}}
function inspect(sourcePath,providerRoot){
 const backend=Object.keys(libraries).find(key=>libraries[key].toLowerCase()===path.basename(sourcePath||"").toLowerCase());
 if(!backend)return {available:false,reason:"The original library has no matching FidelityFX API profile."};
 const selected=provider(providerRoot);if(!selected||selected.backend!==backend)return {available:false,reason:"The matching FidelityFX API adapter is unavailable."};
 const exports=PE.inspect(sourcePath);if(!same(exports,selected.sourceExports))return {available:false,reason:"The original FidelityFX export profile is unsupported. Its original route is retained."};
 const sourceSha256=hash(sourcePath);
 if(!selected.referenceSha256||selected.referenceSha256!==sourceSha256||backend==="vk"&&sourceSha256!==Profile.referenceSha256)return {available:false,reason:"The original FidelityFX library does not match the adapter's declared source profile."};
 // Discovery does not install a DLL or claim a native resource route. The
 // owning Wine bridge must supply its exact handle and callback ABI first.
 return {available:false,forwardingReady:backend==="vk"&&selected.originalLibrary===ORIGINAL&&selected.observationAPI===1&&selected.execution?.originalApiForwarding===true&&selected.execution?.originalGpuWorkRetained===true,
   activationReady:false,profile:Profile.id,backend,sourceSha256,provider:selected,
   originalApiForwarding:true,observationAPI:selected.observationAPI===1,nativeVulkanSource:false,nativeSourceDeclared:selected.nativeProducer?.recordedSceneAPI===1,
   reason:"FidelityFX Vulkan ingress requires a matching Wine Vulkan resource and recording bridge."};
}
function paths(gameRoot,relativePath){
 if(!path.isAbsolute(gameRoot||"")||typeof relativePath!=="string"||path.isAbsolute(relativePath)||relativePath.split(/[\\/]/).some(part=>!part||part==="."||part==="..")||path.basename(relativePath).toLowerCase()!==Profile.library)
  throw Error("Choose a FidelityFX Vulkan library inside the private game directory.");
 const target=path.join(gameRoot,relativePath),directory=path.dirname(target);
 Writable.assertOwnDirectory(gameRoot,directory,{create:false});
 return {target,directory,original:path.join(directory,ORIGINAL),record:path.join(directory,RECORD)};
}
function readRecord(file){try{const stat=fs.lstatSync(file);return stat.isFile()&&!stat.isSymbolicLink()&&stat.size<16384?JSON.parse(fs.readFileSync(file,"utf8")):null;}catch{return null;}}
function ownedBackup(files,record){try{const stat=fs.lstatSync(files.original);return stat.isFile()&&!stat.isSymbolicLink()&&hash(files.original)===record.sourceSha256;}catch{return false;}}
function recorded(options){
 const files=paths(options.gameRoot,options.relativePath),record=readRecord(files.record);
 if(record?.schema!==1||record.profile!==Profile.id||record.sourceSha256!==Profile.referenceSha256||!/^[a-f0-9]{64}$/.test(record.proxySha256||""))return null;
 const stat=fs.lstatSync(files.target);if(!stat.isFile()||stat.isSymbolicLink())return null;
 return {...files,...record,currentSha256:hash(files.target)};
}
function ownership(options,expected){
 const value=recorded(options);
 return value&&value.currentSha256===value.proxySha256&&ownedBackup(value,value)&&(!expected||value.sourceSha256===expected.sourceSha256&&(!expected.proxySha256||value.proxySha256===expected.proxySha256))?value:null;
}
function prepare({sourcePath,sourceSha256,proxySha256,providerRoot,gameRoot,relativePath,signal}){
 signal?.throwIfAborted();const selection=inspect(sourcePath,providerRoot);
 if(!selection.forwardingReady||sourceSha256&&sourceSha256!==selection.sourceSha256||proxySha256&&proxySha256!==selection.provider?.sha256)return {...selection,available:false};
 let files;try{files=paths(gameRoot,relativePath);}catch(error){return {available:false,reason:error.message};}
 const previous=readRecord(files.record);let current=fs.existsSync(files.target)?hash(files.target):null;
 if(previous){
  if(!ownership({gameRoot,relativePath}))throw Object.assign(Error("The private FidelityFX library or its original copy changed."),{code:"FIDELITYFX_LIBRARY_CHANGED"});
  if(previous.sourceSha256===selection.sourceSha256&&previous.proxySha256===selection.provider.sha256)return {...selection,available:true,prepared:true,target:files.target};
  restore({gameRoot,relativePath});current=hash(files.target);
 }else if(fs.existsSync(files.original)||fs.existsSync(files.record))return {available:false,reason:"A FidelityFX backup already exists in this game directory."};
 if(current!==selection.sourceSha256)return {available:false,reason:"The private FidelityFX library differs from the selected game source."};
 const temporary=path.join(files.directory,".fidelityfx-"+crypto.randomUUID());let copied=false;
 try{
  // Only the actual selected game library supplies the original. The SDK
  // reference packaged beside the adapter is never used for this copy.
  fs.copyFileSync(sourcePath,files.original,fs.constants.COPYFILE_FICLONE|fs.constants.COPYFILE_EXCL);copied=true;
  if(hash(files.original)!==selection.sourceSha256)throw Error("The original FidelityFX library changed during preparation.");
  fs.copyFileSync(selection.provider.library,temporary,fs.constants.COPYFILE_FICLONE|fs.constants.COPYFILE_EXCL);
  if(hash(temporary)!==selection.provider.sha256)throw Error("The FidelityFX adapter changed during preparation.");
  signal?.throwIfAborted();
  Writable.atomicWrite(files.record,JSON.stringify({schema:1,profile:Profile.id,sourceSha256:selection.sourceSha256,proxySha256:selection.provider.sha256})+"\n",{root:gameRoot});
  fs.renameSync(temporary,files.target);
  return {...selection,available:true,prepared:true,target:files.target};
 }catch(error){if(copied){fs.rmSync(files.original,{force:true});fs.rmSync(files.record,{force:true});}throw error;}
 finally{fs.rmSync(temporary,{force:true});}
}
function restore({gameRoot,relativePath}){
 const files=paths(gameRoot,relativePath),record=readRecord(files.record);if(!record)return false;
 if(record.schema!==1||record.profile!==Profile.id||record.sourceSha256!==Profile.referenceSha256||!/^[a-f0-9]{64}$/.test(record.proxySha256||""))throw Error("The FidelityFX ownership record changed.");
 const stat=fs.lstatSync(files.target),current=stat.isFile()&&!stat.isSymbolicLink()?hash(files.target):null;
 if(current!==record.proxySha256&&current!==record.sourceSha256)throw Object.assign(Error("The private FidelityFX library changed."),{code:"FIDELITYFX_LIBRARY_CHANGED"});
 if(!ownedBackup(files,record))throw Error("The private FidelityFX original copy changed.");
 if(current===record.proxySha256)Writable.atomicCopy(files.original,files.target,{root:gameRoot,preserveTimes:false});
 fs.unlinkSync(files.original);fs.unlinkSync(files.record);return true;
}
module.exports={ORIGINAL,RECORD,provider,inspect,prepare,restore,recorded,ownership};
