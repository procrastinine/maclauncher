const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const { cloneOrCopySync } = require("../../../shared/copy-file");
const PE=require("../streamline/pe-exports"),Profile=require("../catalog").FIDELITYFX_PROFILE;
const Writable=require("../../../shared/writable-input");
// One ownership record per backend beside its library.
const RECORDS={vk:".maclauncher-fidelityfx-vulkan.json",dx12:".maclauncher-fidelityfx-dx12.json"};
const hash=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
// The FidelityFX API's five exports, which the proxy forwards by name.
const apiExports=exports=>Array.isArray(exports)&&exports.length===Profile.exports.length&&Profile.exports.every(name=>exports.some(row=>row.name===name));
const backendOf=file=>Object.keys(Profile.libraries).find(key=>Profile.libraries[key]===path.basename(file||"").toLowerCase());
// The installed package's provider descriptor, with the proxies it holds.
function provider(root){try{
 const record=JSON.parse(fs.readFileSync(path.join(root,"provider.json"),"utf8"));
 if(record.schema!==2||record.profile!==Profile.id||record.temporalFrames!==1)return null;
 const backends={};
 for(const [backend,row] of Object.entries(record.backends||{})){
  if(Profile.libraries[backend]!==row?.library||!/^[a-f0-9]{64}$/.test(row.sha256||""))continue;
  const library=path.join(root,row.library);if(apiExports(PE.inspect(library)))backends[backend]={...row,library};
 }
 return Object.keys(backends).length?{...record,backends}:null;
}catch{return null;}}
// A game's FidelityFX API library and the package's proxy for its backend.
function inspect(sourcePath,providerRoot){
 const backend=backendOf(sourcePath);
 if(!backend)return {available:false,reason:"The library is not a FidelityFX API library."};
 const selected=provider(providerRoot)?.backends[backend];
 if(!selected)return {available:false,backend,reason:"The FidelityFX API adapter has no proxy for this backend."};
 if(!apiExports(PE.inspect(sourcePath)))return {available:false,backend,reason:"The game's FidelityFX library has another export table. Its original route is kept."};
 return {available:true,profile:Profile.id,backend,sourceSha256:hash(sourcePath),provider:selected};
}
function paths(gameRoot,relativePath){
 if(!path.isAbsolute(gameRoot||"")||typeof relativePath!=="string"||path.isAbsolute(relativePath)||relativePath.split(/[\\/]/).some(part=>!part||part==="."||part==="..")||!backendOf(relativePath))
  throw Error("Choose a FidelityFX API library inside the private game directory.");
 const target=path.join(gameRoot,relativePath),directory=path.dirname(target);
 Writable.assertOwnDirectory(gameRoot,directory,{create:false});
 const backend=backendOf(relativePath);
 return {target,directory,original:path.join(directory,Profile.originals[backend]),record:path.join(directory,RECORDS[backend])};
}
function readRecord(file){try{const stat=fs.lstatSync(file);return stat.isFile()&&!stat.isSymbolicLink()&&stat.size<16384?JSON.parse(fs.readFileSync(file,"utf8")):null;}catch{return null;}}
const validRecord=record=>record?.schema===1&&record.profile===Profile.id&&[record.sourceSha256,record.proxySha256].every(value=>/^[a-f0-9]{64}$/.test(value||""));
function ownedBackup(files,record){try{const stat=fs.lstatSync(files.original);return stat.isFile()&&!stat.isSymbolicLink()&&hash(files.original)===record.sourceSha256;}catch{return false;}}
function recorded(options){
 const files=paths(options.gameRoot,options.relativePath),record=readRecord(files.record);
 if(!validRecord(record))return null;
 const stat=fs.lstatSync(files.target);if(!stat.isFile()||stat.isSymbolicLink())return null;
 return {...files,...record,currentSha256:hash(files.target)};
}
function ownership(options,expected){
 const value=recorded(options);
 return value&&value.currentSha256===value.proxySha256&&ownedBackup(value,value)&&(!expected||value.sourceSha256===expected.sourceSha256&&(!expected.proxySha256||value.proxySha256===expected.proxySha256))?value:null;
}
function prepare({sourcePath,sourceSha256,proxySha256,providerRoot,gameRoot,relativePath,signal}){
 signal?.throwIfAborted();const selection=inspect(sourcePath,providerRoot);
 if(!selection.available||sourceSha256&&sourceSha256!==selection.sourceSha256||proxySha256&&proxySha256!==selection.provider.sha256)return {...selection,available:false};
 let files;try{files=paths(gameRoot,relativePath);}catch(error){return {available:false,reason:error.message};}
 const previous=readRecord(files.record);let current=fs.existsSync(files.target)?hash(files.target):null;
 if(previous){
  if(!ownership({gameRoot,relativePath}))throw Object.assign(Error("The private FidelityFX library or its original copy changed."),{code:"FIDELITYFX_LIBRARY_CHANGED"});
  if(previous.sourceSha256===selection.sourceSha256&&previous.proxySha256===selection.provider.sha256)return {...selection,prepared:true,target:files.target};
  restore({gameRoot,relativePath});current=hash(files.target);
 }else if(fs.existsSync(files.original)||fs.existsSync(files.record))return {available:false,reason:"A FidelityFX backup already exists in this game directory."};
 if(current!==selection.sourceSha256)return {available:false,reason:"The private FidelityFX library differs from the selected game source."};
 const temporary=path.join(files.directory,".fidelityfx-"+crypto.randomUUID());let copied=false;
 try{
  // The proxy loads the game's own library under the original's name.
  cloneOrCopySync(sourcePath,files.original,{exclusive:true});copied=true;
  if(hash(files.original)!==selection.sourceSha256)throw Error("The original FidelityFX library changed during preparation.");
  cloneOrCopySync(selection.provider.library,temporary,{exclusive:true});
  if(hash(temporary)!==selection.provider.sha256)throw Error("The FidelityFX adapter changed during preparation.");
  signal?.throwIfAborted();
  Writable.atomicWrite(files.record,JSON.stringify({schema:1,profile:Profile.id,sourceSha256:selection.sourceSha256,proxySha256:selection.provider.sha256})+"\n",{root:gameRoot});
  fs.renameSync(temporary,files.target);
  return {...selection,prepared:true,target:files.target};
 }catch(error){if(copied){fs.rmSync(files.original,{force:true});fs.rmSync(files.record,{force:true});}throw error;}
 finally{fs.rmSync(temporary,{force:true});}
}
function restore({gameRoot,relativePath}){
 const files=paths(gameRoot,relativePath),record=readRecord(files.record);if(!record)return false;
 if(!validRecord(record))throw Error("The FidelityFX ownership record changed.");
 const stat=fs.lstatSync(files.target),current=stat.isFile()&&!stat.isSymbolicLink()?hash(files.target):null;
 if(current!==record.proxySha256&&current!==record.sourceSha256)throw Object.assign(Error("The private FidelityFX library changed."),{code:"FIDELITYFX_LIBRARY_CHANGED"});
 if(!ownedBackup(files,record))throw Error("The private FidelityFX original copy changed.");
 if(current===record.proxySha256)Writable.atomicCopy(files.original,files.target,{root:gameRoot,preserveTimes:false});
 fs.unlinkSync(files.original);fs.unlinkSync(files.record);return true;
}
module.exports={RECORDS,apiExports,backendOf,provider,inspect,prepare,restore,recorded,ownership};
