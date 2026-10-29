// Resolves the installed payload descriptor. Builds record this module; index.js
// adds launch-time file verification.
const fs=require("node:fs"),path=require("node:path");
const Native=require("../../../runtime/bundled-native");
function resolve(root,options={}){
  const Source=require("./source.json");
  if((options.platform||process.platform)!=="darwin"||!path.isAbsolute(root||"")||!Native.versionAtLeast(options.macOSVersion||Native.systemVersionSync(),Source.minimumMacOS))return null;
  try{
    const directory=fs.realpathSync(path.join(root,"temporal/asr")),descriptor=JSON.parse(fs.readFileSync(path.join(directory,"provider.json"),"utf8"));
    if(descriptor.providerABI!==1||descriptor.complete!==true||descriptor.methods?.join()!=="asr"||descriptor.source?.commit!==Source.commit||descriptor.source?.repository!==Source.repository||descriptor.architectures?.join()!=="arm64,x86_64"||descriptor.resourcePreparation!==1||!Array.isArray(descriptor.files))return null;
    const library=path.join(directory,"libmaclauncher-asr.dylib");
    if(!descriptor.files.some(row=>row.path==="libmaclauncher-asr.dylib")||!fs.statSync(library).isFile()||!fs.statSync(path.join(directory,"asr")).isDirectory())return null;
    return {directory,library,descriptor,methods:["asr"],minimumMacOS:Source.minimumMacOS};
  }catch{return null;}
}
module.exports={resolve};
