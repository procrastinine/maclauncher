const fs=require("node:fs"),path=require("node:path");
const Native=require("../../shared/runtime/local-native"),Bundled=require("../../shared/runtime/bundled-native");
const cache=new Map();
function read(executable) {
  const directory=path.resolve(path.dirname(executable),"../.."),file=path.join(path.dirname(directory),"video-runtime.json");
  if(!fs.existsSync(file))return null;
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw Error("The managed video host manifest is invalid.");
  const value=JSON.parse(fs.readFileSync(file,"utf8"));
  if(value.schema!==1||value.id!=="mpv-render"||value.decodedFrameAPI!==1||value.decodedColorAPI!==undefined&&value.decodedColorAPI!==1||value.preparationNotificationAPI!==undefined&&value.preparationNotificationAPI!==1||value.playerScriptsAPI!==undefined&&value.playerScriptsAPI!==1||value.playerInputAPI!==undefined&&value.playerInputAPI!==1||value.osdLayerAPI!==undefined&&value.osdLayerAPI!==1||!Array.isArray(value.images)||value.images.length<2||value.images.length>512||
    !["arm64","x86_64"].includes(value.architecture)||!/^\d+\.\d+(?:\.\d+)?$/.test(value.minimumMacOS||""))throw Error("The managed video host version is invalid.");
  return {directory,file,value};
}
function verify(executable) {
  const host=read(executable);if(!host)return null;
  const root=path.dirname(host.directory),seen=new Set(),identities=[Bundled.fileIdentity(host.file)];
  const files=host.value.images.map(image=>{
    if(!image||typeof image.path!=="string"||path.isAbsolute(image.path)||/[\\\0]/.test(image.path)||image.path.split("/").some(part=>!part||part==="."||part==="..")||
      !/^[a-f0-9]{64}$/.test(image.sha256||"")||seen.has(image.path))throw Error("The managed video image inventory is invalid.");
    seen.add(image.path);const target=path.join(root,image.path),stat=fs.lstatSync(target);
    if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync(target)!==target)throw Error("A managed video image changed.");
    identities.push(Bundled.fileIdentity(target));return {target,sha256:image.sha256};
  });
  if(!files.some(row=>row.target===path.resolve(executable)))throw Error("The video host executable is missing from its inventory.");
  const identity=JSON.stringify(identities);
  if(cache.get(host.file)!==identity){
    for(const item of files)if(Native.hashFile(item.target)!==item.sha256)throw Error("A managed video image checksum changed.");
    if(cache.size>=16)cache.delete(cache.keys().next().value);cache.set(host.file,identity);
  }
  return host.value;
}
module.exports={read,verify};
