// Copyright (c) MacLauncher contributors. MIT license.
// Apply only to the owned installation/build copy of the declared collection.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const source=require("./source.json");
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const ownedFiles=["collection-overlay.js","source.json","SceneProjection.fxh"];
function replace(text,before,after){if(text.split(before).length!==2)throw Error("The original shader boundary changed.");return text.replace(before,after);}
function range(text,start,end,replacement){const a=text.indexOf(start),b=text.indexOf(end,a);if(a<0||b<=a||text.indexOf(start,a+start.length)>=0)throw Error("The original shader boundary changed.");return text.slice(0,a)+replacement+text.slice(b);}
function apply(directory,identity){
  if(identity.commit!==source.commit)throw Error("This shader scene binding recipe requires its declared source revision.");
  const original=new Map();for(const[file,expected]of Object.entries(source.files)){
    const target=path.join(directory,file),stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink())throw Error("A shader recipe requires regular original files.");
    const bytes=fs.readFileSync(target);if(hash(bytes)!==expected)throw Error("The original shader source changed: "+file);original.set(file,bytes.toString("utf8").replace(/\r\n/g,"\n"));
  }
  const writes=new Map(),bindings=motion=>`//!SCENE_INPUT MLSceneDepth depth\n//!SCENE_INPUT MLSceneProjection projectionMatrix\n//!SCENE_COORDINATES preserve\n${motion?"//!SCENE_INPUT MLSceneMotion motion\n//!SCENE_HISTORY real\n":""}`;
  let lighting=original.get("Shaders/NGLighting-Shader.fxh");
  lighting=replace(lighting,'#include "ReShade.fxh"','#include "ReShade.fxh"\n#include "MLSceneProjection.fxh"\nuniform bool MLSceneReset < source="scene_reset"; >;');
  lighting=replace(lighting,"#define LDepth ReShade::GetLinearizedDepth","#define LDepth MLSceneDepthNormalized");
  lighting=replace(lighting,"#define FAR_PLANE RESHADE_DEPTH_LINEARIZATION_FAR_PLANE","#define FAR_PLANE MLSceneDepthRange");
  lighting=range(lighting,"#if MV_METHOD==0","texture SSSR_ReflectionTex",`texture MLSceneMotion { Width=BUFFER_WIDTH; Height=BUFFER_HEIGHT; Format=RG16F; };\nsampler MLSceneMotionSampler { Texture=MLSceneMotion; };\nfloat2 sampleMotion(float2 uv){return tex2D(MLSceneMotionSampler,uv).rg;}\n\n`);
  lighting=range(lighting,"float3 UVtoPos(float2 texcoord)\n{","float3 Normal(float2 texcoord)",
    "float3 UVtoPos(float2 uv){return MLScenePosition(uv);}\nfloat3 UVtoPos(float2 uv,float depth){return MLScenePositionAtDepth(uv,depth);}\nfloat2 PostoUV(float3 position){return MLSceneProject(position);}\n\n");
  lighting=replace(lighting,"float4 Current, History; float3 Xvirtual, eyedir; float past_depth;",
    "float4 Current, History=tex2D(sSSSR_FilterTex1,PastUV); float3 Xvirtual, eyedir; float past_depth;");
  lighting=replace(lighting,"HistoryLength.r *= mask;","HistoryLength.r *= MLSceneReset ? 0.0 : mask;");
  lighting=replace(lighting,"FinalColor = lerp(current, chistory, LerpFac);","FinalColor = lerp(current, chistory, MLSceneReset ? 0.0 : LerpFac);");
  writes.set("Shaders/NGLighting-Shader.fxh",lighting);
  writes.set("Shaders/NGLighting.fx",bindings(true)+original.get("Shaders/NGLighting.fx"));
  let ui=original.get("Shaders/NGLightingUI.fxh");
  const fov=/uniform float fov <[\s\S]*?> = 70;/g;if([...ui.matchAll(fov)].length!==1)throw Error("The original camera control changed.");
  ui=ui.replace(fov,"// Projection is supplied by the matching renderer frame.");writes.set("Shaders/NGLightingUI.fxh",ui);
  for(const file of ["Shaders/VolumetricFog.fx","Shaders/Volumetric Fog V2.0.fx"]){
    let text=original.get(file);text=replace(text,'#include "ReShade.fxh"','#include "ReShade.fxh"\n#include "MLSceneProjection.fxh"');
    text=text.replaceAll("ReShade::GetLinearizedDepth","MLSceneDepthNormalized");
    // The original source leaves this loop counter undefined.
    text=text.replaceAll("for(int i; i<8; i++)","for(int i=0; i<8; i++)");
    if(file==="Shaders/VolumetricFog.fx"){
      const control=/uniform bool TemporalAccum <([\s\S]*?)> = 1;/g;
      if([...text.matchAll(control)].length!==1)throw Error("The original fog noise control changed.");
      text=text.replace(control,(_,body)=>"uniform bool TemporalAccum <"+body
        .replace('ui_label = "Temporal Accumulation";','ui_label = "Animate noise";')
        .replace(/ui_tooltip\s*=[\s\S]*?;/,'ui_tooltip = "Varies blur samples over source time without accumulating history.";')+"> = 1;");
    }
    writes.set(file,bindings(false)+text);
  }
  const helper=fs.readFileSync(path.join(__dirname,"SceneProjection.fxh"));
  for(const[file,text]of writes)fs.writeFileSync(path.join(directory,file),text);
  fs.writeFileSync(path.join(directory,"Shaders/MLSceneProjection.fxh"),helper);
  return {version:1,files:Object.fromEntries(ownedFiles.map(file=>[file,hash(fs.readFileSync(path.join(__dirname,file)))])),source:{repository:source.repository,commit:source.commit,license:source.license}};
}
module.exports={apply,ownedFiles,sourceFiles:Object.keys(source.files)};
