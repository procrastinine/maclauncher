// Data contracts are independent of their selected provider or frame source.
// This module is shared by the launcher and renderer without Node dependencies.
export const SCENE_AOV_INPUTS=Object.freeze(["normal","roughness","resolvedRadiance","resolvedSpecular","diffuseAlbedo","specularAlbedo",
  "noisyDiffuse","noisySpecular","specularHitDistance","denoiseMask","transparency","metallic","hudlessColor","uiColorAlpha"]);
export const SCENE_SHADER_INPUTS=Object.freeze([...SCENE_AOV_INPUTS,"depth","motion","exposure","viewMatrix","projectionMatrix"]);
const FRAME_INPUTS=Object.freeze(["depth","motion","camera","viewMatrix","projectionMatrix","exposure","noisyColor"]);
export const SCENE_INPUTS=Object.freeze([...FRAME_INPUTS,...SCENE_AOV_INPUTS]);
export function sceneInputNames(requirements){
  return SCENE_INPUTS.filter(name=>Array.isArray(requirements)?requirements.includes(name):requirements?.[name]===true||
    SCENE_AOV_INPUTS.includes(name)&&Array.isArray(requirements?.sceneAovs)&&requirements.sceneAovs.includes(name));
}
export function sceneInputRequirements(requirements){
  const names=sceneInputNames(requirements),sceneAovs=SCENE_AOV_INPUTS.filter(name=>names.includes(name));
  return {depth:false,motion:false,...Object.fromEntries(FRAME_INPUTS.filter(name=>names.includes(name)).map(name=>[name,true])),
    ...(sceneAovs.length?{sceneAovs}:{})};
}
export function sceneInputAvailable(name,inputs={}){
  if(SCENE_AOV_INPUTS.includes(name))return inputs?.sceneAovAPI===1&&Array.isArray(inputs.sceneAovs)&&inputs.sceneAovs.includes(name);
  const key=({motion:"motionVectors",camera:"cameraProjection"})[name]||name;
  return inputs?.[key]===true;
}
export function sceneInputLabel(name){
  return ({motion:"motion vectors",camera:"camera",normal:"surface normals",noisyColor:"noisy scene color",uiColorAlpha:"UI color and alpha"})[name]||
    String(name).replace(/([a-z])([A-Z])/g,"$1 $2").toLowerCase();
}
const neuralOperations={
  "mlx-dlss": {family:"neural",kind:"neural",label:"DLSS neural rendering",scale:1,history:"optional-image"},
  "mlx-vsr": {family:"neural",kind:"upscale",label:"RTX VSR",scale:2,history:"none"},
  "mlx-sr-image": {family:"neural",kind:"upscale",label:"DLSS SR image",scale:2,history:"image-sequence"},
  "mlx-sr-scene": {family:"neural",kind:"temporal",label:"DLSS SR scene",scale:2,history:"scene"},
  "mlx-interpolation": {family:"neural",kind:"frame-generation",label:"MLX interpolation",scale:1,history:"image-pair"},
  "realesrgan": {family:"neural",kind:"upscale",label:"Real-ESRGAN",scale:4,history:"none"},
  "realcugan": {family:"neural",kind:"upscale",label:"Real-CUGAN",scale:2,scales:Object.freeze([2,3,4]),history:"none"},
  "nafnet": {family:"neural",kind:"neural",label:"NAFNet",scale:1,history:"none"},
  "rife": {family:"neural",kind:"frame-generation",label:"RIFE",scale:1,history:"image-pair"}
};
export const NEURAL=Object.freeze(Object.fromEntries(Object.entries(neuralOperations).map(([id,operation])=>[id,Object.freeze({...operation,gpuWorkScope:"external-queues"})])));
// Model inputs include auxiliary scalar outputs. Only NEURAL entries replace
// an image or generate timeline output in the graph.
export const MODEL_OPERATIONS=Object.freeze({...NEURAL,
  "depth-anything-v2-small":Object.freeze({family:"neural",kind:"attachment",label:"Depth Anything V2 Small",
    inputDomain:"RGB",outputDomain:"relative-inverse-depth",history:"none",gpuWorkScope:"external-queues"})
});
export const GENERATION=Object.freeze({
  lsfg:Object.freeze({scene:false,camera:false,matrices:false,maximumMultiplier:5,gpuWorkScope:"caller-command-buffer"}),
  "mlx-interpolation":Object.freeze({scene:false,camera:false,matrices:false,maximumMultiplier:5,gpuWorkScope:"external-queues"}),
  rife:Object.freeze({scene:false,camera:false,matrices:false,maximumMultiplier:5,gpuWorkScope:"external-queues"}),
  metalfx:Object.freeze({scene:true,camera:true,matrices:false,maximumMultiplier:2,gpuWorkScope:"caller-command-buffer"}),
  fsr3:Object.freeze({scene:true,camera:true,matrices:false,maximumMultiplier:2,gpuWorkScope:"caller-command-buffer"}),
  xess:Object.freeze({scene:true,camera:false,matrices:true,maximumMultiplier:2,gpuWorkScope:"external-queues"})
});
export const TEMPORAL=Object.freeze({
  metalfx:Object.freeze({camera:false,matrices:false,gpuWorkScope:"caller-command-buffer"}),
  "metalfx-denoised":Object.freeze({camera:false,matrices:true,requires:Object.freeze(["noisyColor","normal","roughness","diffuseAlbedo","specularAlbedo"]),gpuWorkScope:"caller-command-buffer"}),
  fsr2:Object.freeze({camera:true,matrices:false,gpuWorkScope:"caller-command-buffer"}),
  fsr3:Object.freeze({camera:true,matrices:false,gpuWorkScope:"caller-command-buffer"}),
  fsr4:Object.freeze({camera:false,matrices:false,gpuWorkScope:"caller-command-buffer"}),
  asr:Object.freeze({camera:true,matrices:false,gpuWorkScope:"caller-command-buffer"}),
  sgsr2:Object.freeze({camera:true,matrices:false,gpuWorkScope:"caller-command-buffer"}),
  xess:Object.freeze({camera:false,matrices:false,gpuWorkScope:"external-queues"})
});
export function gpuWorkScope(node){
  if(NEURAL[node?.method])return NEURAL[node.method].gpuWorkScope;
  if(node?.kind==="frame-generation")return GENERATION[node.method]?.gpuWorkScope;
  if(node?.kind==="temporal")return TEMPORAL[node.method]?.gpuWorkScope;
  if(["spatial","downsample","upscale"].includes(node?.kind))return node.method?.startsWith("libplacebo:")?"external-queues":"caller-command-buffer";
  return undefined;
}
export function coordinateTransform(node){
  const operation=NEURAL[node?.method];
  return operation&&operation.kind===node.kind&&operation.kind!=="frame-generation"?(operation.scale===1?"identity":"scale"):"unknown";
}
