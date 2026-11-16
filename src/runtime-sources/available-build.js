'use strict';
const {validateSource,validateBuild}=require('./schema');
// Publisher declarations describe an offer before any payload bytes exist.
// They never stand in for per-file measurements or an executable load set.
function projectAvailableBuild({source,asset,id,version,bytes,provenance={},parent}={}){
 validateSource(source);
 if(!asset?.declares)throw new TypeError('An available build requires the matched asset declaration.');
 return validateBuild({id,source:source.id,kind:source.kind,version,label:source.label,installed:false,measured:false,binaries:[],declares:structuredClone(asset.declares),
  interfaces:{provides:[...(source.interfaces?.provides||[]),...(asset.interfaces?.provides||[])],requires:[...(source.interfaces?.requires||[]),...(asset.interfaces?.requires||[])]},
  ...(asset.reach||source.reach?{reach:structuredClone(asset.reach||source.reach)}:{}),...(parent?{parent}:{}),...(bytes!==undefined?{bytes}:{}),
  ...(source.manager?.engine?{engine:source.manager.engine}:{}),provenance:structuredClone(provenance)});
}
module.exports={projectAvailableBuild};
