// Resolves the installed payload descriptor. Builds record this module; index.js
// adds launch-time file verification.
const fs=require("node:fs"),path=require("node:path");
const Source=require("./source.json"),Native=require("../../../runtime/bundled-native");
function resolve(root,options={}){
  if((options.platform||process.platform)!=="darwin"||!path.isAbsolute(root||"")||!Native.versionAtLeast(options.macOSVersion||Native.systemVersionSync(),Source.minimumMacOS))return null;
  try{
    const directory=fs.realpathSync(path.join(root,"temporal/sgsr2")),descriptor=JSON.parse(fs.readFileSync(path.join(directory,"provider.json"),"utf8"));
    if(descriptor.providerABI!==1||descriptor.complete!==true||descriptor.methods?.join()!=="sgsr2"||descriptor.source?.commit!==Source.commit||descriptor.source?.repository!==Source.repository||descriptor.architectures?.join()!=="arm64,x86_64"||descriptor.resourcePreparation!==1||!Array.isArray(descriptor.files))return null;
    const library=path.join(directory,"libmaclauncher-sgsr2.dylib");
    for(const name of ["libmaclauncher-sgsr2.dylib","sgsr2/convert.metal","sgsr2/convert.json","sgsr2/upscale.metal","sgsr2/upscale.json"])if(!descriptor.files.some(row=>row.path===name)||!fs.statSync(path.join(directory,name)).isFile())return null;
    return {directory,library,descriptor,methods:["sgsr2"],minimumMacOS:Source.minimumMacOS};
  }catch{return null;}
}
module.exports={resolve};
