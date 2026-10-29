// Copyright (c) MacLauncher contributors. MIT license.
// Named inputs use actual device depth and the shared row-vector projection.
#ifndef MACLAUNCHER_SCENE_PROJECTION
#define MACLAUNCHER_SCENE_PROJECTION
texture MLSceneDepth { Width=BUFFER_WIDTH; Height=BUFFER_HEIGHT; Format=R32F; };
sampler MLSceneDepthSampler { Texture=MLSceneDepth; MinFilter=POINT; MagFilter=POINT; MipFilter=POINT; };
uniform float4x4 MLSceneProjection;
uniform float MLSceneDepthRange <
    ui_label="Depth range"; ui_type="slider"; ui_min=0.001; ui_max=1000000.0;
    ui_tooltip="View-space distance represented by a normalized shader depth of one.";
> = 1000.0;
float4x4 MLSceneInverseProjection()
{
    float4x4 result=float4x4(0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,
        0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0);
    float divisor=determinant(MLSceneProjection);
    [unroll]for(int row=0;row<4;row++){
        int r0=row==0?1:0,r1=row<2?2:1,r2=row<3?3:2;
        [unroll]for(int column=0;column<4;column++){
            int c0=column==0?1:0,c1=column<2?2:1,c2=column<3?3:2;
            float3x3 minor=float3x3(
                MLSceneProjection[r0][c0],MLSceneProjection[r0][c1],MLSceneProjection[r0][c2],
                MLSceneProjection[r1][c0],MLSceneProjection[r1][c1],MLSceneProjection[r1][c2],
                MLSceneProjection[r2][c0],MLSceneProjection[r2][c1],MLSceneProjection[r2][c2]);
            result[column][row]=determinant(minor)*(((row+column)%2)==0?1.0:-1.0)/divisor;
        }
    }
    return result;
}
float3 MLSceneUnproject(float2 uv,float deviceDepth)
{
    float4 value=mul(float4(uv*2.0-1.0,deviceDepth,1.0),MLSceneInverseProjection());
    float divisor=(value.w<0?-1.0:1.0)*max(abs(value.w),1e-7);
    return value.xyz/divisor;
}
float3 MLSceneAxes()
{
    // An isometric axis reflection preserves the original shader's right/down/
    // positive-forward working coordinates without approximating its camera.
    return float3(MLSceneProjection[0][0]<0?-1.0:1.0,
        MLSceneProjection[1][1]<0?-1.0:1.0,
        MLSceneUnproject(float2(.5,.5),.5).z<0?-1.0:1.0);
}
float MLSceneDepthNormalized(float2 uv)
{
    return saturate(abs(MLSceneUnproject(uv,tex2Dlod(MLSceneDepthSampler,float4(uv,0,0)).r).z)/max(MLSceneDepthRange,0.001));
}
float3 MLScenePosition(float2 uv)
{
    return MLSceneUnproject(uv,tex2Dlod(MLSceneDepthSampler,float4(uv,0,0)).r)*MLSceneAxes();
}
float3 MLScenePositionAtDepth(float2 uv,float normalizedDepth)
{
    float3 a=MLSceneUnproject(uv,.25),b=MLSceneUnproject(uv,.75),axes=MLSceneAxes();
    float delta=b.z-a.z;
    float t=(normalizedDepth*MLSceneDepthRange*axes.z-a.z)/((delta<0?-1.0:1.0)*max(abs(delta),1e-7));
    return lerp(a,b,t)*axes;
}
float2 MLSceneProject(float3 position)
{
    float4 clip=mul(float4(position*MLSceneAxes(),1),MLSceneProjection);
    return clip.xy/((clip.w<0?-1.0:1.0)*max(abs(clip.w),1e-7))*.5+.5;
}
#endif
