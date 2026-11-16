'use strict';
const {validateSource,validateBuild}=require('./schema');
function projectAvailableBuild({source,asset,id,version,bytes,provenance={},parent}={}){
 validateSource(source);
 return validateBuild({id,sourceId:source.id,source:source.id,kind:source.kind,version,label:source.label,installed:false,measured:false,binaries:[],...(asset?.intendedCPU?{intendedCPU:asset.intendedCPU}:{}),...(parent?{parent}:{}),...(bytes!==undefined?{bytes}:{}),provenance:structuredClone(provenance)});
}
module.exports={projectAvailableBuild};
