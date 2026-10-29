// Production operation contracts shared by graph preparation and its catalog.
// Available implementations and device support still come from the selected payload.
const {NEURAL,MODEL_OPERATIONS}=require("./operation-contracts.mjs");
const REDUCTION = Object.freeze(["area", "nearest", "bilinear", "bicubic"]);
const SDR_COLOR_POLICY = Object.freeze({provider:"srgb-sdr",conversion:"local-gpu-island",hdrToneMap:"reinhard",sceneToneMap:"pbr-neutral",restoresSourceEncoding:true,restoresHighlights:false});
const SCRGB_COLOR_POLICY = Object.freeze({provider:"scrgb-linear",conversion:"local-gpu-island",restoresSourceEncoding:true});
function descriptor(method) { return NEURAL[method] || null; }
function neural(node) { return descriptor(typeof node === "string" ? node : node?.method)?.family === "neural"; }
function modelOperation(node,options={}) {
  if(neural(node))return node.method;
  if(node?.kind!=="shader")return null;
  let operation=options.modelOperations?.[node.id]??node.modelOperation;
  if(operation===undefined){
    const pack=require("../reshade/shader-packs").lookup(node.shader?.preset);
    operation=pack?.effect.modelOperation;
    if(operation===undefined)try{
      const selection=require("../reshade").resolveShaderSelection({reshade:node.shader},options);
      operation=selection?.modelOperation||selection?.traits?.modelOperation;
    }catch{return null;} // The shader's own preparation reports invalid sources.
  }
  return MODEL_OPERATIONS[operation]?.kind==="attachment"?operation:null;
}
function resizeDirection(node) { return node?.kind === "downsample" || node?.method === "downsample" ? "downsample" : node?.kind === "upscale" ? "upscale" : "fit"; }
module.exports = {NEURAL, MODEL_OPERATIONS, REDUCTION, SDR_COLOR_POLICY, SCRGB_COLOR_POLICY, descriptor, neural, modelOperation, resizeDirection};
