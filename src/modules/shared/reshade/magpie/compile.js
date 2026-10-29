// Copyright (c) MacLauncher contributors. MIT license.
const {FORMAT}=require("./parse");
function passSource(effect,pass){
  const aliases=["#define MF float"];for(let rows=1;rows<=4;rows++){aliases.push(`#define MF${rows} float${rows}`);for(let cols=1;cols<=4;cols++)aliases.push(`#define MF${rows}x${cols} float${rows}x${cols}`);}
  const builtins=`[[vk::binding(0,0)]] cbuffer __MacFXUniforms : register(b0) { uint2 __inputSize; float2 __inputPt; uint2 __outputSize; float2 __outputPt; float2 __scale; uint2 __passOutputSize; ${effect.parameters.map(row=>row.type+" "+row.name+";").join("\n")} };
uint2 GetInputSize(){return __inputSize;} float2 GetInputPt(){return __inputPt;} uint2 GetOutputSize(){return __outputSize;} float2 GetOutputPt(){return __outputPt;} float2 GetScale(){return __scale;}
uint2 Rmp8x8(uint a){return uint2((a>>1u)&7u,((a>>3u)&6u)|(a&1u));}`;
  const resources=[];for(const [index,name]of pass.inputs.entries()){const texture=effect.textures.find(row=>row.name===name),count=FORMAT[texture.format];resources.push(`[[vk::binding(${index},0)]] Texture2D<float${count===1?"":count}> ${name} : register(t${index});`);}
  for(const[index,name]of pass.outputs.entries()){const texture=effect.textures.find(row=>row.name===name),count=FORMAT[texture.format],modifier=texture.format.endsWith("_UNORM")?"unorm ":texture.format.endsWith("_SNORM")?"snorm ":"";resources.push(`[[vk::binding(${index+64},0)]] RWTexture2D<${modifier}float${count===1?"":count}> ${name} : register(u${index});`);}
  for(const[index,sampler]of effect.samplers.entries())resources.push(`[[vk::binding(${index+16},0)]] SamplerState ${sampler.name} : register(s${index+16});`);
  const mulAdd=[];if(effect.uses.includes("MulAdd"))for(let rows=2;rows<=4;rows++)for(let cols=2;cols<=4;cols++){const terms=[];for(let i=rows-1;i>=0;i--)terms.push(i);let expression="a";for(const i of terms)expression=`mad(x[${i}], y[${i}], ${expression})`;mulAdd.push(`MF${cols} MulAdd(MF${rows} x,MF${rows}x${cols} y,MF${cols} a){return ${expression};}`);}
  const defines=[`#define MP_BLOCK_WIDTH ${pass.blockSize[0]}`,`#define MP_BLOCK_HEIGHT ${pass.blockSize[1]}`,...pass.threads.map((value,index)=>`#define MP_NUM_THREADS_${"XYZ"[index]} ${value}`),...(pass.style==="PS"?["#define MP_PS_STYLE"]:[])];
  let entry;if(pass.style==="CS")entry=`[numthreads(${pass.threads.join(",")})] void __macfxEntry(uint3 tid:SV_GroupThreadID,uint3 gid:SV_GroupID){Pass${pass.index}(gid.xy*uint2(MP_BLOCK_WIDTH,MP_BLOCK_HEIGHT),tid);}`;
  else{let call;if(pass.outputs.length===1)call=`${pass.outputs[0]}[pixel]=Pass${pass.index}(pos);`;else{const variables=pass.outputs.map((name,index)=>`float${FORMAT[effect.textures.find(row=>row.name===name).format]===1?"":FORMAT[effect.textures.find(row=>row.name===name).format]} value${index};`).join("\n");call=variables+`Pass${pass.index}(pos,${pass.outputs.map((_,index)=>`value${index}`).join(",")});`+pass.outputs.map((name,index)=>`${name}[pixel]=value${index};`).join("\n");}
    entry=`[numthreads(64,1,1)] void __macfxEntry(uint3 tid:SV_GroupThreadID,uint3 gid:SV_GroupID){uint2 base=gid.xy*16+Rmp8x8(tid.x); [unroll] for(uint corner=0;corner<4;corner++){uint2 pixel=base+uint2((corner==1||corner==2)?8:0,corner>=2?8:0);if(any(pixel>=__passOutputSize))continue;float2 pos=(float2(pixel)+0.5)/float2(__passOutputSize);${call}}}`;
  }
  return [...aliases,...defines,builtins,...resources,...mulAdd,...effect.common,pass.code,entry].join("\n");
}
module.exports={passSource};
