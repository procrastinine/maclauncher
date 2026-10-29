// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-projection.hlsl"
Texture2D<float> mlRawDepth:register(t0);
RWTexture2D<float> mlLinearDepth:register(u0);
[numthreads(8,8,1)] void CSUnprojectDepth(uint2 pos:SV_DispatchThreadID) {
 if(any(pos>=mlDepthROI.zw))return;uint2 p=pos;
 if((uint(mlJitterSign.w)&1)!=0)p.y=mlDepthROI.w-1-p.y;
 float raw=mlRawDepth.Load(int3(p+mlDepthROI.xy,0));
 float4 view=mlUnproject(float4(mlNDC((float2(pos)+.5)/float2(mlDepthROI.zw)),raw*mlClip.x+mlClip.y,1));
 float depth=view.z/view.w*mlJitterSign.z;
 mlLinearDepth[pos]=(isfinite(depth)&&depth>0)?min(depth,65504.0):65504.0;
}
Texture2D<float4> mlColor:register(t0);Texture2D<float> mlAO:register(t1);
RWTexture2D<float4> mlOutput:register(u0);
[numthreads(8,8,1)] void CSApplyAO(uint2 pos:SV_DispatchThreadID) {
 if(any(pos>=mlDepthROI.zw))return;uint2 ao=pos;
 if((uint(mlJitterSign.w)&1)!=0)ao.y=mlDepthROI.w-1-ao.y;
 float4 color=mlColor.Load(int3(pos,0));float visibility=saturate(mlAO.Load(int3(ao,0)));
 mlOutput[pos]=float4(color.rgb*visibility,color.a);
}
