// Copyright (c) MacLauncher contributors. MIT license.
#ifndef MACLAUNCHER_SSRT3_INPUTS
#define MACLAUNCHER_SSRT3_INPUTS
texture MLDepth { Width=BUFFER_WIDTH; Height=BUFFER_HEIGHT; Format=R32F; };
texture MLNormal { Width=BUFFER_WIDTH; Height=BUFFER_HEIGHT; Format=RGBA32F; };
texture MLRadiance { Width=BUFFER_WIDTH; Height=BUFFER_HEIGHT; Format=RGBA32F; };
sampler MLDepthSampler { Texture=MLDepth; MinFilter=POINT; MagFilter=POINT; MipFilter=POINT; };
sampler MLNormalSampler { Texture=MLNormal; MinFilter=POINT; MagFilter=POINT; MipFilter=POINT; };
sampler MLRadianceSampler { Texture=MLRadiance; MinFilter=POINT; MagFilter=POINT; MipFilter=POINT; };
texture MLSource : COLOR;
sampler MLSourceSampler { Texture=MLSource; };
uniform float4x4 MLProjection;
uniform float4x4 MLView;
#if ML_SSRT3_SURFACE
texture MLAlbedo { Width=BUFFER_WIDTH; Height=BUFFER_HEIGHT; Format=RGBA32F; };
sampler MLAlbedoSampler { Texture=MLAlbedo; MinFilter=POINT; MagFilter=POINT; MipFilter=POINT; };
#endif
uniform int _RotationCount < ui_label="Slices"; ui_type="slider"; ui_min=1; ui_max=4; > = 2;
uniform int _StepCount < ui_label="Steps per side"; ui_type="slider"; ui_min=1; ui_max=32; > = 12;
uniform float _Radius < ui_label="Radius"; ui_type="slider"; ui_min=0.01; ui_max=25.0; > = 5.0;
uniform float _ExpFactor < ui_label="Sample distribution"; ui_type="slider"; ui_min=1.0; ui_max=3.0; > = 1.0;
uniform bool _JitterSamples < ui_label="Spatial jitter"; > = true;
uniform bool _ScreenSpaceSampling < ui_label="Screen-space radius"; > = false;
uniform float _GIIntensity < ui_label="Indirect light"; ui_type="slider"; ui_min=0.0; ui_max=100.0; > = 10.0;
uniform float _BackfaceLighting < ui_label="Backface light"; ui_type="slider"; ui_min=0.0; ui_max=1.0; > = 0.0;
uniform float _Thickness < ui_label="Surface thickness"; ui_type="slider"; ui_min=0.01; ui_max=10.0; > = 1.0;
// These are the corresponding original spatial settings, without feedback or
// a probe/sky source. Every sample reads the actual full-resolution guides.
static const bool _MipOptimization=false;
static const bool _LinearThickness=false;
static const float _TemporalOffsets=0.0;
static const float _TemporalDirections=0.0;
static const float PI=3.14159265358979323846;
static const float HALF_PI=1.57079632679489661923;
static const int MAX_RAY=32;
static const float4 _ScreenSize=float4(BUFFER_WIDTH,BUFFER_HEIGHT,1.0/BUFFER_WIDTH,1.0/BUFFER_HEIGHT);
static const float4 _ScreenParams=float4(BUFFER_WIDTH,BUFFER_HEIGHT,0.0,0.0);
#define UNITY_LOOP [loop]
#define SAMPLE_TEXTURE2D_X_LOD(image,ignored,uv,lod) tex2Dlod(MLRadianceSampler,float4(uv,0,0))
#define _LightPyramidTexture MLRadiance
#define _HalfProjScale (abs(MLProjection[1][1])*BUFFER_HEIGHT*0.25)
// _LinearThickness is false; the original conditional's far-plane branch is
// deliberately inactive rather than inventing a far distance for this camera.
static const float4 _ProjectionParams=float4(0.0,0.0,1.0,0.0);

float4x4 MLInverseProjection()
{
    float4x4 result=float4x4(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);
    float divisor=determinant(MLProjection);
    [unroll]for(int row=0;row<4;row++){
        int r0=row==0?1:0,r1=row<2?2:1,r2=row<3?3:2;
        [unroll]for(int column=0;column<4;column++){
            int c0=column==0?1:0,c1=column<2?2:1,c2=column<3?3:2;
            float3x3 minor=float3x3(MLProjection[r0][c0],MLProjection[r0][c1],MLProjection[r0][c2],
                MLProjection[r1][c0],MLProjection[r1][c1],MLProjection[r1][c2],
                MLProjection[r2][c0],MLProjection[r2][c1],MLProjection[r2][c2]);
            result[column][row]=determinant(minor)*(((row+column)%2)==0?1.0:-1.0)/divisor;
        }
    }
    return result;
}
float3 MLUnproject(float2 uv,float depth)
{
    float4 p=mul(float4(uv*2.0-1.0,depth,1.0),MLInverseProjection());
    return p.xyz/((p.w<0?-1.0:1.0)*max(abs(p.w),1e-7));
}
float3 MLAxes()
{
    // Isometric axis reflection into the original pass's right/down/forward
    // coordinates. Depth remains the actual camera's device-depth convention.
    return float3(MLProjection[0][0]<0?-1.0:1.0,MLProjection[1][1]<0?-1.0:1.0,
        MLUnproject(float2(.5,.5),.5).z<0?-1.0:1.0);
}
float MLProjectionW(float3 position)
{
    return max(abs(mul(float4(position*MLAxes(),1),MLProjection).w),1e-7);
}
float3 MLViewDirection(float3 position)
{
    // Perspective viewing rays converge; an orthographic camera has a constant
    // view direction. The original perspective convention is otherwise intact.
    return abs(MLProjection[3][3])>1e-7?float3(0,0,-1):normalize(-position);
}
float Luminance(float3 value){return dot(value,float3(.2126,.7152,.0722));}
float3 PositionSSToVS(float2 uv,float lod)
{
    return MLUnproject(uv,tex2Dlod(MLDepthSampler,float4(uv,0,0)).r)*MLAxes();
}
float3 GetNormalPyramidVS(float2 uv,float lod)
{
    float3 world=tex2Dlod(MLNormalSampler,float4(uv,0,0)).xyz;
    return normalize(mul(float4(world,0),MLView).xyz*MLAxes());
}
bool MLBackground(float2 uv)
{
    float a=abs(MLUnproject(float2(.5,.5),0).z),b=abs(MLUnproject(float2(.5,.5),1).z);
    float farDepth=a>b?0.0:1.0;
    return abs(tex2Dlod(MLDepthSampler,float4(uv,0,0)).r-farDepth)<1e-7;
}
void MLVertex(uint id:SV_VertexID,out float4 position:SV_Position,out float2 uv:TEXCOORD)
{
    uv=float2((id<<1)&2,id&2);position=float4(uv*float2(2,-2)+float2(-1,1),0,1);
}
#endif
