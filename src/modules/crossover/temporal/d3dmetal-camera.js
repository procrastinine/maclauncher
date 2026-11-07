const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
// Only the selected D3DMetal route requests this matched builtin module pair.
function helper(root){
  try{
    const metadata=require("./streamline").provider(root)?.cameraBridge;
    if(metadata?.name!=="maclauncher-temporal-camera"||metadata.architecture!=="x86_64")return null;
    const result={name:metadata.name};
    for(const[kind,relative]of [["windows",metadata.windows],["unix",metadata.unix]]){
      const expected=(kind==="windows"?"x86_64-windows/":"x86_64-unix/")+metadata.name+(kind==="windows"?".dll":".so");
      if(relative!==expected||!/^[a-f0-9]{64}$/.test(metadata.files?.[relative]||""))return null;
      const file=path.join(root,relative),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024||crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")!==metadata.files[relative])return null;
      result[kind]=file;
    }
    return result;
  }catch{return null;}
}
module.exports={helper};
