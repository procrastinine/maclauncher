// Copyright (c) MacLauncher contributors. MIT license.
// Integration boundary around Intel's original XeGTAO shader functions.
#define VA_SATURATE saturate
#define XE_GTAO_FP32_DEPTHS 1
#define XE_GTAO_USE_HALF_FLOAT_PRECISION 0
#define XE_GTAO_GENERATE_NORMALS_INPLACE 1
#include "XeGTAO.h"
cbuffer GTAOConstantBuffer : register(b0) { GTAOConstants g_GTAOConsts; }
cbuffer MacLauncherScene : register(b1) {
 float4 mlProjection[4]; float4 mlInverse[4];
 float4 mlJitterSign; // canonical top-left jitter xy, view forward sign, physical bottom-left bit0 / projection Y-down bit1
 uint4 mlDepthROI; // actual depth origin xy, current extent zw
 float4 mlClip; // device depth -> projection clip scale/bias, AO strength, projection fast path
}
float4 mlUnproject(float4 clip) {
 return clip.x*mlInverse[0]+clip.y*mlInverse[1]+clip.z*mlInverse[2]+clip.w*mlInverse[3];
}
float2 mlNDC(float2 uv) { bool down=(uint(mlJitterSign.w)&2)!=0;return (uv-mlJitterSign.xy*g_GTAOConsts.ViewportPixelSize)*float2(2,down?2:-2)+float2(-1,down?-1:1); }
float3 mlPosition(float2 uv,float depth) {
 float2 n=mlNDC(uv); float z=depth*mlJitterSign.z;
 float w=z*mlProjection[2].w+mlProjection[3].w;
 float2 b=n*w-z*mlProjection[2].xy-mlProjection[3].xy;
 float2 xy;
 if(mlClip.w!=0) xy=b/float2(mlProjection[0].x,mlProjection[1].y);
 else {
  float a=mlProjection[0].x-n.x*mlProjection[0].w;
  float b0=mlProjection[1].x-n.x*mlProjection[1].w;
  float c=mlProjection[0].y-n.y*mlProjection[0].w;
  float d=mlProjection[1].y-n.y*mlProjection[1].w;
  xy=float2(d*b.x-b0*b.y,a*b.y-c*b.x)/(a*d-b0*c);
 }
 return float3(xy,depth);
}
#include "XeGTAO-metal.hlsli"
SamplerState g_samplerPointClamp : register(s0);
Texture2D<float> g_srcRawDepth : register(t0);
RWTexture2D<float> g_outWorkingDepthMIP0 : register(u0);
RWTexture2D<float> g_outWorkingDepthMIP1 : register(u1);
RWTexture2D<float> g_outWorkingDepthMIP2 : register(u2);
RWTexture2D<float> g_outWorkingDepthMIP3 : register(u3);
RWTexture2D<float> g_outWorkingDepthMIP4 : register(u4);
Texture2D<float> g_srcWorkingDepth : register(t0);
RWTexture2D<uint> g_outWorkingAOTerm : register(u0);
RWTexture2D<unorm float> g_outWorkingEdges : register(u1);
Texture2D<uint> g_srcWorkingAOTerm : register(t0);
Texture2D<float> g_srcWorkingEdges : register(t1);
RWTexture2D<uint> g_outFinalAOTerm : register(u0);
float2 mlNoise(uint2 pos) { uint index=HilbertIndex(pos.x,pos.y); return frac(.5+index*float2(.75487766624669276005,.56984029099805326591)); }
[numthreads(8,8,1)] void CSPrefilterDepths16x16(uint2 pos:SV_DispatchThreadID,uint2 local:SV_GroupThreadID) {
 XeGTAO_PrefilterDepths16x16(pos,local,g_GTAOConsts,g_srcRawDepth,g_samplerPointClamp,g_outWorkingDepthMIP0,g_outWorkingDepthMIP1,g_outWorkingDepthMIP2,g_outWorkingDepthMIP3,g_outWorkingDepthMIP4);
}
#define MAIN(NAME,SLICES,STEPS) [numthreads(8,8,1)] void NAME(uint2 pos:SV_DispatchThreadID) { if(any(pos>=uint2(g_GTAOConsts.ViewportSize)))return; XeGTAO_MainPass(pos,SLICES,STEPS,mlNoise(pos),float3(0,0,-1),g_GTAOConsts,g_srcWorkingDepth,g_samplerPointClamp,g_outWorkingAOTerm,g_outWorkingEdges); }
MAIN(CSGTAOLow,1,2)
MAIN(CSGTAOMedium,2,2)
MAIN(CSGTAOHigh,3,3)
MAIN(CSGTAOUltra,9,3)
[numthreads(8,8,1)] void CSDenoisePass(uint2 pos:SV_DispatchThreadID) {
 pos*=uint2(2,1);if(any(pos>=uint2(g_GTAOConsts.ViewportSize)))return;XeGTAO_Denoise(pos,g_GTAOConsts,g_srcWorkingAOTerm,g_srcWorkingEdges,g_samplerPointClamp,g_outFinalAOTerm,false);
}
[numthreads(8,8,1)] void CSDenoiseLastPass(uint2 pos:SV_DispatchThreadID) {
 pos*=uint2(2,1);if(any(pos>=uint2(g_GTAOConsts.ViewportSize)))return;XeGTAO_Denoise(pos,g_GTAOConsts,g_srcWorkingAOTerm,g_srcWorkingEdges,g_samplerPointClamp,g_outFinalAOTerm,true);
}
// Device-depth texture can be depth-format or float; both compile to a sampled read.
[numthreads(8,8,1)] void CSUnprojectDepth(uint2 pos:SV_DispatchThreadID) {
 if(any(pos>=mlDepthROI.zw))return;uint2 physical=pos;
 if((uint(mlJitterSign.w)&1)!=0)physical.y=mlDepthROI.w-1-physical.y;
 float raw=g_srcRawDepth.Load(int3(physical+mlDepthROI.xy,0));
 float4 p=mlUnproject(float4(mlNDC((pos+.5)*g_GTAOConsts.ViewportPixelSize),raw*mlClip.x+mlClip.y,1));
 float z=p.z/p.w*mlJitterSign.z;
 g_outWorkingDepthMIP0[pos]=(isfinite(z)&&z>0)?min(z,65504.0):65504.0;
}
Texture2D<float4> mlColor : register(t0);Texture2D<uint> mlAO : register(t1);RWTexture2D<float4> mlOutput : register(u0);
[numthreads(8,8,1)] void CSApplyAO(uint2 pos:SV_DispatchThreadID) {
 if(any(pos>=mlDepthROI.zw))return;uint2 aoPos=pos;if((uint(mlJitterSign.w)&1)!=0)aoPos.y=mlDepthROI.w-1-aoPos.y;
 float4 color=mlColor.Load(int3(pos,0));float visibility=saturate(float(mlAO.Load(int3(aoPos,0)))/255.0);
 mlOutput[pos]=float4(color.rgb*lerp(1.0,visibility,mlClip.z),color.a);
}
