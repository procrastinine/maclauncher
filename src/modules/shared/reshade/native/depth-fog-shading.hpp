// Copyright (c) 2017 Lucas Melo. MIT; see depth-effects-MIT.txt.
// Original RetroFog curve, dither and automatic color functions.
#pragma once
namespace macfx {
inline constexpr char depthFogShading[]=R"FOG_MSL(
constant int bayer[64]={0,48,12,60,3,51,15,63,32,16,44,28,35,19,47,31,8,56,4,52,11,59,7,55,40,24,36,20,43,27,39,23,2,50,14,62,1,49,13,61,34,18,46,30,33,17,45,29,10,58,6,54,9,57,5,53,42,26,38,22,41,25,37,21};
float3 depth_fog_rgb(texture2d<float> source,float3 rgb,float d,float2 uv,uint2 logical,constant Options&o){
  d=o.style.y!=0?distance(float2((uv.x-.5)*d*2+.5,d),float2(.5,o.style.x-.45)):abs(d-(o.style.x-.45));float fog=smoothstep(o.fog.z,o.fog.w,d);
  fog*=o.fog.x;if(o.style.z!=0){if(o.style.w>0)fog=rint(fog*o.style.w)/o.style.w;float limit=float(bayer[(logical.x%8)+8*(logical.y%8)]+1)/64;fog=fog<limit?0.f:1.f;}
  float3 fogColor=o.color.rgb;if(o.color.w!=0){constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear);const float2 points[8]={float2(0,0),float2(0,.5),float2(0,1),float2(.5,0),float2(.5,1),float2(1,0),float2(1,.5),float2(1,1)};fogColor=0;for(uint i=0;i<8;i++)fogColor+=source.sample(s,points[i],level(0)).rgb;fogColor/=8;}
  return mix(rgb,fogColor,fog);
}
)FOG_MSL";
}
