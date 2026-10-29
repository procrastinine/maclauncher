const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const Writable=require("../../../shared/writable-input"),Profile=require("./export-profile"),PE=Profile,Source=require("./source.json");
const ORIGINAL="maclauncher_xess_dx11_original.dll",RECORD=".maclauncher-xess-d3d11.json";
const hash=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((row,index)=>row.name===b[index].name&&row.ordinal===b[index].ordinal);
function provider(root) {
  try {
    const record=JSON.parse(fs.readFileSync(path.join(root,"provider.json"))),library=path.join(root,Source.library),stat=fs.lstatSync(library);
    if(record.schema!==1||record.profile!==Source.profile||record.library!==Source.library||record.sources?.xess?.revision!==Source.xess.revision||record.sources?.dxmt?.revision!==Source.dxmt.revision||!stat.isFile()||stat.isSymbolicLink()||hash(library)!==record.sha256||!same(PE.inspect(library),record.exports))return null;
    return {...record,library};
  }catch{return null;}
}
function inspect(sourcePath,providerRoot) {
  const payload=provider(providerRoot);if(!payload)return {available:false,reason:"The XeSS D3D11 adapter is unavailable."};
  try {
    const exports=PE.inspect(sourcePath);
    if(!exports||!["xessD3D11CreateContext","xessD3D11Init","xessD3D11Execute","xessDestroyContext"].every(name=>exports.some(row=>row.name===name)))return {available:false,reason:"This library does not expose the XeSS D3D11 API."};
    return {available:true,sourcePath,sourceSha256:hash(sourcePath),exports,provider:payload,
      source:"xess",temporal:true,depth:true,motion:true,jitter:true,exposure:true,cameraProjection:false,methods:["metalfx"]};
  }catch{return {available:false,reason:"The XeSS library could not be inspected."};}
}
function paths(gameRoot,relativePath) {
  if(!path.isAbsolute(gameRoot||"")||typeof relativePath!=="string"||path.isAbsolute(relativePath)||relativePath.split(/[\\/]/).some(part=>!part||part==="."||part==="..")||path.basename(relativePath).toLowerCase()!==Source.library)throw Error("Choose a XeSS D3D11 library inside the private game directory.");
  const target=path.join(gameRoot,relativePath),directory=path.dirname(target);Writable.assertOwnDirectory(gameRoot,directory,{create:false});
  return {target,directory,original:path.join(directory,ORIGINAL),record:path.join(directory,RECORD)};
}
function recorded({gameRoot,relativePath}) {
  const files=paths(gameRoot,relativePath);
  try {
    const stat=fs.lstatSync(files.record);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)return null;
    const value=JSON.parse(fs.readFileSync(files.record));if(value.schema!==1||![value.sourceSha256,value.proxySha256,value.templateSha256].every(text=>/^[a-f0-9]{64}$/.test(text||"")))return null;
    const target=fs.lstatSync(files.target);if(!target.isFile()||target.isSymbolicLink())return null;
    return {...files,...value,currentSha256:hash(files.target)};
  }catch{return null;}
}
function ownedBackup(files,value){try{const stat=fs.lstatSync(files.original);return stat.isFile()&&!stat.isSymbolicLink()&&hash(files.original)===value.sourceSha256;}catch{return false;}}
function ownership(options,expected){const value=recorded(options);return value&&value.currentSha256===value.proxySha256&&ownedBackup(value,value)&&(!expected||value.sourceSha256===expected.sourceSha256)?value:null;}
function prepare({sourcePath,sourceSha256,providerRoot,gameRoot,relativePath,signal}) {
  signal?.throwIfAborted();const payload=provider(providerRoot);if(!payload)throw Error("The XeSS D3D11 adapter is unavailable.");
  const files=paths(gameRoot,relativePath),previous=recorded({gameRoot,relativePath});
  let original=files.target;
  if(previous){if(!ownership({gameRoot,relativePath},{sourceSha256}))throw Object.assign(Error("The private XeSS library or its original copy changed."),{code:"XESS_LIBRARY_CHANGED"});original=files.original;}
  else if(fs.existsSync(files.original)||fs.existsSync(files.record))throw Error("A XeSS library backup already exists in this game directory.");
  if(hash(original)!==sourceSha256||hash(sourcePath)!==sourceSha256)throw Error("The XeSS game library changed before preparation.");
  const exports=PE.inspect(original),bytes=Profile.bind(fs.readFileSync(payload.library),exports),proxySha256=crypto.createHash("sha256").update(bytes).digest("hex");
  if(previous?.proxySha256===proxySha256)return {available:true,...previous,provider:payload};
  const temporary=path.join(files.directory,".xess-"+crypto.randomUUID());
  let backed=false,replaced=false;const previousBytes=previous?fs.readFileSync(files.target):null;
  try {
    signal?.throwIfAborted();fs.writeFileSync(temporary,bytes,{flag:"wx",mode:fs.statSync(files.target).mode&0o777});
    if(!previous){fs.renameSync(files.target,files.original);backed=true;}
    fs.renameSync(temporary,files.target);replaced=true;
    const record={schema:1,sourceSha256,templateSha256:payload.sha256,proxySha256,profile:Source.profile,exports};
    Writable.atomicWrite(files.record,JSON.stringify(record,null,2)+"\n",{root:gameRoot});
    return {available:true,...files,...record,provider:payload};
  }catch(error){if(backed){fs.rmSync(files.target,{force:true});fs.renameSync(files.original,files.target);}else if(replaced&&previousBytes)Writable.atomicWrite(files.target,previousBytes,{root:gameRoot});throw error;}
  finally{fs.rmSync(temporary,{force:true});}
}
function restore({gameRoot,relativePath}) {
  const files=paths(gameRoot,relativePath),value=recorded({gameRoot,relativePath});if(!value)return false;
  if(value.currentSha256!==value.proxySha256)throw Object.assign(Error("The private XeSS library changed."),{code:"XESS_LIBRARY_CHANGED"});
  if(!ownedBackup(files,value))throw Error("The original XeSS library changed.");
  fs.renameSync(files.original,files.target);fs.rmSync(files.record);return true;
}
module.exports={ORIGINAL,RECORD,provider,inspect,prepare,restore,recorded,ownership};
