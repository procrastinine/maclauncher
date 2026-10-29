// Copyright (c) MacLauncher contributors. MIT license.
// Shared actual-projection boundary; row-major row-vector scene transforms.
cbuffer MacLauncherScene : register(b1) {
 float4 mlProjection[4]; float4 mlInverse[4];
 float4 mlJitterSign; // canonical jitter xy, forward sign, physical-origin/projection flags
 uint4 mlDepthROI; // actual depth origin xy and current color extent zw
 float4 mlClip; // device depth -> clip scale/bias, strength, standard/orthographic flags
}
float4 mlUnproject(float4 clip) {
 return clip.x*mlInverse[0]+clip.y*mlInverse[1]+clip.z*mlInverse[2]+clip.w*mlInverse[3];
}
float2 mlNDC(float2 uv) {
 bool down=(uint(mlJitterSign.w)&2)!=0;
 return (uv-mlJitterSign.xy/float2(mlDepthROI.zw))*float2(2,down?2:-2)+float2(-1,down?-1:1);
}
float3 mlPosition(float2 uv,float depth) {
 float2 n=mlNDC(uv);float z=depth*mlJitterSign.z;
 float w=z*mlProjection[2].w+mlProjection[3].w;
 float2 b=n*w-z*mlProjection[2].xy-mlProjection[3].xy;
 float2 xy;
 if((uint(mlClip.w)&1)!=0)xy=b/float2(mlProjection[0].x,mlProjection[1].y);
 else {
  float a=mlProjection[0].x-n.x*mlProjection[0].w,b0=mlProjection[1].x-n.x*mlProjection[1].w;
  float c=mlProjection[0].y-n.y*mlProjection[0].w,d=mlProjection[1].y-n.y*mlProjection[1].w;
  xy=float2(d*b.x-b0*b.y,a*b.y-c*b.x)/(a*d-b0*c);
 }
 return float3(xy,depth);
}
