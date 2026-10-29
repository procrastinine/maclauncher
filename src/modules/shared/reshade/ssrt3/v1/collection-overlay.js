// Copyright (c) MacLauncher contributors. MIT license.
// Translation is applied to the owned installation copy, never the checkout.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const source=require("./source.json"),ownedFiles=["collection-overlay.js","source.json","SceneInputs.fxh"];
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
function section(text,start,end){const a=text.indexOf(start),b=text.indexOf(end,a);if(a<0||b<=a||text.indexOf(start,a+start.length)>=0)throw Error("The original visibility-bitmask shader boundary changed.");return text.slice(a,b);}
function replace(text,before,after){if(text.split(before).length!==2)throw Error("The original visibility-bitmask shader expression changed.");return text.replace(before,after);}
function apply(directory,identity){
  if(identity.commit!==source.commit)throw Error("This shader recipe requires its declared source revision.");
  const originals=new Map();for(const[file,expected]of Object.entries(source.files)){
    const target=path.join(directory,file),stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink())throw Error("A shader recipe requires regular original files.");
    const bytes=fs.readFileSync(target);if(hash(bytes)!==expected)throw Error("The original shader source changed: "+file);originals.set(file,bytes.toString("utf8").replace(/\r\n/g,"\n"));
  }
  const compute=originals.get("HDRP/Shaders/Resources/SSRTCS.compute");
  let algorithm=section(compute,"inline float SpatialOffsets","// From https://patapom.com/blog/BRDF/PreIntegration/")+
    section(compute,"inline uint ComputeOccludedBitfield","[numthreads(TILE_SIZE,TILE_SIZE,1)]");
  // ReShade FX has no countbits intrinsic. This exact unsigned population count
  // lowers the original operation without changing the 32-sector visibility.
  algorithm=algorithm.replaceAll("countbits(","MLCountBits(");
  algorithm=algorithm.replace(/^inline /gm,"");
  algorithm=replace(algorithm,"fmod(dt, 3.14)","(dt - 3.14 * trunc(dt / 3.14))");
  algorithm=replace(algorithm,"(radius * _HalfProjScale) / posVS.z","(radius * _HalfProjScale) / MLProjectionW(posVS)");
  // A sector starting precisely at the hemisphere endpoint contains no bits;
  // avoid the original backend-dependent shift by 32.
  algorithm=replace(algorithm,"uint currentOccludedBitfield = angleHorizonBitfield << startHorizonInt;","uint currentOccludedBitfield = startHorizonInt < 32 ? angleHorizonBitfield << startHorizonInt : 0;");
  let main=section(compute,"    float3 viewDir = normalize(-posVS);","    float ambientConeAngle");
  main=replace(main,"normalize(-posVS)","MLViewDirection(posVS)");
  let loop=section(compute,"    float ao;","        uint globalOccludedBitfieldCopy");
  loop=replace(loop,"    float ao;","    float ao=0.0;"); // Original accumulator is undefined.
  loop=loop.replace("    float3 fallbackColor = 0;\n","");
  const common=`// Copyright (c) 2024 CDRIN. MIT license; see LICENSE.\n// Original SSRT3 spatial pass; camera/resource translation is owned separately.\n#include "MLSceneInputs.fxh"\nuint MLCountBits(uint v){v=v-((v>>1)&0x55555555);v=(v&0x33333333)+((v>>2)&0x33333333);v=(v+(v>>4))&0x0F0F0F0F;return (v*0x01010101)>>24;}\n${algorithm}\nfloat4 MLFragment(float4 position:SV_Position,float2 uv:TEXCOORD):SV_Target\n{\nfloat4 original=tex2D(MLSourceSampler,uv);\nif(MLBackground(uv))return ${"ML_SSRT3_SURFACE ? original : float4(0,0,0,original.a)"};\nfloat2 inputCoord=floor(uv*_ScreenSize.xy);\nfloat3 posVS=PositionSSToVS(uv,0);\nfloat3 normalVS=GetNormalPyramidVS(uv,0);\n${main}${loop}\n}\ncol=col/float(_RotationCount)*_GIIntensity;\n// Preserve the original HSV value clamp (0..7), without changing hue.\nfloat peak=max(col.r,max(col.g,col.b));col=peak>0?col*(min(peak,7.0)/peak):float3(0,0,0);\n#if ML_SSRT3_SURFACE\n// Additional diffuse contribution; no guessed occlusion map, fog or probes.\nreturn float4(original.rgb+col*tex2D(MLAlbedoSampler,uv).rgb,original.a);\n#else\nreturn float4(col,original.a);\n#endif\n}\ntechnique VisibilityBitmask < ui_label="Visibility bitmask lighting"; > { pass { VertexShader=MLVertex; PixelShader=MLFragment; } }\n`;
  const output=path.join(directory,"Shaders");fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,"MLSSRT3.fxh"),common);
  fs.copyFileSync(path.join(__dirname,"SceneInputs.fxh"),path.join(output,"MLSceneInputs.fxh"));
  const bindings="//! INPUT_POLICY source\n//! SCENE_INPUT MLDepth depth\n//! SCENE_INPUT MLNormal normal\n//! SCENE_INPUT MLRadiance resolvedRadiance\n//! SCENE_INPUT MLProjection projectionMatrix\n//! SCENE_INPUT MLView viewMatrix\n//! SCENE_COORDINATES preserve\n";
  for(const[name,surface]of [["SSRT3_Lighting.fx",0],["SSRT3_Diffuse.fx",1]])fs.writeFileSync(path.join(output,name),bindings+(surface?"//! SCENE_INPUT MLAlbedo diffuseAlbedo\n":"")+`#define ML_SSRT3_SURFACE ${surface}\n#include "MLSSRT3.fxh"\n`);
  // The original remains in its pinned source repository. Only the translated,
  // consumed production shader belongs to this adapted installed collection.
  fs.unlinkSync(path.join(directory,"HDRP/Shaders/Resources/SSRTCS.compute"));
  return {version:1,files:Object.fromEntries(ownedFiles.map(file=>[file,hash(fs.readFileSync(path.join(__dirname,file)))])),source:{repository:source.repository,commit:source.commit,license:source.license}};
}
module.exports={apply,ownedFiles,sourceFiles:Object.keys(source.files)};
