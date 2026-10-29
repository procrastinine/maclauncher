const fs=require("node:fs"),path=require("node:path"),Source=require("./source.json");
function resolve(root,{platform=process.platform,macOSVersion}={}){
 if(platform!=="darwin"||!path.isAbsolute(root||"")||macOSVersion&&!require("../../../runtime/bundled-native").versionAtLeast(macOSVersion,Source.minimumMacOS))return null;
 try{const directory=fs.realpathSync(path.join(root,"generation/fsr3")),descriptor=JSON.parse(fs.readFileSync(path.join(directory,"provider.json"),"utf8"));
  if(descriptor.providerABI!==Source.providerABI||descriptor.commit!==Source.commit||descriptor.complete!==true||descriptor.method!=="fsr3"||descriptor.interfaces?.preparation!==1||descriptor.library!=="libmaclauncher-fsr3-generation.dylib"||descriptor.architectures?.join()!==Source.architectures.join()||descriptor.shaderVariants?.opticalflow!==2||descriptor.shaderVariants?.frameinterpolation!==8||descriptor.shaderPasses?.opticalflow!==7||descriptor.shaderPasses?.frameinterpolation!==11)return null;
  const library=path.join(directory,descriptor.library);if(!fs.statSync(library).isFile())return null;
  for(const effect of Source.effects)if(!fs.statSync(path.join(directory,effect)).isDirectory())return null;
  return {directory,library,descriptor};
 }catch{return null;}
}
function prepare(root,options){const installed=resolve(root,options);if(!installed)throw new Error("The AMD frame-generation provider is unavailable in this graphics runtime.");return {RESHADE_FSR3_GENERATION_LIBRARY:installed.library};}
module.exports={resolve,prepare};
