import type {EffectCatalogRow,EffectExtent,ReShadeFilter,VideoEffectNode} from "./types";
import {catalogGroup, defaultShaderExtent, graphicsType, extentEditable, slotExtent, type GraphicsType} from "../../../modules/shared/effects/contracts.mjs";

export function importedShaderImplementation(filter:ReShadeFilter):EffectCatalogRow {
  const modelOperation=filter.modelOperation||filter.traits?.modelOperation;
  const outputContract=filter.outputContract;
  const scale=outputContract?.scale;
  const uniform=typeof scale==="number"?scale:scale?.x===scale?.y?scale?.x:undefined;
  const presetId=filter.presetId||`filter:${filter.id}`;
  const row:EffectCatalogRow={id:filter.implementationId||`shader:${presetId}`,kind:"shader",label:filter.name,group:"Image filters",available:filter.available,reason:filter.reason,
    traits:filter.traits,outputContract,sourceRevision:filter.sourceRevision,
    ...(outputContract?.sizing==="intrinsic"&&uniform?{intrinsicScale:uniform}:{}),
    ...(modelOperation?{modelOperation,runtimeManagerId:"graphics-neural-models"}:{}),
    template:{kind:"shader",enabled:true,shader:{enabled:true,preset:presetId,parameters:null},...(modelOperation?{settings:{modelPath:null}}:{})}};
  const extent=defaultShaderExtent(row);if(extent)Object.assign(row.template,{extent});
  row.group=catalogGroup(row);
  return row;
}

export function editableShaderExtent(choice?:EffectCatalogRow):boolean {
  return extentEditable(choice);
}

/** A previous size survives only while it keeps the shader in the chosen slot. */
export function shaderExtent(choice:EffectCatalogRow,type:GraphicsType,previous?:EffectExtent):EffectExtent|undefined {
  if(!editableShaderExtent(choice))return undefined;
  return previous&&graphicsType({...choice.template,extent:previous},choice)===type?previous:slotExtent(type,choice);
}

export function selectedEffectExtent(node?:VideoEffectNode):EffectExtent|undefined {
  if(!node)return undefined;
  if("extent"in node&&node.extent)return node.extent;
  if(node.kind!=="shader"&&node.kind!=="neural"){
    if(node.outputSize?.width!==undefined)return {width:node.outputSize.width,...(node.outputSize.height!==undefined?{height:node.outputSize.height}:{})};
    if(node.outputSize?.height!==undefined)return {height:node.outputSize.height};
    if(node.presentationScale!==undefined)return {relativeTo:"presentation",factor:node.presentationScale};
    if(node.kind==='spatial'&&typeof node.settings?.spatialMultiplier==='number')return {relativeTo:"input",factor:node.settings.spatialMultiplier};
  }
  return undefined;
}
