// Copyright (c) MacLauncher contributors. MIT license.
const fs=require('node:fs'),path=require('node:path'),Source=require('./source.json');
function resolve(root,{platform=process.platform,hardwareArch=require("../../../runtime/host-capabilities").getHostCapabilities().hardwareArch,macOSVersion}={}){
 if(platform!=='darwin'||hardwareArch!=='arm64'||!path.isAbsolute(root||'')||macOSVersion&&!require('../../../runtime/bundled-native').versionAtLeast(macOSVersion,Source.minimumMacOS))return null;
 try{const directory=path.join(root,'generation/anr'),d=JSON.parse(fs.readFileSync(path.join(directory,'provider.json'),'utf8'));
  if(d.method!=='anr'||d.providerABI!==1||d.complete!==true||d.preparation!==1)return null;
  for(const name of ['libmaclauncher-anr-generation.dylib','helpers.metallib','anr-convert-dxil','anr-verify'])if(!fs.statSync(path.join(directory,name)).isFile())return null;
  return {directory,library:path.join(directory,'libmaclauncher-anr-generation.dylib'),converterTool:path.join(directory,'anr-convert-dxil'),verifyTool:path.join(directory,'anr-verify')};
 }catch{return null;}
}
function descriptor({width,height}={}){
 const supported=!width&&!height||Source.sizes.some(s=>s.width===width&&s.height===height);
 return {id:'anr',label:'Apex Neural Rendering',managerId:Source.managerId,version:Source.version,minimumMacOS:Source.minimumMacOS,architectures:Source.architectures,hardwareArchitectures:["arm64"],multipliers:[2,3,4,5],sizes:Source.sizes.map(({id,width,height})=>({id,width,height})),requires:{depth:true,motion:true,camera:true},sourceUrl:Source.sourceUrl,downloadBytes:Source.bytes,requiresDownload:true,importInputKinds:['directory','file'],importExtensions:['gz'],...(!supported?{reason:'ANR requires an exact 1920×1080, 2560×1440 or 3840×2160 output.'}:{})};
}
module.exports={resolve,descriptor,Source};
