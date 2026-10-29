// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-projection.hlsl"
Texture2D<float> mlRawDepth:register(t0);
RWTexture2D<float> mlDepth:register(u0);
RWStructuredBuffer<uint> mlValidity:register(u1);
// Raw actual inverse view distance is near-increasing, without a guessed lens,
// finite far plane or extra quantization at the authored focus distance.
[numthreads(8,8,1)] void CSDepth(uint2 pos:SV_DispatchThreadID) {
 if(any(pos>=mlDepthROI.zw))return;uint2 physical=pos;
 if((uint(mlJitterSign.w)&1)!=0)physical.y=mlDepthROI.w-1-physical.y;
 float raw=mlRawDepth.Load(int3(physical+mlDepthROI.xy,0));
 float4 view=mlUnproject(float4(mlNDC((float2(pos)+.5)/float2(mlDepthROI.zw)),raw*mlClip.x+mlClip.y,1));
 if(!isfinite(raw)||!all(isfinite(view))){uint previous;InterlockedExchange(mlValidity[0],0u,previous);mlDepth[pos]=0;return;}
 float inverse=abs(view.z)>1e-30?abs(view.w/view.z):1e30;
 if(!isfinite(inverse))inverse=1e30;
 mlDepth[pos]=inverse;
}
Texture2D<float4> mlSource:register(t0);Texture2D<float4> mlResult:register(t1);
RWTexture2D<float4> mlOutput:register(u0);
[numthreads(8,8,1)] void CSOrient(uint2 pos:SV_DispatchThreadID) {
 if(any(pos>=mlDepthROI.zw))return;uint2 logical=pos;
 if((uint(mlJitterSign.w)&1)!=0)logical.y=mlDepthROI.w-1-logical.y;
 float4 original=mlSource.Load(int3(logical,0)),result=mlResult.Load(int3(logical,0));
 mlOutput[pos]=mlValidity[0]?float4(result.rgb,original.a):original;
}
