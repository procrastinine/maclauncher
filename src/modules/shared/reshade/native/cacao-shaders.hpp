// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see cacao-MIT.txt.
// Generated original CACAO compute pipeline.
#pragma once
#include <cstddef>
namespace macfx::cacao_shaders {
struct Binding{const char*name;const char*kind;unsigned index;};
struct Shader{const char*name;const char*entry;const char*source;const Binding*bindings;size_t count;unsigned x,y,z;};
inline constexpr Binding bindings0[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_DepthIn","texture",0},{"g_RwDeinterleavedDepth","texture",1},{"g_PointClampSampler","sampler",0}};
inline constexpr const char*source0=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d<float> g_DepthIn [[texture(0)]], texture2d_array<float, access::write> g_RwDeinterleavedDepth [[texture(1)]], sampler g_PointClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    float4 _57 = g_DepthIn.gather(g_PointClampSampler, ((float2(int2(2) * int2(gl_GlobalInvocationID.xy)) + float2(1.0)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferInverseDimensions), int2(0), component::x);
    int _61 = int(gl_GlobalInvocationID.x);
    int _62 = int(gl_GlobalInvocationID.y);
    uint3 _64 = uint3(int3(_61, _62, 0));
    g_RwDeinterleavedDepth.write(float4(_57.w), uint2(_64.xy), uint(_64.z));
    uint3 _68 = uint3(int3(_61, _62, 1));
    g_RwDeinterleavedDepth.write(float4(_57.z), uint2(_68.xy), uint(_68.z));
    uint3 _72 = uint3(int3(_61, _62, 2));
    g_RwDeinterleavedDepth.write(float4(_57.x), uint2(_72.xy), uint(_72.z));
    uint3 _76 = uint3(int3(_61, _62, 3));
    g_RwDeinterleavedDepth.write(float4(_57.y), uint2(_76.xy), uint(_76.z));
}

)CACAO_GPU";
inline constexpr Binding bindings1[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_DepthIn","texture",0},{"g_RwDepthMip0","texture",1},{"g_RwDepthMip1","texture",2},{"g_RwDepthMip2","texture",3},{"g_RwDepthMip3","texture",4},{"g_PointClampSampler","sampler",0}};
inline constexpr const char*source1=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d<float> g_DepthIn [[texture(0)]], texture2d_array<float, access::write> g_RwDepthMip0 [[texture(1)]], texture2d_array<float, access::write> g_RwDepthMip1 [[texture(2)]], texture2d_array<float, access::write> g_RwDepthMip2 [[texture(3)]], texture2d_array<float, access::write> g_RwDepthMip3 [[texture(4)]], sampler g_PointClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<spvUnsafeArray<float, 8>, 8>, 4> s_FFX_CACAO_PrepareDepthsAndMipsBuffer;
    float4 _81 = g_DepthIn.gather(g_PointClampSampler, ((float2(int2(2) * int2(gl_GlobalInvocationID.xy)) + float2(1.0)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferInverseDimensions), int2(0), component::x);
    float _82 = _81.w;
    s_FFX_CACAO_PrepareDepthsAndMipsBuffer[0][gl_LocalInvocationID.x][gl_LocalInvocationID.y] = _82;
    float _86 = _81.z;
    s_FFX_CACAO_PrepareDepthsAndMipsBuffer[1][gl_LocalInvocationID.x][gl_LocalInvocationID.y] = _86;
    float _88 = _81.x;
    s_FFX_CACAO_PrepareDepthsAndMipsBuffer[2][gl_LocalInvocationID.x][gl_LocalInvocationID.y] = _88;
    float _90 = _81.y;
    s_FFX_CACAO_PrepareDepthsAndMipsBuffer[3][gl_LocalInvocationID.x][gl_LocalInvocationID.y] = _90;
    int _94 = int(gl_GlobalInvocationID.x);
    int _95 = int(gl_GlobalInvocationID.y);
    uint3 _97 = uint3(int3(_94, _95, 0));
    g_RwDepthMip0.write(float4(_82), uint2(_97.xy), uint(_97.z));
    uint3 _100 = uint3(int3(_94, _95, 1));
    g_RwDepthMip0.write(float4(_86), uint2(_100.xy), uint(_100.z));
    uint3 _103 = uint3(int3(_94, _95, 2));
    g_RwDepthMip0.write(float4(_88), uint2(_103.xy), uint(_103.z));
    uint3 _106 = uint3(int3(_94, _95, 3));
    g_RwDepthMip0.write(float4(_90), uint2(_106.xy), uint(_106.z));
    uint _108 = gl_LocalInvocationID.y % 2u;
    uint _110 = gl_LocalInvocationID.x % 2u;
    uint _111 = (2u * _108) + _110;
    int2 _114 = int2(int(_110), int(_108));
    uint2 _115 = uint2(_114);
    int2 _117 = int2(gl_LocalInvocationID.xy) - _114;
    uint2 _118 = gl_GlobalInvocationID.xy / uint2(2u);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _119 = _117.x;
    int _120 = _117.y;
    int _123 = _120 + 1;
    int _126 = _119 + 1;
    float4 _131 = float4(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_120], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_123], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_126][_120], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_126][_123]);
    float4 _136 = _131 - float4(precise::min(precise::min(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_120], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_123]), precise::min(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_126][_120], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_126][_123])));
    float4 _140 = fast::clamp(((_136 * _136) * (-1.0)) + float4(1.0), float4(0.0), float4(1.0));
    float _143 = dot(_140, _131) / dot(_140, float4(1.0));
    int _144 = int(_111);
    uint3 _150 = uint3(int3(int(_118.x), int(_118.y), _144));
    g_RwDepthMip1.write(float4(_143), uint2(_150.xy), uint(_150.z));
    s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_120] = _143;
    uint _153 = _115.x;
    bool _160;
    if ((gl_LocalInvocationID.x % 4u) == _153)
    {
        _160 = (gl_LocalInvocationID.y % 4u) == _115.y;
    }
    else
    {
        _160 = false;
    }
    uint2 _161 = _118 / uint2(2u);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (_160)
    {
        int _165 = _120 + 2;
        int _168 = _119 + 2;
        float4 _173 = float4(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_120], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_165], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_168][_120], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_168][_165]);
        float4 _178 = _173 - float4(precise::min(precise::min(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_120], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_165]), precise::min(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_168][_120], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_168][_165])));
        float4 _182 = fast::clamp(((_178 * _178) * (-1.0)) + float4(1.0), float4(0.0), float4(1.0));
        float _185 = dot(_182, _173) / dot(_182, float4(1.0));
        uint3 _191 = uint3(int3(int(_161.x), int(_161.y), _144));
        g_RwDepthMip2.write(float4(_185), uint2(_191.xy), uint(_191.z));
        s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_120] = _185;
    }
    bool _200;
    if ((gl_LocalInvocationID.x % 8u) == _153)
    {
        _200 = (gl_LocalInvocationID.y % 8u) == _115.y;
    }
    else
    {
        _200 = false;
    }
    uint2 _201 = _161 / uint2(2u);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (_200)
    {
        int _205 = _120 + 4;
        int _208 = _119 + 4;
        float4 _213 = float4(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_120], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_205], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_208][_120], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_208][_205]);
        float4 _218 = _213 - float4(precise::min(precise::min(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_120], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_119][_205]), precise::min(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_208][_120], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_111][_208][_205])));
        float4 _222 = fast::clamp(((_218 * _218) * (-1.0)) + float4(1.0), float4(0.0), float4(1.0));
        uint3 _231 = uint3(int3(int(_201.x), int(_201.y), _144));
        g_RwDepthMip3.write(float4(dot(_222, _213) / dot(_222, float4(1.0))), uint2(_231.xy), uint(_231.z));
    }
}

)CACAO_GPU";
inline constexpr Binding bindings2[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_DepthIn","texture",0},{"g_RwDeinterleavedDepth","texture",1}};
inline constexpr const char*source2=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d<float> g_DepthIn [[texture(0)]], texture2d_array<float, access::write> g_RwDeinterleavedDepth [[texture(1)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    uint _43 = 2u * gl_GlobalInvocationID.x;
    uint _46 = 2u * gl_GlobalInvocationID.y;
    int2 _52 = int2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferDimensions) - int2(1);
    int _74 = int(gl_GlobalInvocationID.x);
    int _75 = int(gl_GlobalInvocationID.y);
    uint3 _77 = uint3(int3(_74, _75, 0));
    g_RwDeinterleavedDepth.write(float4(g_DepthIn.read(uint2(int3(clamp(int2(int(_43), int(_46)), int2(0), _52), 0).xy), 0).x), uint2(_77.xy), uint(_77.z));
    uint3 _80 = uint3(int3(_74, _75, 3));
    g_RwDeinterleavedDepth.write(float4(g_DepthIn.read(uint2(int3(clamp(int2(int(_43 + 1u), int(_46 + 1u)), int2(0), _52), 0).xy), 0).x), uint2(_80.xy), uint(_80.z));
}

)CACAO_GPU";
inline constexpr Binding bindings3[]={{"SSAOConstantsBuffer_t","buffer",0},{"MacLauncherScene","buffer",1},{"g_DepthIn","texture",0},{"g_RwDeinterleavedNormals","texture",1},{"g_PointClampSampler","sampler",0}};
inline constexpr const char*source3=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

struct type_MacLauncherScene
{
    float4 mlProjection[4];
    float4 mlInverse[4];
    float4 mlJitterSign;
    uint4 mlDepthROI;
    float4 mlClip;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], constant type_MacLauncherScene& MacLauncherScene [[buffer(1)]], texture2d<float> g_DepthIn [[texture(0)]], texture2d_array<float, access::write> g_RwDeinterleavedNormals [[texture(1)]], sampler g_PointClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    float2 _99 = float2((int2(2) * int2(gl_GlobalInvocationID.xy)) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferOffset) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferInverseDimensions;
    float4 _103 = g_DepthIn.gather(g_PointClampSampler, _99, int2(0), component::x);
    float4 _107 = g_DepthIn.gather(g_PointClampSampler, _99, int2(2, 0), component::x);
    float4 _111 = g_DepthIn.gather(g_PointClampSampler, _99, int2(0, 2), component::x);
    float4 _115 = g_DepthIn.gather(g_PointClampSampler, _99, int2(2), component::x);
    float _116 = _103.z;
    float _117 = _107.w;
    float _118 = _103.x;
    float _119 = _103.y;
    float _120 = _107.x;
    float _121 = _107.y;
    float _122 = _111.w;
    float _123 = _111.z;
    float _124 = _115.w;
    float _125 = _115.z;
    float _126 = _111.y;
    float _127 = _115.x;
    float2 _143 = ((float2(uint2(2u) * gl_GlobalInvocationID.xy) + float2(0.5)) + float2((((_103.w + _107.z) + _111.x) + _115.y) * 9.9999996826552253889678874634872e-21)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions;
    bool _151 = (uint(MacLauncherScene.mlJitterSign.w) & 2u) != 0u;
    float2 _158 = MacLauncherScene.mlJitterSign.xy / float2(MacLauncherScene.mlDepthROI.zw);
    float2 _162 = float2(2.0, float(_151 ? 2 : (-2)));
    float2 _166 = float2(-1.0, float(_151 ? (-1) : 1));
    float2 _167 = (((_143 + (float2(0.0, -1.0) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions)) - _158) * _162) + _166;
    float _170 = _116 * MacLauncherScene.mlJitterSign.z;
    float2 _186 = ((_167 * ((_170 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _170)) - MacLauncherScene.mlProjection[3].xy;
    bool _191 = (uint(MacLauncherScene.mlClip.w) & 1u) != 0u;
    float2 _237;
    if (_191)
    {
        _237 = _186 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _203 = _167.x;
        float _207 = MacLauncherScene.mlProjection[0].x - (_203 * MacLauncherScene.mlProjection[0].w);
        float _213 = MacLauncherScene.mlProjection[1].x - (_203 * MacLauncherScene.mlProjection[1].w);
        float _216 = _167.y;
        float _218 = MacLauncherScene.mlProjection[0].y - (_216 * MacLauncherScene.mlProjection[0].w);
        float _222 = MacLauncherScene.mlProjection[1].y - (_216 * MacLauncherScene.mlProjection[1].w);
        float _223 = _186.x;
        float _225 = _186.y;
        _237 = float2((_222 * _223) - (_213 * _225), (_207 * _225) - (_218 * _223)) / float2((_207 * _222) - (_213 * _218));
    }
    float2 _245 = (((_143 + (float2(1.0, -1.0) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions)) - _158) * _162) + _166;
    float _246 = _117 * MacLauncherScene.mlJitterSign.z;
    float2 _252 = ((_245 * ((_246 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _246)) - MacLauncherScene.mlProjection[3].xy;
    float2 _298;
    if (_191)
    {
        _298 = _252 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _264 = _245.x;
        float _268 = MacLauncherScene.mlProjection[0].x - (_264 * MacLauncherScene.mlProjection[0].w);
        float _274 = MacLauncherScene.mlProjection[1].x - (_264 * MacLauncherScene.mlProjection[1].w);
        float _277 = _245.y;
        float _279 = MacLauncherScene.mlProjection[0].y - (_277 * MacLauncherScene.mlProjection[0].w);
        float _283 = MacLauncherScene.mlProjection[1].y - (_277 * MacLauncherScene.mlProjection[1].w);
        float _284 = _252.x;
        float _286 = _252.y;
        _298 = float2((_283 * _284) - (_274 * _286), (_268 * _286) - (_279 * _284)) / float2((_268 * _283) - (_274 * _279));
    }
    float2 _306 = (((_143 + (float2(-1.0, 0.0) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions)) - _158) * _162) + _166;
    float _307 = _118 * MacLauncherScene.mlJitterSign.z;
    float2 _313 = ((_306 * ((_307 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _307)) - MacLauncherScene.mlProjection[3].xy;
    float2 _359;
    if (_191)
    {
        _359 = _313 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _325 = _306.x;
        float _329 = MacLauncherScene.mlProjection[0].x - (_325 * MacLauncherScene.mlProjection[0].w);
        float _335 = MacLauncherScene.mlProjection[1].x - (_325 * MacLauncherScene.mlProjection[1].w);
        float _338 = _306.y;
        float _340 = MacLauncherScene.mlProjection[0].y - (_338 * MacLauncherScene.mlProjection[0].w);
        float _344 = MacLauncherScene.mlProjection[1].y - (_338 * MacLauncherScene.mlProjection[1].w);
        float _345 = _313.x;
        float _347 = _313.y;
        _359 = float2((_344 * _345) - (_335 * _347), (_329 * _347) - (_340 * _345)) / float2((_329 * _344) - (_335 * _340));
    }
    float2 _365 = ((_143 - _158) * _162) + _166;
    float _366 = _119 * MacLauncherScene.mlJitterSign.z;
    float2 _372 = ((_365 * ((_366 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _366)) - MacLauncherScene.mlProjection[3].xy;
    float2 _418;
    if (_191)
    {
        _418 = _372 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _384 = _365.x;
        float _388 = MacLauncherScene.mlProjection[0].x - (_384 * MacLauncherScene.mlProjection[0].w);
        float _394 = MacLauncherScene.mlProjection[1].x - (_384 * MacLauncherScene.mlProjection[1].w);
        float _397 = _365.y;
        float _399 = MacLauncherScene.mlProjection[0].y - (_397 * MacLauncherScene.mlProjection[0].w);
        float _403 = MacLauncherScene.mlProjection[1].y - (_397 * MacLauncherScene.mlProjection[1].w);
        float _404 = _372.x;
        float _406 = _372.y;
        _418 = float2((_403 * _404) - (_394 * _406), (_388 * _406) - (_399 * _404)) / float2((_388 * _403) - (_394 * _399));
    }
    float3 _421 = float3(_418, _119);
    float2 _426 = (((_143 + (float2(1.0, 0.0) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions)) - _158) * _162) + _166;
    float _427 = _120 * MacLauncherScene.mlJitterSign.z;
    float2 _433 = ((_426 * ((_427 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _427)) - MacLauncherScene.mlProjection[3].xy;
    float2 _479;
    if (_191)
    {
        _479 = _433 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _445 = _426.x;
        float _449 = MacLauncherScene.mlProjection[0].x - (_445 * MacLauncherScene.mlProjection[0].w);
        float _455 = MacLauncherScene.mlProjection[1].x - (_445 * MacLauncherScene.mlProjection[1].w);
        float _458 = _426.y;
        float _460 = MacLauncherScene.mlProjection[0].y - (_458 * MacLauncherScene.mlProjection[0].w);
        float _464 = MacLauncherScene.mlProjection[1].y - (_458 * MacLauncherScene.mlProjection[1].w);
        float _465 = _433.x;
        float _467 = _433.y;
        _479 = float2((_464 * _465) - (_455 * _467), (_449 * _467) - (_460 * _465)) / float2((_449 * _464) - (_455 * _460));
    }
    float3 _482 = float3(_479, _120);
    float2 _487 = (((_143 + (float2(2.0, 0.0) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions)) - _158) * _162) + _166;
    float _488 = _121 * MacLauncherScene.mlJitterSign.z;
    float2 _494 = ((_487 * ((_488 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _488)) - MacLauncherScene.mlProjection[3].xy;
    float2 _540;
    if (_191)
    {
        _540 = _494 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _506 = _487.x;
        float _510 = MacLauncherScene.mlProjection[0].x - (_506 * MacLauncherScene.mlProjection[0].w);
        float _516 = MacLauncherScene.mlProjection[1].x - (_506 * MacLauncherScene.mlProjection[1].w);
        float _519 = _487.y;
        float _521 = MacLauncherScene.mlProjection[0].y - (_519 * MacLauncherScene.mlProjection[0].w);
        float _525 = MacLauncherScene.mlProjection[1].y - (_519 * MacLauncherScene.mlProjection[1].w);
        float _526 = _494.x;
        float _528 = _494.y;
        _540 = float2((_525 * _526) - (_516 * _528), (_510 * _528) - (_521 * _526)) / float2((_510 * _525) - (_516 * _521));
    }
    float2 _548 = (((_143 + (float2(-1.0, 1.0) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions)) - _158) * _162) + _166;
    float _549 = _122 * MacLauncherScene.mlJitterSign.z;
    float2 _555 = ((_548 * ((_549 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _549)) - MacLauncherScene.mlProjection[3].xy;
    float2 _601;
    if (_191)
    {
        _601 = _555 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _567 = _548.x;
        float _571 = MacLauncherScene.mlProjection[0].x - (_567 * MacLauncherScene.mlProjection[0].w);
        float _577 = MacLauncherScene.mlProjection[1].x - (_567 * MacLauncherScene.mlProjection[1].w);
        float _580 = _548.y;
        float _582 = MacLauncherScene.mlProjection[0].y - (_580 * MacLauncherScene.mlProjection[0].w);
        float _586 = MacLauncherScene.mlProjection[1].y - (_580 * MacLauncherScene.mlProjection[1].w);
        float _587 = _555.x;
        float _589 = _555.y;
        _601 = float2((_586 * _587) - (_577 * _589), (_571 * _589) - (_582 * _587)) / float2((_571 * _586) - (_577 * _582));
    }
    float2 _609 = (((_143 + (float2(0.0, 1.0) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions)) - _158) * _162) + _166;
    float _610 = _123 * MacLauncherScene.mlJitterSign.z;
    float2 _616 = ((_609 * ((_610 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _610)) - MacLauncherScene.mlProjection[3].xy;
    float2 _662;
    if (_191)
    {
        _662 = _616 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _628 = _609.x;
        float _632 = MacLauncherScene.mlProjection[0].x - (_628 * MacLauncherScene.mlProjection[0].w);
        float _638 = MacLauncherScene.mlProjection[1].x - (_628 * MacLauncherScene.mlProjection[1].w);
        float _641 = _609.y;
        float _643 = MacLauncherScene.mlProjection[0].y - (_641 * MacLauncherScene.mlProjection[0].w);
        float _647 = MacLauncherScene.mlProjection[1].y - (_641 * MacLauncherScene.mlProjection[1].w);
        float _648 = _616.x;
        float _650 = _616.y;
        _662 = float2((_647 * _648) - (_638 * _650), (_632 * _650) - (_643 * _648)) / float2((_632 * _647) - (_638 * _643));
    }
    float3 _665 = float3(_662, _123);
    float2 _669 = (((_143 + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions) - _158) * _162) + _166;
    float _670 = _124 * MacLauncherScene.mlJitterSign.z;
    float2 _676 = ((_669 * ((_670 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _670)) - MacLauncherScene.mlProjection[3].xy;
    float2 _722;
    if (_191)
    {
        _722 = _676 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _688 = _669.x;
        float _692 = MacLauncherScene.mlProjection[0].x - (_688 * MacLauncherScene.mlProjection[0].w);
        float _698 = MacLauncherScene.mlProjection[1].x - (_688 * MacLauncherScene.mlProjection[1].w);
        float _701 = _669.y;
        float _703 = MacLauncherScene.mlProjection[0].y - (_701 * MacLauncherScene.mlProjection[0].w);
        float _707 = MacLauncherScene.mlProjection[1].y - (_701 * MacLauncherScene.mlProjection[1].w);
        float _708 = _676.x;
        float _710 = _676.y;
        _722 = float2((_707 * _708) - (_698 * _710), (_692 * _710) - (_703 * _708)) / float2((_692 * _707) - (_698 * _703));
    }
    float3 _725 = float3(_722, _124);
    float2 _730 = (((_143 + (float2(2.0, 1.0) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions)) - _158) * _162) + _166;
    float _731 = _125 * MacLauncherScene.mlJitterSign.z;
    float2 _737 = ((_730 * ((_731 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _731)) - MacLauncherScene.mlProjection[3].xy;
    float2 _783;
    if (_191)
    {
        _783 = _737 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _749 = _730.x;
        float _753 = MacLauncherScene.mlProjection[0].x - (_749 * MacLauncherScene.mlProjection[0].w);
        float _759 = MacLauncherScene.mlProjection[1].x - (_749 * MacLauncherScene.mlProjection[1].w);
        float _762 = _730.y;
        float _764 = MacLauncherScene.mlProjection[0].y - (_762 * MacLauncherScene.mlProjection[0].w);
        float _768 = MacLauncherScene.mlProjection[1].y - (_762 * MacLauncherScene.mlProjection[1].w);
        float _769 = _737.x;
        float _771 = _737.y;
        _783 = float2((_768 * _769) - (_759 * _771), (_753 * _771) - (_764 * _769)) / float2((_753 * _768) - (_759 * _764));
    }
    float2 _791 = (((_143 + (float2(0.0, 2.0) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions)) - _158) * _162) + _166;
    float _792 = _126 * MacLauncherScene.mlJitterSign.z;
    float2 _798 = ((_791 * ((_792 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _792)) - MacLauncherScene.mlProjection[3].xy;
    float2 _844;
    if (_191)
    {
        _844 = _798 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _810 = _791.x;
        float _814 = MacLauncherScene.mlProjection[0].x - (_810 * MacLauncherScene.mlProjection[0].w);
        float _820 = MacLauncherScene.mlProjection[1].x - (_810 * MacLauncherScene.mlProjection[1].w);
        float _823 = _791.y;
        float _825 = MacLauncherScene.mlProjection[0].y - (_823 * MacLauncherScene.mlProjection[0].w);
        float _829 = MacLauncherScene.mlProjection[1].y - (_823 * MacLauncherScene.mlProjection[1].w);
        float _830 = _798.x;
        float _832 = _798.y;
        _844 = float2((_829 * _830) - (_820 * _832), (_814 * _832) - (_825 * _830)) / float2((_814 * _829) - (_820 * _825));
    }
    float2 _852 = (((_143 + (float2(1.0, 2.0) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions)) - _158) * _162) + _166;
    float _853 = _127 * MacLauncherScene.mlJitterSign.z;
    float2 _859 = ((_852 * ((_853 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _853)) - MacLauncherScene.mlProjection[3].xy;
    float2 _905;
    if (_191)
    {
        _905 = _859 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _871 = _852.x;
        float _875 = MacLauncherScene.mlProjection[0].x - (_871 * MacLauncherScene.mlProjection[0].w);
        float _881 = MacLauncherScene.mlProjection[1].x - (_871 * MacLauncherScene.mlProjection[1].w);
        float _884 = _852.y;
        float _886 = MacLauncherScene.mlProjection[0].y - (_884 * MacLauncherScene.mlProjection[0].w);
        float _890 = MacLauncherScene.mlProjection[1].y - (_884 * MacLauncherScene.mlProjection[1].w);
        float _891 = _859.x;
        float _893 = _859.y;
        _905 = float2((_890 * _891) - (_881 * _893), (_875 * _893) - (_886 * _891)) / float2((_875 * _890) - (_881 * _886));
    }
    float4 _911 = float4(_118, _120, _116, _123) - float4(_119);
    float4 _921 = fast::clamp(float4(1.2999999523162841796875) - (precise::min(abs(_911), abs(_911 + _911.yxwz)) / float4(_119 * 0.039999999105930328369140625)), float4(0.0), float4(1.0));
    float4 _924 = float4(_119, _121, _117, _124) - float4(_120);
    float4 _934 = fast::clamp(float4(1.2999999523162841796875) - (precise::min(abs(_924), abs(_924 + _924.yxwz)) / float4(_120 * 0.039999999105930328369140625)), float4(0.0), float4(1.0));
    float4 _937 = float4(_122, _124, _119, _126) - float4(_123);
    float4 _947 = fast::clamp(float4(1.2999999523162841796875) - (precise::min(abs(_937), abs(_937 + _937.yxwz)) / float4(_123 * 0.039999999105930328369140625)), float4(0.0), float4(1.0));
    float4 _950 = float4(_123, _125, _120, _127) - float4(_124);
    float4 _960 = fast::clamp(float4(1.2999999523162841796875) - (precise::min(abs(_950), abs(_950 + _950.yxwz)) / float4(_124 * 0.039999999105930328369140625)), float4(0.0), float4(1.0));
    float _961 = _921.x;
    float _962 = _921.z;
    float _964 = _921.y;
    float _966 = _921.w;
    float3 _970 = fast::normalize(float3(_359, _118) - _421);
    float3 _972 = fast::normalize(_482 - _421);
    float3 _974 = fast::normalize(float3(_237, _116) - _421);
    float3 _976 = fast::normalize(_665 - _421);
    float _990 = _934.x;
    float _991 = _934.z;
    float _993 = _934.y;
    float _995 = _934.w;
    float3 _999 = fast::normalize(_421 - _482);
    float3 _1001 = fast::normalize(float3(_540, _121) - _482);
    float3 _1003 = fast::normalize(float3(_298, _117) - _482);
    float3 _1005 = fast::normalize(_725 - _482);
    float _1019 = _947.x;
    float _1020 = _947.z;
    float _1022 = _947.y;
    float _1024 = _947.w;
    float3 _1028 = fast::normalize(float3(_601, _122) - _665);
    float3 _1030 = fast::normalize(_725 - _665);
    float3 _1032 = fast::normalize(_421 - _665);
    float3 _1034 = fast::normalize(float3(_844, _126) - _665);
    float _1048 = _960.x;
    float _1049 = _960.z;
    float _1051 = _960.y;
    float _1053 = _960.w;
    float3 _1057 = fast::normalize(_665 - _725);
    float3 _1059 = fast::normalize(float3(_783, _125) - _725);
    float3 _1061 = fast::normalize(_482 - _725);
    float3 _1063 = fast::normalize(float3(_905, _127) - _725);
    int _1083 = int(gl_GlobalInvocationID.x);
    int _1084 = int(gl_GlobalInvocationID.y);
    uint3 _1086 = uint3(int3(_1083, _1084, 0));
    g_RwDeinterleavedNormals.write(float4(fast::normalize((((float3(0.0, 0.0, -0.0005000000237487256526947021484375) + (cross(_970, _974) * (_961 * _962))) + (cross(_974, _972) * (_962 * _964))) + (cross(_972, _976) * (_964 * _966))) + (cross(_976, _970) * (_966 * _961))), 1.0), uint2(_1086.xy), uint(_1086.z));
    uint3 _1093 = uint3(int3(_1083, _1084, 1));
    g_RwDeinterleavedNormals.write(float4(fast::normalize((((float3(0.0, 0.0, -0.0005000000237487256526947021484375) + (cross(_999, _1003) * (_990 * _991))) + (cross(_1003, _1001) * (_991 * _993))) + (cross(_1001, _1005) * (_993 * _995))) + (cross(_1005, _999) * (_995 * _990))), 1.0), uint2(_1093.xy), uint(_1093.z));
    uint3 _1100 = uint3(int3(_1083, _1084, 2));
    g_RwDeinterleavedNormals.write(float4(fast::normalize((((float3(0.0, 0.0, -0.0005000000237487256526947021484375) + (cross(_1028, _1032) * (_1019 * _1020))) + (cross(_1032, _1030) * (_1020 * _1022))) + (cross(_1030, _1034) * (_1022 * _1024))) + (cross(_1034, _1028) * (_1024 * _1019))), 1.0), uint2(_1100.xy), uint(_1100.z));
    uint3 _1107 = uint3(int3(_1083, _1084, 3));
    g_RwDeinterleavedNormals.write(float4(fast::normalize((((float3(0.0, 0.0, -0.0005000000237487256526947021484375) + (cross(_1057, _1061) * (_1048 * _1049))) + (cross(_1061, _1059) * (_1049 * _1051))) + (cross(_1059, _1063) * (_1051 * _1053))) + (cross(_1063, _1057) * (_1053 * _1048))), 1.0), uint2(_1107.xy), uint(_1107.z));
}

)CACAO_GPU";
inline constexpr Binding bindings4[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_DepthIn","texture",0},{"g_RwDeinterleavedDepth","texture",1},{"g_PointClampSampler","sampler",0}};
inline constexpr const char*source4=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d<float> g_DepthIn [[texture(0)]], texture2d_array<float, access::write> g_RwDeinterleavedDepth [[texture(1)]], sampler g_PointClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    float2 _59 = (float2(int2(4) * int2(gl_GlobalInvocationID.xy)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferInverseDimensions;
    int _82 = int(gl_GlobalInvocationID.x);
    int _83 = int(gl_GlobalInvocationID.y);
    uint3 _85 = uint3(int3(_82, _83, 0));
    g_RwDeinterleavedDepth.write(float4(g_DepthIn.sample(g_PointClampSampler, _59, level(0.0), int2(0)).x), uint2(_85.xy), uint(_85.z));
    uint3 _88 = uint3(int3(_82, _83, 1));
    g_RwDeinterleavedDepth.write(float4(g_DepthIn.sample(g_PointClampSampler, _59, level(0.0), int2(2, 0)).x), uint2(_88.xy), uint(_88.z));
    uint3 _91 = uint3(int3(_82, _83, 2));
    g_RwDeinterleavedDepth.write(float4(g_DepthIn.sample(g_PointClampSampler, _59, level(0.0), int2(0, 2)).x), uint2(_91.xy), uint(_91.z));
    uint3 _94 = uint3(int3(_82, _83, 3));
    g_RwDeinterleavedDepth.write(float4(g_DepthIn.sample(g_PointClampSampler, _59, level(0.0), int2(2)).x), uint2(_94.xy), uint(_94.z));
}

)CACAO_GPU";
inline constexpr Binding bindings5[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_DepthIn","texture",0},{"g_RwDepthMip0","texture",1},{"g_RwDepthMip1","texture",2},{"g_RwDepthMip2","texture",3},{"g_RwDepthMip3","texture",4},{"g_PointClampSampler","sampler",0}};
inline constexpr const char*source5=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d<float> g_DepthIn [[texture(0)]], texture2d_array<float, access::write> g_RwDepthMip0 [[texture(1)]], texture2d_array<float, access::write> g_RwDepthMip1 [[texture(2)]], texture2d_array<float, access::write> g_RwDepthMip2 [[texture(3)]], texture2d_array<float, access::write> g_RwDepthMip3 [[texture(4)]], sampler g_PointClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<spvUnsafeArray<float, 8>, 8>, 4> s_FFX_CACAO_PrepareDepthsAndMipsBuffer;
    float2 _82 = (float2(int2(4) * int2(gl_GlobalInvocationID.xy)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferInverseDimensions;
    float4 _86 = g_DepthIn.sample(g_PointClampSampler, _82, level(0.0), int2(0, 2));
    float _87 = _86.x;
    float4 _91 = g_DepthIn.sample(g_PointClampSampler, _82, level(0.0), int2(2));
    float _92 = _91.x;
    float4 _96 = g_DepthIn.sample(g_PointClampSampler, _82, level(0.0), int2(2, 0));
    float _97 = _96.x;
    float4 _101 = g_DepthIn.sample(g_PointClampSampler, _82, level(0.0), int2(0));
    float _102 = _101.x;
    s_FFX_CACAO_PrepareDepthsAndMipsBuffer[0][gl_LocalInvocationID.x][gl_LocalInvocationID.y] = _102;
    s_FFX_CACAO_PrepareDepthsAndMipsBuffer[1][gl_LocalInvocationID.x][gl_LocalInvocationID.y] = _97;
    s_FFX_CACAO_PrepareDepthsAndMipsBuffer[2][gl_LocalInvocationID.x][gl_LocalInvocationID.y] = _87;
    s_FFX_CACAO_PrepareDepthsAndMipsBuffer[3][gl_LocalInvocationID.x][gl_LocalInvocationID.y] = _92;
    int _111 = int(gl_GlobalInvocationID.x);
    int _112 = int(gl_GlobalInvocationID.y);
    uint3 _114 = uint3(int3(_111, _112, 0));
    g_RwDepthMip0.write(float4(_102), uint2(_114.xy), uint(_114.z));
    uint3 _117 = uint3(int3(_111, _112, 1));
    g_RwDepthMip0.write(float4(_97), uint2(_117.xy), uint(_117.z));
    uint3 _120 = uint3(int3(_111, _112, 2));
    g_RwDepthMip0.write(float4(_87), uint2(_120.xy), uint(_120.z));
    uint3 _123 = uint3(int3(_111, _112, 3));
    g_RwDepthMip0.write(float4(_92), uint2(_123.xy), uint(_123.z));
    uint _125 = gl_LocalInvocationID.y % 2u;
    uint _127 = gl_LocalInvocationID.x % 2u;
    uint _128 = (2u * _125) + _127;
    int2 _131 = int2(int(_127), int(_125));
    uint2 _132 = uint2(_131);
    int2 _134 = int2(gl_LocalInvocationID.xy) - _131;
    uint2 _135 = gl_GlobalInvocationID.xy / uint2(2u);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _136 = _134.x;
    int _137 = _134.y;
    int _140 = _137 + 1;
    int _143 = _136 + 1;
    float4 _148 = float4(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_137], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_140], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_143][_137], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_143][_140]);
    float4 _153 = _148 - float4(precise::min(precise::min(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_137], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_140]), precise::min(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_143][_137], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_143][_140])));
    float4 _157 = fast::clamp(((_153 * _153) * (-1.0)) + float4(1.0), float4(0.0), float4(1.0));
    float _160 = dot(_157, _148) / dot(_157, float4(1.0));
    int _161 = int(_128);
    uint3 _167 = uint3(int3(int(_135.x), int(_135.y), _161));
    g_RwDepthMip1.write(float4(_160), uint2(_167.xy), uint(_167.z));
    s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_137] = _160;
    uint _170 = _132.x;
    bool _177;
    if ((gl_LocalInvocationID.x % 4u) == _170)
    {
        _177 = (gl_LocalInvocationID.y % 4u) == _132.y;
    }
    else
    {
        _177 = false;
    }
    uint2 _178 = _135 / uint2(2u);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (_177)
    {
        int _182 = _137 + 2;
        int _185 = _136 + 2;
        float4 _190 = float4(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_137], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_182], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_185][_137], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_185][_182]);
        float4 _195 = _190 - float4(precise::min(precise::min(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_137], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_182]), precise::min(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_185][_137], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_185][_182])));
        float4 _199 = fast::clamp(((_195 * _195) * (-1.0)) + float4(1.0), float4(0.0), float4(1.0));
        float _202 = dot(_199, _190) / dot(_199, float4(1.0));
        uint3 _208 = uint3(int3(int(_178.x), int(_178.y), _161));
        g_RwDepthMip2.write(float4(_202), uint2(_208.xy), uint(_208.z));
        s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_137] = _202;
    }
    bool _217;
    if ((gl_LocalInvocationID.x % 8u) == _170)
    {
        _217 = (gl_LocalInvocationID.y % 8u) == _132.y;
    }
    else
    {
        _217 = false;
    }
    uint2 _218 = _178 / uint2(2u);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (_217)
    {
        int _222 = _137 + 4;
        int _225 = _136 + 4;
        float4 _230 = float4(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_137], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_222], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_225][_137], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_225][_222]);
        float4 _235 = _230 - float4(precise::min(precise::min(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_137], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_136][_222]), precise::min(s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_225][_137], s_FFX_CACAO_PrepareDepthsAndMipsBuffer[_128][_225][_222])));
        float4 _239 = fast::clamp(((_235 * _235) * (-1.0)) + float4(1.0), float4(0.0), float4(1.0));
        uint3 _248 = uint3(int3(int(_218.x), int(_218.y), _161));
        g_RwDepthMip3.write(float4(dot(_239, _230) / dot(_239, float4(1.0))), uint2(_248.xy), uint(_248.z));
    }
}

)CACAO_GPU";
inline constexpr Binding bindings6[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_DepthIn","texture",0},{"g_RwDeinterleavedDepth","texture",1}};
inline constexpr const char*source6=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d<float> g_DepthIn [[texture(0)]], texture2d_array<float, access::write> g_RwDeinterleavedDepth [[texture(1)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    uint _42 = 4u * gl_GlobalInvocationID.x;
    uint _45 = 4u * gl_GlobalInvocationID.y;
    int2 _51 = int2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferDimensions) - int2(1);
    int _73 = int(gl_GlobalInvocationID.x);
    int _74 = int(gl_GlobalInvocationID.y);
    uint3 _76 = uint3(int3(_73, _74, 0));
    g_RwDeinterleavedDepth.write(float4(g_DepthIn.read(uint2(int3(clamp(int2(int(_42), int(_45)), int2(0), _51), 0).xy), 0).x), uint2(_76.xy), uint(_76.z));
    uint3 _79 = uint3(int3(_73, _74, 3));
    g_RwDeinterleavedDepth.write(float4(g_DepthIn.read(uint2(int3(clamp(int2(int(_42 + 2u), int(_45 + 2u)), int2(0), _51), 0).xy), 0).x), uint2(_79.xy), uint(_79.z));
}

)CACAO_GPU";
inline constexpr Binding bindings7[]={{"SSAOConstantsBuffer_t","buffer",0},{"MacLauncherScene","buffer",1},{"g_DepthIn","texture",0},{"g_RwDeinterleavedNormals","texture",1}};
inline constexpr const char*source7=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

struct type_MacLauncherScene
{
    float4 mlProjection[4];
    float4 mlInverse[4];
    float4 mlJitterSign;
    uint4 mlDepthROI;
    float4 mlClip;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], constant type_MacLauncherScene& MacLauncherScene [[buffer(1)]], texture2d<float> g_DepthIn [[texture(0)]], texture2d_array<float, access::write> g_RwDeinterleavedNormals [[texture(1)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    int2 _101 = (int2(4) * int2(gl_GlobalInvocationID.xy)) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferOffset;
    int2 _106 = int2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferDimensions) - int2(1);
    float4 _113 = g_DepthIn.read(uint2(int3(clamp(_101 + int2(0, -2), int2(0), _106), 0).xy), 0);
    float _114 = _113.x;
    float4 _122 = g_DepthIn.read(uint2(int3(clamp(_101 + int2(2, -2), int2(0), _106), 0).xy), 0);
    float _123 = _122.x;
    float4 _131 = g_DepthIn.read(uint2(int3(clamp(_101 + int2(-2, 0), int2(0), _106), 0).xy), 0);
    float _132 = _131.x;
    float4 _139 = g_DepthIn.read(uint2(int3(clamp(_101, int2(0), _106), 0).xy), 0);
    float _140 = _139.x;
    float4 _148 = g_DepthIn.read(uint2(int3(clamp(_101 + int2(2, 0), int2(0), _106), 0).xy), 0);
    float _149 = _148.x;
    float4 _157 = g_DepthIn.read(uint2(int3(clamp(_101 + int2(4, 0), int2(0), _106), 0).xy), 0);
    float _158 = _157.x;
    float4 _166 = g_DepthIn.read(uint2(int3(clamp(_101 + int2(-2, 2), int2(0), _106), 0).xy), 0);
    float _167 = _166.x;
    float4 _175 = g_DepthIn.read(uint2(int3(clamp(_101 + int2(0, 2), int2(0), _106), 0).xy), 0);
    float _176 = _175.x;
    float4 _184 = g_DepthIn.read(uint2(int3(clamp(_101 + int2(2), int2(0), _106), 0).xy), 0);
    float _185 = _184.x;
    float4 _193 = g_DepthIn.read(uint2(int3(clamp(_101 + int2(4, 2), int2(0), _106), 0).xy), 0);
    float _194 = _193.x;
    float4 _202 = g_DepthIn.read(uint2(int3(clamp(_101 + int2(0, 4), int2(0), _106), 0).xy), 0);
    float _203 = _202.x;
    float4 _211 = g_DepthIn.read(uint2(int3(clamp(_101 + int2(2, 4), int2(0), _106), 0).xy), 0);
    float _212 = _211.x;
    float2 _215 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions * 2.0;
    float2 _219 = (float2(uint2(4u) * gl_GlobalInvocationID.xy) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions;
    bool _227 = (uint(MacLauncherScene.mlJitterSign.w) & 2u) != 0u;
    float2 _234 = MacLauncherScene.mlJitterSign.xy / float2(MacLauncherScene.mlDepthROI.zw);
    float2 _238 = float2(2.0, float(_227 ? 2 : (-2)));
    float2 _242 = float2(-1.0, float(_227 ? (-1) : 1));
    float2 _243 = (((_219 + (float2(0.0, -1.0) * _215)) - _234) * _238) + _242;
    float _246 = _114 * MacLauncherScene.mlJitterSign.z;
    float2 _262 = ((_243 * ((_246 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _246)) - MacLauncherScene.mlProjection[3].xy;
    bool _267 = (uint(MacLauncherScene.mlClip.w) & 1u) != 0u;
    float2 _313;
    if (_267)
    {
        _313 = _262 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _279 = _243.x;
        float _283 = MacLauncherScene.mlProjection[0].x - (_279 * MacLauncherScene.mlProjection[0].w);
        float _289 = MacLauncherScene.mlProjection[1].x - (_279 * MacLauncherScene.mlProjection[1].w);
        float _292 = _243.y;
        float _294 = MacLauncherScene.mlProjection[0].y - (_292 * MacLauncherScene.mlProjection[0].w);
        float _298 = MacLauncherScene.mlProjection[1].y - (_292 * MacLauncherScene.mlProjection[1].w);
        float _299 = _262.x;
        float _301 = _262.y;
        _313 = float2((_298 * _299) - (_289 * _301), (_283 * _301) - (_294 * _299)) / float2((_283 * _298) - (_289 * _294));
    }
    float2 _321 = (((_219 + (float2(1.0, -1.0) * _215)) - _234) * _238) + _242;
    float _322 = _123 * MacLauncherScene.mlJitterSign.z;
    float2 _328 = ((_321 * ((_322 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _322)) - MacLauncherScene.mlProjection[3].xy;
    float2 _374;
    if (_267)
    {
        _374 = _328 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _340 = _321.x;
        float _344 = MacLauncherScene.mlProjection[0].x - (_340 * MacLauncherScene.mlProjection[0].w);
        float _350 = MacLauncherScene.mlProjection[1].x - (_340 * MacLauncherScene.mlProjection[1].w);
        float _353 = _321.y;
        float _355 = MacLauncherScene.mlProjection[0].y - (_353 * MacLauncherScene.mlProjection[0].w);
        float _359 = MacLauncherScene.mlProjection[1].y - (_353 * MacLauncherScene.mlProjection[1].w);
        float _360 = _328.x;
        float _362 = _328.y;
        _374 = float2((_359 * _360) - (_350 * _362), (_344 * _362) - (_355 * _360)) / float2((_344 * _359) - (_350 * _355));
    }
    float2 _382 = (((_219 + (float2(-1.0, 0.0) * _215)) - _234) * _238) + _242;
    float _383 = _132 * MacLauncherScene.mlJitterSign.z;
    float2 _389 = ((_382 * ((_383 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _383)) - MacLauncherScene.mlProjection[3].xy;
    float2 _435;
    if (_267)
    {
        _435 = _389 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _401 = _382.x;
        float _405 = MacLauncherScene.mlProjection[0].x - (_401 * MacLauncherScene.mlProjection[0].w);
        float _411 = MacLauncherScene.mlProjection[1].x - (_401 * MacLauncherScene.mlProjection[1].w);
        float _414 = _382.y;
        float _416 = MacLauncherScene.mlProjection[0].y - (_414 * MacLauncherScene.mlProjection[0].w);
        float _420 = MacLauncherScene.mlProjection[1].y - (_414 * MacLauncherScene.mlProjection[1].w);
        float _421 = _389.x;
        float _423 = _389.y;
        _435 = float2((_420 * _421) - (_411 * _423), (_405 * _423) - (_416 * _421)) / float2((_405 * _420) - (_411 * _416));
    }
    float2 _441 = ((_219 - _234) * _238) + _242;
    float _442 = _140 * MacLauncherScene.mlJitterSign.z;
    float2 _448 = ((_441 * ((_442 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _442)) - MacLauncherScene.mlProjection[3].xy;
    float2 _494;
    if (_267)
    {
        _494 = _448 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _460 = _441.x;
        float _464 = MacLauncherScene.mlProjection[0].x - (_460 * MacLauncherScene.mlProjection[0].w);
        float _470 = MacLauncherScene.mlProjection[1].x - (_460 * MacLauncherScene.mlProjection[1].w);
        float _473 = _441.y;
        float _475 = MacLauncherScene.mlProjection[0].y - (_473 * MacLauncherScene.mlProjection[0].w);
        float _479 = MacLauncherScene.mlProjection[1].y - (_473 * MacLauncherScene.mlProjection[1].w);
        _494 = float2((_479 * _448.x) - (_470 * _448.y), (_464 * _448.y) - (_475 * _448.x)) / float2((_464 * _479) - (_470 * _475));
    }
    float3 _497 = float3(_494, _140);
    float2 _502 = (((_219 + (float2(1.0, 0.0) * _215)) - _234) * _238) + _242;
    float _503 = _149 * MacLauncherScene.mlJitterSign.z;
    float2 _509 = ((_502 * ((_503 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _503)) - MacLauncherScene.mlProjection[3].xy;
    float2 _555;
    if (_267)
    {
        _555 = _509 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _521 = _502.x;
        float _525 = MacLauncherScene.mlProjection[0].x - (_521 * MacLauncherScene.mlProjection[0].w);
        float _531 = MacLauncherScene.mlProjection[1].x - (_521 * MacLauncherScene.mlProjection[1].w);
        float _534 = _502.y;
        float _536 = MacLauncherScene.mlProjection[0].y - (_534 * MacLauncherScene.mlProjection[0].w);
        float _540 = MacLauncherScene.mlProjection[1].y - (_534 * MacLauncherScene.mlProjection[1].w);
        float _541 = _509.x;
        float _543 = _509.y;
        _555 = float2((_540 * _541) - (_531 * _543), (_525 * _543) - (_536 * _541)) / float2((_525 * _540) - (_531 * _536));
    }
    float3 _558 = float3(_555, _149);
    float2 _563 = (((_219 + (float2(2.0, 0.0) * _215)) - _234) * _238) + _242;
    float _564 = _158 * MacLauncherScene.mlJitterSign.z;
    float2 _570 = ((_563 * ((_564 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _564)) - MacLauncherScene.mlProjection[3].xy;
    float2 _616;
    if (_267)
    {
        _616 = _570 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _582 = _563.x;
        float _586 = MacLauncherScene.mlProjection[0].x - (_582 * MacLauncherScene.mlProjection[0].w);
        float _592 = MacLauncherScene.mlProjection[1].x - (_582 * MacLauncherScene.mlProjection[1].w);
        float _595 = _563.y;
        float _597 = MacLauncherScene.mlProjection[0].y - (_595 * MacLauncherScene.mlProjection[0].w);
        float _601 = MacLauncherScene.mlProjection[1].y - (_595 * MacLauncherScene.mlProjection[1].w);
        float _602 = _570.x;
        float _604 = _570.y;
        _616 = float2((_601 * _602) - (_592 * _604), (_586 * _604) - (_597 * _602)) / float2((_586 * _601) - (_592 * _597));
    }
    float2 _624 = (((_219 + (float2(-1.0, 1.0) * _215)) - _234) * _238) + _242;
    float _625 = _167 * MacLauncherScene.mlJitterSign.z;
    float2 _631 = ((_624 * ((_625 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _625)) - MacLauncherScene.mlProjection[3].xy;
    float2 _677;
    if (_267)
    {
        _677 = _631 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _643 = _624.x;
        float _647 = MacLauncherScene.mlProjection[0].x - (_643 * MacLauncherScene.mlProjection[0].w);
        float _653 = MacLauncherScene.mlProjection[1].x - (_643 * MacLauncherScene.mlProjection[1].w);
        float _656 = _624.y;
        float _658 = MacLauncherScene.mlProjection[0].y - (_656 * MacLauncherScene.mlProjection[0].w);
        float _662 = MacLauncherScene.mlProjection[1].y - (_656 * MacLauncherScene.mlProjection[1].w);
        float _663 = _631.x;
        float _665 = _631.y;
        _677 = float2((_662 * _663) - (_653 * _665), (_647 * _665) - (_658 * _663)) / float2((_647 * _662) - (_653 * _658));
    }
    float2 _685 = (((_219 + (float2(0.0, 1.0) * _215)) - _234) * _238) + _242;
    float _686 = _176 * MacLauncherScene.mlJitterSign.z;
    float2 _692 = ((_685 * ((_686 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _686)) - MacLauncherScene.mlProjection[3].xy;
    float2 _738;
    if (_267)
    {
        _738 = _692 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _704 = _685.x;
        float _708 = MacLauncherScene.mlProjection[0].x - (_704 * MacLauncherScene.mlProjection[0].w);
        float _714 = MacLauncherScene.mlProjection[1].x - (_704 * MacLauncherScene.mlProjection[1].w);
        float _717 = _685.y;
        float _719 = MacLauncherScene.mlProjection[0].y - (_717 * MacLauncherScene.mlProjection[0].w);
        float _723 = MacLauncherScene.mlProjection[1].y - (_717 * MacLauncherScene.mlProjection[1].w);
        float _724 = _692.x;
        float _726 = _692.y;
        _738 = float2((_723 * _724) - (_714 * _726), (_708 * _726) - (_719 * _724)) / float2((_708 * _723) - (_714 * _719));
    }
    float3 _741 = float3(_738, _176);
    float2 _745 = (((_219 + _215) - _234) * _238) + _242;
    float _746 = _185 * MacLauncherScene.mlJitterSign.z;
    float2 _752 = ((_745 * ((_746 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _746)) - MacLauncherScene.mlProjection[3].xy;
    float2 _798;
    if (_267)
    {
        _798 = _752 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _764 = _745.x;
        float _768 = MacLauncherScene.mlProjection[0].x - (_764 * MacLauncherScene.mlProjection[0].w);
        float _774 = MacLauncherScene.mlProjection[1].x - (_764 * MacLauncherScene.mlProjection[1].w);
        float _777 = _745.y;
        float _779 = MacLauncherScene.mlProjection[0].y - (_777 * MacLauncherScene.mlProjection[0].w);
        float _783 = MacLauncherScene.mlProjection[1].y - (_777 * MacLauncherScene.mlProjection[1].w);
        _798 = float2((_783 * _752.x) - (_774 * _752.y), (_768 * _752.y) - (_779 * _752.x)) / float2((_768 * _783) - (_774 * _779));
    }
    float3 _801 = float3(_798, _185);
    float2 _806 = (((_219 + (float2(2.0, 1.0) * _215)) - _234) * _238) + _242;
    float _807 = _194 * MacLauncherScene.mlJitterSign.z;
    float2 _813 = ((_806 * ((_807 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _807)) - MacLauncherScene.mlProjection[3].xy;
    float2 _859;
    if (_267)
    {
        _859 = _813 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _825 = _806.x;
        float _829 = MacLauncherScene.mlProjection[0].x - (_825 * MacLauncherScene.mlProjection[0].w);
        float _835 = MacLauncherScene.mlProjection[1].x - (_825 * MacLauncherScene.mlProjection[1].w);
        float _838 = _806.y;
        float _840 = MacLauncherScene.mlProjection[0].y - (_838 * MacLauncherScene.mlProjection[0].w);
        float _844 = MacLauncherScene.mlProjection[1].y - (_838 * MacLauncherScene.mlProjection[1].w);
        float _845 = _813.x;
        float _847 = _813.y;
        _859 = float2((_844 * _845) - (_835 * _847), (_829 * _847) - (_840 * _845)) / float2((_829 * _844) - (_835 * _840));
    }
    float2 _867 = (((_219 + (float2(0.0, 2.0) * _215)) - _234) * _238) + _242;
    float _868 = _203 * MacLauncherScene.mlJitterSign.z;
    float2 _874 = ((_867 * ((_868 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _868)) - MacLauncherScene.mlProjection[3].xy;
    float2 _920;
    if (_267)
    {
        _920 = _874 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _886 = _867.x;
        float _890 = MacLauncherScene.mlProjection[0].x - (_886 * MacLauncherScene.mlProjection[0].w);
        float _896 = MacLauncherScene.mlProjection[1].x - (_886 * MacLauncherScene.mlProjection[1].w);
        float _899 = _867.y;
        float _901 = MacLauncherScene.mlProjection[0].y - (_899 * MacLauncherScene.mlProjection[0].w);
        float _905 = MacLauncherScene.mlProjection[1].y - (_899 * MacLauncherScene.mlProjection[1].w);
        float _906 = _874.x;
        float _908 = _874.y;
        _920 = float2((_905 * _906) - (_896 * _908), (_890 * _908) - (_901 * _906)) / float2((_890 * _905) - (_896 * _901));
    }
    float2 _928 = (((_219 + (float2(1.0, 2.0) * _215)) - _234) * _238) + _242;
    float _929 = _212 * MacLauncherScene.mlJitterSign.z;
    float2 _935 = ((_928 * ((_929 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _929)) - MacLauncherScene.mlProjection[3].xy;
    float2 _981;
    if (_267)
    {
        _981 = _935 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _947 = _928.x;
        float _951 = MacLauncherScene.mlProjection[0].x - (_947 * MacLauncherScene.mlProjection[0].w);
        float _957 = MacLauncherScene.mlProjection[1].x - (_947 * MacLauncherScene.mlProjection[1].w);
        float _960 = _928.y;
        float _962 = MacLauncherScene.mlProjection[0].y - (_960 * MacLauncherScene.mlProjection[0].w);
        float _966 = MacLauncherScene.mlProjection[1].y - (_960 * MacLauncherScene.mlProjection[1].w);
        float _967 = _935.x;
        float _969 = _935.y;
        _981 = float2((_966 * _967) - (_957 * _969), (_951 * _969) - (_962 * _967)) / float2((_951 * _966) - (_957 * _962));
    }
    float4 _987 = float4(_132, _149, _114, _176) - float4(_140);
    float4 _997 = fast::clamp(float4(1.2999999523162841796875) - (precise::min(abs(_987), abs(_987 + _987.yxwz)) / float4(_140 * 0.039999999105930328369140625)), float4(0.0), float4(1.0));
    float4 _1000 = float4(_140, _158, _123, _185) - float4(_149);
    float4 _1010 = fast::clamp(float4(1.2999999523162841796875) - (precise::min(abs(_1000), abs(_1000 + _1000.yxwz)) / float4(_149 * 0.039999999105930328369140625)), float4(0.0), float4(1.0));
    float4 _1013 = float4(_167, _185, _140, _203) - float4(_176);
    float4 _1023 = fast::clamp(float4(1.2999999523162841796875) - (precise::min(abs(_1013), abs(_1013 + _1013.yxwz)) / float4(_176 * 0.039999999105930328369140625)), float4(0.0), float4(1.0));
    float4 _1026 = float4(_176, _194, _149, _212) - float4(_185);
    float4 _1036 = fast::clamp(float4(1.2999999523162841796875) - (precise::min(abs(_1026), abs(_1026 + _1026.yxwz)) / float4(_185 * 0.039999999105930328369140625)), float4(0.0), float4(1.0));
    float _1037 = _997.x;
    float _1038 = _997.z;
    float _1040 = _997.y;
    float _1042 = _997.w;
    float3 _1046 = fast::normalize(float3(_435, _132) - _497);
    float3 _1048 = fast::normalize(_558 - _497);
    float3 _1050 = fast::normalize(float3(_313, _114) - _497);
    float3 _1052 = fast::normalize(_741 - _497);
    float _1066 = _1010.x;
    float _1067 = _1010.z;
    float _1069 = _1010.y;
    float _1071 = _1010.w;
    float3 _1075 = fast::normalize(_497 - _558);
    float3 _1077 = fast::normalize(float3(_616, _158) - _558);
    float3 _1079 = fast::normalize(float3(_374, _123) - _558);
    float3 _1081 = fast::normalize(_801 - _558);
    float _1095 = _1023.x;
    float _1096 = _1023.z;
    float _1098 = _1023.y;
    float _1100 = _1023.w;
    float3 _1104 = fast::normalize(float3(_677, _167) - _741);
    float3 _1106 = fast::normalize(_801 - _741);
    float3 _1108 = fast::normalize(_497 - _741);
    float3 _1110 = fast::normalize(float3(_920, _203) - _741);
    float _1124 = _1036.x;
    float _1125 = _1036.z;
    float _1127 = _1036.y;
    float _1129 = _1036.w;
    float3 _1133 = fast::normalize(_741 - _801);
    float3 _1135 = fast::normalize(float3(_859, _194) - _801);
    float3 _1137 = fast::normalize(_558 - _801);
    float3 _1139 = fast::normalize(float3(_981, _212) - _801);
    int _1159 = int(gl_GlobalInvocationID.x);
    int _1160 = int(gl_GlobalInvocationID.y);
    uint3 _1162 = uint3(int3(_1159, _1160, 0));
    g_RwDeinterleavedNormals.write(float4(fast::normalize((((float3(0.0, 0.0, -0.0005000000237487256526947021484375) + (cross(_1046, _1050) * (_1037 * _1038))) + (cross(_1050, _1048) * (_1038 * _1040))) + (cross(_1048, _1052) * (_1040 * _1042))) + (cross(_1052, _1046) * (_1042 * _1037))), 1.0), uint2(_1162.xy), uint(_1162.z));
    uint3 _1169 = uint3(int3(_1159, _1160, 1));
    g_RwDeinterleavedNormals.write(float4(fast::normalize((((float3(0.0, 0.0, -0.0005000000237487256526947021484375) + (cross(_1075, _1079) * (_1066 * _1067))) + (cross(_1079, _1077) * (_1067 * _1069))) + (cross(_1077, _1081) * (_1069 * _1071))) + (cross(_1081, _1075) * (_1071 * _1066))), 1.0), uint2(_1169.xy), uint(_1169.z));
    uint3 _1176 = uint3(int3(_1159, _1160, 2));
    g_RwDeinterleavedNormals.write(float4(fast::normalize((((float3(0.0, 0.0, -0.0005000000237487256526947021484375) + (cross(_1104, _1108) * (_1095 * _1096))) + (cross(_1108, _1106) * (_1096 * _1098))) + (cross(_1106, _1110) * (_1098 * _1100))) + (cross(_1110, _1104) * (_1100 * _1095))), 1.0), uint2(_1176.xy), uint(_1176.z));
    uint3 _1183 = uint3(int3(_1159, _1160, 3));
    g_RwDeinterleavedNormals.write(float4(fast::normalize((((float3(0.0, 0.0, -0.0005000000237487256526947021484375) + (cross(_1133, _1137) * (_1124 * _1125))) + (cross(_1137, _1135) * (_1125 * _1127))) + (cross(_1135, _1139) * (_1127 * _1129))) + (cross(_1139, _1133) * (_1129 * _1124))), 1.0), uint2(_1183.xy), uint(_1183.z));
}

)CACAO_GPU";
inline constexpr Binding bindings8[]={{"SSAOConstantsBuffer_t","buffer",0},{"MacLauncherScene","buffer",1},{"g_DeinterleavedDepth","texture",0},{"g_DeinterleavedNormals","texture",1},{"g_RwSsaoBufferPing","texture",2},{"g_PointMirrorSampler","sampler",0},{"g_ViewspaceDepthTapSampler","sampler",1}};
inline constexpr const char*source8=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

struct type_MacLauncherScene
{
    float4 mlProjection[4];
    float4 mlInverse[4];
    float4 mlJitterSign;
    uint4 mlDepthROI;
    float4 mlClip;
};

constant spvUnsafeArray<float4, 32> _236 = spvUnsafeArray<float4, 32>({ float4(0.78488063812255859375, 0.566616714000701904296875, 1.5, -0.12608300149440765380859375), float4(0.26022231578826904296875, -0.2957517206668853759765625, 1.5, -1.06403005123138427734375), float4(0.104593567550182342529296875, 0.083725273609161376953125, 1.11000001430511474609375, -2.7305629253387451171875), float4(-0.68286800384521484375, 0.04963044822216033935546875, 1.09000003337860107421875, -0.4988270103931427001953125), float4(-0.13570161163806915283203125, -0.641901552677154541015625, 1.25, -0.532764971256256103515625), float4(-0.2619379460811614990234375, -0.082051180303096771240234375, 0.670000016689300537109375, -1.78324496746063232421875), float4(-0.61177456378936767578125, 0.66664218902587890625, 0.709999978542327880859375, -0.044234000146389007568359375), float4(0.4367556273937225341796875, 0.251190245151519775390625, 0.61000001430511474609375, -1.16728305816650390625), float4(0.07884444296360015869140625, 0.866186678409576416015625, 0.63999998569488525390625, -0.4590019881725311279296875), float4(-0.12790934741497039794921875, -0.2986900508403778076171875, 0.60000002384185791015625, -1.729423999786376953125), float4(-0.0403112508356571197509765625, 0.0241362191736698150634765625, 0.60000002384185791015625, -4.792041778564453125), float4(0.16201244294643402099609375, -0.5285141468048095703125, 0.790000021457672119140625, -1.0670549869537353515625), float4(-0.70991218090057373046875, 0.473010718822479248046875, 0.63999998569488525390625, -0.335236012935638427734375), float4(0.0327770709991455078125, -0.22349689900875091552734375, 0.60000002384185791015625, -1.9823839664459228515625), float4(0.689217269420623779296875, 0.3680074214935302734375, 0.62999999523162841796875, -0.2667180001735687255859375), float4(0.292518138885498046875, 0.3777541220188140869140625, 0.61000001430511474609375, -1.42252004146575927734375), float4(-0.122240893542766571044921875, 0.96582591533660888671875, 0.60000002384185791015625, -0.4261420071125030517578125), float4(0.11071456968784332275390625, -0.1613105833530426025390625, 0.60000002384185791015625, -2.16594696044921875), float4(0.465621411800384521484375, -0.597476959228515625, 0.60000002384185791015625, -0.1897599995136260986328125), float4(-0.515487968921661376953125, 0.118041932582855224609375, 0.60000002384185791015625, -1.246799945831298828125), float4(0.89141309261322021484375, -0.4209044277667999267578125, 0.60000002384185791015625, 0.02819200046360492706298828125), float4(-0.3240253031253814697265625, -0.01591528952121734619140625, 0.60000002384185791015625, -1.54301798343658447265625), float4(0.607712447643280029296875, 0.416352212429046630859375, 0.60000002384185791015625, -0.605410993099212646484375), float4(0.02379564940929412841796875, -0.082398213446140289306640625, 0.60000002384185791015625, -3.8090460300445556640625), float4(0.4895115196704864501953125, -0.2365704476833343505859375, 0.60000002384185791015625, -1.18901097774505615234375), float4(-0.17611564695835113525390625, -0.8169689178466796875, 0.60000002384185791015625, -0.513724029064178466796875), float4(-0.3393018543720245361328125, -0.20732204616069793701171875, 0.60000002384185791015625, -1.69804704189300537109375), float4(-0.9197442531585693359375, 0.0540320910513401031494140625, 0.60000002384185791015625, 0.0622459985315799713134765625), float4(-0.150646269321441650390625, -0.14949332177639007568359375, 0.60000002384185791015625, -1.89606201648712158203125), float4(0.531809747219085693359375, -0.352104008197784423828125, 0.60000002384185791015625, -0.758837997913360595703125), float4(0.4148716628551483154296875, 0.814425885677337646484375, 0.60000002384185791015625, -0.50564801692962646484375), float4(-0.241069614887237548828125, -0.3272151648998260498046875, 0.60000002384185791015625, -1.66524398326873779296875) });

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], constant type_MacLauncherScene& MacLauncherScene [[buffer(1)]], texture2d_array<float> g_DeinterleavedDepth [[texture(0)]], texture2d_array<float> g_DeinterleavedNormals [[texture(1)]], texture2d_array<float, access::write> g_RwSsaoBufferPing [[texture(2)]], sampler g_PointMirrorSampler [[sampler(0)]], sampler g_ViewspaceDepthTapSampler [[sampler(1)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    uint _243 = gl_GlobalInvocationID.z / 5u;
    bool _250;
    if (_243 == 1u)
    {
        _250 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BlurNumPasses == 2;
    }
    else
    {
        _250 = false;
    }
    uint _251 = _250 ? 3u : _243;
    uint _258 = (5u * gl_GlobalInvocationID.x) + (((gl_GlobalInvocationID.y * 3u) + (gl_GlobalInvocationID.z % 5u)) % 5u);
    float2 _260 = float2(uint2(_258, gl_GlobalInvocationID.y));
    float2 _261 = trunc(_260);
    uint2 _262 = uint2(_261);
    float2 _272 = ((_260 + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferNormalisedOffset;
    float _275 = float(_251);
    float3 _278 = float3(((_260 + float2(1.0)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferNormalisedOffset, _275);
    float4 _280 = g_DeinterleavedDepth.gather(g_PointMirrorSampler, _278.xy, uint(rint(_278.z)), int2(-1), component::x);
    float _281 = _280.y;
    float2 _285 = (_261 + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions;
    bool _291 = (uint(MacLauncherScene.mlJitterSign.w) & 2u) != 0u;
    float2 _298 = MacLauncherScene.mlJitterSign.xy / float2(MacLauncherScene.mlDepthROI.zw);
    float2 _302 = float2(2.0, float(_291 ? 2 : (-2)));
    float2 _306 = float2(-1.0, float(_291 ? (-1) : 1));
    float2 _307 = ((_285 - _298) * _302) + _306;
    float _310 = _281 * MacLauncherScene.mlJitterSign.z;
    float _318 = (_310 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w;
    float2 _322 = MacLauncherScene.mlProjection[2].xy * _310;
    float2 _326 = ((_307 * _318) - _322) - MacLauncherScene.mlProjection[3].xy;
    uint _329 = uint(MacLauncherScene.mlClip.w);
    bool _331 = (_329 & 1u) != 0u;
    float2 _377;
    if (_331)
    {
        _377 = _326 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _337 = _307.x;
        float _341 = MacLauncherScene.mlProjection[0].x - (_337 * MacLauncherScene.mlProjection[0].w);
        float _347 = MacLauncherScene.mlProjection[1].x - (_337 * MacLauncherScene.mlProjection[1].w);
        float _350 = _307.y;
        float _352 = MacLauncherScene.mlProjection[0].y - (_350 * MacLauncherScene.mlProjection[0].w);
        float _356 = MacLauncherScene.mlProjection[1].y - (_350 * MacLauncherScene.mlProjection[1].w);
        float _357 = _326.x;
        float _359 = _326.y;
        _377 = float2((_356 * _357) - (_347 * _359), (_341 * _359) - (_352 * _357)) / float2((_341 * _356) - (_347 * _352));
    }
    float3 _380 = float3(_377, _281);
    int _381 = int(_251);
    uint3 _387 = uint3(int3(int(_262.x), int(_262.y), _381));
    float3 _390 = g_DeinterleavedNormals.read(uint2(_387.xy), uint(_387.z), 0u).xyz;
    float2 _396 = (((_285 + float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x, 0.0)) - _298) * _302) + _306;
    float2 _399 = ((_396 * _318) - _322) - MacLauncherScene.mlProjection[3].xy;
    float2 _445;
    if (_331)
    {
        _445 = _399 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _405 = _396.x;
        float _409 = MacLauncherScene.mlProjection[0].x - (_405 * MacLauncherScene.mlProjection[0].w);
        float _415 = MacLauncherScene.mlProjection[1].x - (_405 * MacLauncherScene.mlProjection[1].w);
        float _418 = _396.y;
        float _420 = MacLauncherScene.mlProjection[0].y - (_418 * MacLauncherScene.mlProjection[0].w);
        float _424 = MacLauncherScene.mlProjection[1].y - (_418 * MacLauncherScene.mlProjection[1].w);
        float _425 = _399.x;
        float _427 = _399.y;
        _445 = float2((_424 * _425) - (_415 * _427), (_409 * _427) - (_420 * _425)) / float2((_409 * _424) - (_415 * _420));
    }
    float _465;
    if ((_329 & 2u) != 0u)
    {
        _465 = 1.0;
    }
    else
    {
        _465 = (fast::clamp(length(_380) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectSamplingRadiusNearLimitRec, 0.0, 1.0) * 0.800000011920928955078125) + 0.20000000298023223876953125;
    }
    float _466 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectRadius * _465;
    float _468 = (0.85000002384185791015625 * _466) / length(float3(_445, _281) - _380);
    float _470 = (-1.0) / (_466 * _466);
    uint _476 = uint((_261.y * 2.0) + _261.x) % 5u;
    float2x2 _489 = float2x2(float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[_251][_476].x * _468, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[_251][_476].y * _468), float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[_251][_476].z * _468, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[_251][_476].w * _468));
    float _492 = _281 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthPrecisionOffsetMod;
    float _493 = _492 * MacLauncherScene.mlJitterSign.z;
    float2 _499 = ((_307 * ((_493 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _493)) - MacLauncherScene.mlProjection[3].xy;
    float2 _545;
    if (_331)
    {
        _545 = _499 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _505 = _307.x;
        float _509 = MacLauncherScene.mlProjection[0].x - (_505 * MacLauncherScene.mlProjection[0].w);
        float _515 = MacLauncherScene.mlProjection[1].x - (_505 * MacLauncherScene.mlProjection[1].w);
        float _518 = _307.y;
        float _520 = MacLauncherScene.mlProjection[0].y - (_518 * MacLauncherScene.mlProjection[0].w);
        float _524 = MacLauncherScene.mlProjection[1].y - (_518 * MacLauncherScene.mlProjection[1].w);
        float _525 = _499.x;
        float _527 = _499.y;
        _545 = float2((_524 * _525) - (_515 * _527), (_509 * _527) - (_520 * _525)) / float2((_509 * _524) - (_515 * _520));
    }
    float3 _548 = float3(_545, _492);
    float _550;
    float _553;
    _550 = 0.0;
    _553 = 0.0;
    float _551;
    float _554;
    for (int _555 = 0; _555 < 3; _550 = _551, _553 = _554, _555++)
    {
        float2 _565 = rint(_236[_555].xy * _489);
        float2 _567 = (_565 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _272;
        float3 _572 = float3(_567, _275);
        float4 _574 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _572.xy, uint(rint(_572.z)), level(0.0));
        float _575 = _574.x;
        float2 _578 = ((_567 - _298) * _302) + _306;
        float _579 = _575 * MacLauncherScene.mlJitterSign.z;
        float2 _585 = ((_578 * ((_579 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _579)) - MacLauncherScene.mlProjection[3].xy;
        float2 _631;
        if (_331)
        {
            _631 = _585 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
        }
        else
        {
            float _591 = _578.x;
            float _595 = MacLauncherScene.mlProjection[0].x - (_591 * MacLauncherScene.mlProjection[0].w);
            float _601 = MacLauncherScene.mlProjection[1].x - (_591 * MacLauncherScene.mlProjection[1].w);
            float _604 = _578.y;
            float _606 = MacLauncherScene.mlProjection[0].y - (_604 * MacLauncherScene.mlProjection[0].w);
            float _610 = MacLauncherScene.mlProjection[1].y - (_604 * MacLauncherScene.mlProjection[1].w);
            float _611 = _585.x;
            float _613 = _585.y;
            _631 = float2((_610 * _611) - (_601 * _613), (_595 * _613) - (_606 * _611)) / float2((_595 * _610) - (_601 * _606));
        }
        float3 _635 = float3(_631, _575) - _548;
        float _636 = dot(_635, _635);
        float2 _653 = ((-_565) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _272;
        float3 _658 = float3(_653, _275);
        float4 _660 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _658.xy, uint(rint(_658.z)), level(0.0));
        float _661 = _660.x;
        float2 _664 = ((_653 - _298) * _302) + _306;
        float _665 = _661 * MacLauncherScene.mlJitterSign.z;
        float2 _671 = ((_664 * ((_665 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _665)) - MacLauncherScene.mlProjection[3].xy;
        float2 _717;
        if (_331)
        {
            _717 = _671 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
        }
        else
        {
            float _677 = _664.x;
            float _681 = MacLauncherScene.mlProjection[0].x - (_677 * MacLauncherScene.mlProjection[0].w);
            float _687 = MacLauncherScene.mlProjection[1].x - (_677 * MacLauncherScene.mlProjection[1].w);
            float _690 = _664.y;
            float _692 = MacLauncherScene.mlProjection[0].y - (_690 * MacLauncherScene.mlProjection[0].w);
            float _696 = MacLauncherScene.mlProjection[1].y - (_690 * MacLauncherScene.mlProjection[1].w);
            float _697 = _671.x;
            float _699 = _671.y;
            _717 = float2((_696 * _697) - (_687 * _699), (_681 * _699) - (_692 * _697)) / float2((_681 * _696) - (_687 * _692));
        }
        float3 _721 = float3(_717, _661) - _548;
        float _722 = dot(_721, _721);
        _554 = (_553 + ((precise::max(0.0, (dot(_390, _635) / sqrt(_636)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_636 * _470) + 1.0)) * _236[_555].z)) + ((precise::max(0.0, (dot(_390, _721) / sqrt(_722)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_722 * _470) + 1.0)) * _236[_555].z);
        _551 = (_550 + _236[_555].z) + _236[_555].z;
    }
    uint3 _759 = uint3(int3(int(_258), int(gl_GlobalInvocationID.y), _381));
    g_RwSsaoBufferPing.write(float2(powr(fast::clamp(1.0 - (precise::min(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowStrength * (_553 / _550), SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowClamp) * fast::clamp((_492 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectFadeOutMul) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectFadeOutAdd, 0.0, 1.0)), 0.0, 1.0), SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowPow), dot(rint(float4(3.0499999523162841796875)), float4(0.2509804069995880126953125, 0.062745101749897003173828125, 0.01568627543747425079345703125, 0.0039215688593685626983642578125))).xyyy, uint2(_759.xy), uint(_759.z));
}

)CACAO_GPU";
inline constexpr Binding bindings9[]={{"SSAOConstantsBuffer_t","buffer",0},{"MacLauncherScene","buffer",1},{"g_DeinterleavedDepth","texture",0},{"g_DeinterleavedNormals","texture",1},{"g_RwSsaoBufferPing","texture",2},{"g_PointMirrorSampler","sampler",0},{"g_ViewspaceDepthTapSampler","sampler",1}};
inline constexpr const char*source9=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

struct type_MacLauncherScene
{
    float4 mlProjection[4];
    float4 mlInverse[4];
    float4 mlJitterSign;
    uint4 mlDepthROI;
    float4 mlClip;
};

constant spvUnsafeArray<float4, 32> _246 = spvUnsafeArray<float4, 32>({ float4(0.78488063812255859375, 0.566616714000701904296875, 1.5, -0.12608300149440765380859375), float4(0.26022231578826904296875, -0.2957517206668853759765625, 1.5, -1.06403005123138427734375), float4(0.104593567550182342529296875, 0.083725273609161376953125, 1.11000001430511474609375, -2.7305629253387451171875), float4(-0.68286800384521484375, 0.04963044822216033935546875, 1.09000003337860107421875, -0.4988270103931427001953125), float4(-0.13570161163806915283203125, -0.641901552677154541015625, 1.25, -0.532764971256256103515625), float4(-0.2619379460811614990234375, -0.082051180303096771240234375, 0.670000016689300537109375, -1.78324496746063232421875), float4(-0.61177456378936767578125, 0.66664218902587890625, 0.709999978542327880859375, -0.044234000146389007568359375), float4(0.4367556273937225341796875, 0.251190245151519775390625, 0.61000001430511474609375, -1.16728305816650390625), float4(0.07884444296360015869140625, 0.866186678409576416015625, 0.63999998569488525390625, -0.4590019881725311279296875), float4(-0.12790934741497039794921875, -0.2986900508403778076171875, 0.60000002384185791015625, -1.729423999786376953125), float4(-0.0403112508356571197509765625, 0.0241362191736698150634765625, 0.60000002384185791015625, -4.792041778564453125), float4(0.16201244294643402099609375, -0.5285141468048095703125, 0.790000021457672119140625, -1.0670549869537353515625), float4(-0.70991218090057373046875, 0.473010718822479248046875, 0.63999998569488525390625, -0.335236012935638427734375), float4(0.0327770709991455078125, -0.22349689900875091552734375, 0.60000002384185791015625, -1.9823839664459228515625), float4(0.689217269420623779296875, 0.3680074214935302734375, 0.62999999523162841796875, -0.2667180001735687255859375), float4(0.292518138885498046875, 0.3777541220188140869140625, 0.61000001430511474609375, -1.42252004146575927734375), float4(-0.122240893542766571044921875, 0.96582591533660888671875, 0.60000002384185791015625, -0.4261420071125030517578125), float4(0.11071456968784332275390625, -0.1613105833530426025390625, 0.60000002384185791015625, -2.16594696044921875), float4(0.465621411800384521484375, -0.597476959228515625, 0.60000002384185791015625, -0.1897599995136260986328125), float4(-0.515487968921661376953125, 0.118041932582855224609375, 0.60000002384185791015625, -1.246799945831298828125), float4(0.89141309261322021484375, -0.4209044277667999267578125, 0.60000002384185791015625, 0.02819200046360492706298828125), float4(-0.3240253031253814697265625, -0.01591528952121734619140625, 0.60000002384185791015625, -1.54301798343658447265625), float4(0.607712447643280029296875, 0.416352212429046630859375, 0.60000002384185791015625, -0.605410993099212646484375), float4(0.02379564940929412841796875, -0.082398213446140289306640625, 0.60000002384185791015625, -3.8090460300445556640625), float4(0.4895115196704864501953125, -0.2365704476833343505859375, 0.60000002384185791015625, -1.18901097774505615234375), float4(-0.17611564695835113525390625, -0.8169689178466796875, 0.60000002384185791015625, -0.513724029064178466796875), float4(-0.3393018543720245361328125, -0.20732204616069793701171875, 0.60000002384185791015625, -1.69804704189300537109375), float4(-0.9197442531585693359375, 0.0540320910513401031494140625, 0.60000002384185791015625, 0.0622459985315799713134765625), float4(-0.150646269321441650390625, -0.14949332177639007568359375, 0.60000002384185791015625, -1.89606201648712158203125), float4(0.531809747219085693359375, -0.352104008197784423828125, 0.60000002384185791015625, -0.758837997913360595703125), float4(0.4148716628551483154296875, 0.814425885677337646484375, 0.60000002384185791015625, -0.50564801692962646484375), float4(-0.241069614887237548828125, -0.3272151648998260498046875, 0.60000002384185791015625, -1.66524398326873779296875) });

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], constant type_MacLauncherScene& MacLauncherScene [[buffer(1)]], texture2d_array<float> g_DeinterleavedDepth [[texture(0)]], texture2d_array<float> g_DeinterleavedNormals [[texture(1)]], texture2d_array<float, access::write> g_RwSsaoBufferPing [[texture(2)]], sampler g_PointMirrorSampler [[sampler(0)]], sampler g_ViewspaceDepthTapSampler [[sampler(1)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    uint _253 = gl_GlobalInvocationID.z / 5u;
    bool _260;
    if (_253 == 1u)
    {
        _260 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BlurNumPasses == 2;
    }
    else
    {
        _260 = false;
    }
    uint _261 = _260 ? 3u : _253;
    uint _268 = (5u * gl_GlobalInvocationID.x) + (((gl_GlobalInvocationID.y * 3u) + (gl_GlobalInvocationID.z % 5u)) % 5u);
    float2 _270 = float2(uint2(_268, gl_GlobalInvocationID.y));
    float2 _271 = trunc(_270);
    uint2 _272 = uint2(_271);
    float2 _282 = ((_270 + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferNormalisedOffset;
    float _285 = float(_261);
    float3 _288 = float3(((_270 + float2(1.0)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferNormalisedOffset, _285);
    float4 _290 = g_DeinterleavedDepth.gather(g_PointMirrorSampler, _288.xy, uint(rint(_288.z)), int2(-1), component::x);
    float4 _294 = g_DeinterleavedDepth.gather(g_PointMirrorSampler, _288.xy, uint(rint(_288.z)), int2(0), component::x);
    float _295 = _290.y;
    float _296 = _290.x;
    float _297 = _290.z;
    float _298 = _294.z;
    float _299 = _294.x;
    float2 _303 = (_271 + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions;
    bool _309 = (uint(MacLauncherScene.mlJitterSign.w) & 2u) != 0u;
    float2 _316 = MacLauncherScene.mlJitterSign.xy / float2(MacLauncherScene.mlDepthROI.zw);
    float2 _320 = float2(2.0, float(_309 ? 2 : (-2)));
    float2 _324 = float2(-1.0, float(_309 ? (-1) : 1));
    float2 _325 = ((_303 - _316) * _320) + _324;
    float _328 = _295 * MacLauncherScene.mlJitterSign.z;
    float _336 = (_328 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w;
    float2 _340 = MacLauncherScene.mlProjection[2].xy * _328;
    float2 _344 = ((_325 * _336) - _340) - MacLauncherScene.mlProjection[3].xy;
    uint _347 = uint(MacLauncherScene.mlClip.w);
    bool _349 = (_347 & 1u) != 0u;
    float2 _395;
    if (_349)
    {
        _395 = _344 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _355 = _325.x;
        float _359 = MacLauncherScene.mlProjection[0].x - (_355 * MacLauncherScene.mlProjection[0].w);
        float _365 = MacLauncherScene.mlProjection[1].x - (_355 * MacLauncherScene.mlProjection[1].w);
        float _368 = _325.y;
        float _370 = MacLauncherScene.mlProjection[0].y - (_368 * MacLauncherScene.mlProjection[0].w);
        float _374 = MacLauncherScene.mlProjection[1].y - (_368 * MacLauncherScene.mlProjection[1].w);
        float _375 = _344.x;
        float _377 = _344.y;
        _395 = float2((_374 * _375) - (_365 * _377), (_359 * _377) - (_370 * _375)) / float2((_359 * _374) - (_365 * _370));
    }
    float3 _398 = float3(_395, _295);
    int _399 = int(_261);
    uint3 _405 = uint3(int3(int(_272.x), int(_272.y), _399));
    float3 _408 = g_DeinterleavedNormals.read(uint2(_405.xy), uint(_405.z), 0u).xyz;
    float2 _414 = (((_303 + float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x, 0.0)) - _316) * _320) + _324;
    float2 _417 = ((_414 * _336) - _340) - MacLauncherScene.mlProjection[3].xy;
    float2 _463;
    if (_349)
    {
        _463 = _417 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _423 = _414.x;
        float _427 = MacLauncherScene.mlProjection[0].x - (_423 * MacLauncherScene.mlProjection[0].w);
        float _433 = MacLauncherScene.mlProjection[1].x - (_423 * MacLauncherScene.mlProjection[1].w);
        float _436 = _414.y;
        float _438 = MacLauncherScene.mlProjection[0].y - (_436 * MacLauncherScene.mlProjection[0].w);
        float _442 = MacLauncherScene.mlProjection[1].y - (_436 * MacLauncherScene.mlProjection[1].w);
        float _443 = _417.x;
        float _445 = _417.y;
        _463 = float2((_442 * _443) - (_433 * _445), (_427 * _445) - (_438 * _443)) / float2((_427 * _442) - (_433 * _438));
    }
    float _487;
    if ((_347 & 2u) != 0u)
    {
        _487 = 1.0;
    }
    else
    {
        _487 = (fast::clamp(length(_398) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectSamplingRadiusNearLimitRec, 0.0, 1.0) * 0.800000011920928955078125) + 0.20000000298023223876953125;
    }
    float _488 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectRadius * _487;
    float _490 = (0.85000002384185791015625 * _488) / length(float3(_463, _295) - _398);
    float _491 = _488 * _488;
    float _492 = (-1.0) / _491;
    uint _498 = uint((_271.y * 2.0) + _271.x) % 5u;
    float2x2 _511 = float2x2(float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[_261][_498].x * _490, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[_261][_498].y * _490), float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[_261][_498].z * _490, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[_261][_498].w * _490));
    float _514 = _295 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthPrecisionOffsetMod;
    float _515 = _514 * MacLauncherScene.mlJitterSign.z;
    float2 _521 = ((_325 * ((_515 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _515)) - MacLauncherScene.mlProjection[3].xy;
    float2 _567;
    if (_349)
    {
        _567 = _521 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _527 = _325.x;
        float _531 = MacLauncherScene.mlProjection[0].x - (_527 * MacLauncherScene.mlProjection[0].w);
        float _537 = MacLauncherScene.mlProjection[1].x - (_527 * MacLauncherScene.mlProjection[1].w);
        float _540 = _325.y;
        float _542 = MacLauncherScene.mlProjection[0].y - (_540 * MacLauncherScene.mlProjection[0].w);
        float _546 = MacLauncherScene.mlProjection[1].y - (_540 * MacLauncherScene.mlProjection[1].w);
        float _547 = _521.x;
        float _549 = _521.y;
        _567 = float2((_546 * _547) - (_537 * _549), (_531 * _549) - (_542 * _547)) / float2((_531 * _546) - (_537 * _542));
    }
    float3 _570 = float3(_567, _514);
    float4 _573 = float4(_296, _298, _297, _299) - float4(_295);
    float4 _583 = fast::clamp(float4(1.2999999523162841796875) - (precise::min(abs(_573), abs(_573 + _573.yxwz)) / float4(_295 * 0.039999999105930328369140625)), float4(0.0), float4(1.0));
    float2 _589 = (((_303 + float2(-SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x, 0.0)) - _316) * _320) + _324;
    float _590 = _296 * MacLauncherScene.mlJitterSign.z;
    float2 _596 = ((_589 * ((_590 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _590)) - MacLauncherScene.mlProjection[3].xy;
    float2 _642;
    if (_349)
    {
        _642 = _596 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _602 = _589.x;
        float _606 = MacLauncherScene.mlProjection[0].x - (_602 * MacLauncherScene.mlProjection[0].w);
        float _612 = MacLauncherScene.mlProjection[1].x - (_602 * MacLauncherScene.mlProjection[1].w);
        float _615 = _589.y;
        float _617 = MacLauncherScene.mlProjection[0].y - (_615 * MacLauncherScene.mlProjection[0].w);
        float _621 = MacLauncherScene.mlProjection[1].y - (_615 * MacLauncherScene.mlProjection[1].w);
        float _622 = _596.x;
        float _624 = _596.y;
        _642 = float2((_621 * _622) - (_612 * _624), (_606 * _624) - (_617 * _622)) / float2((_606 * _621) - (_612 * _617));
    }
    float3 _646 = float3(_642, _296) - _570;
    float _647 = _298 * MacLauncherScene.mlJitterSign.z;
    float2 _653 = ((_414 * ((_647 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _647)) - MacLauncherScene.mlProjection[3].xy;
    float2 _699;
    if (_349)
    {
        _699 = _653 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _659 = _414.x;
        float _663 = MacLauncherScene.mlProjection[0].x - (_659 * MacLauncherScene.mlProjection[0].w);
        float _669 = MacLauncherScene.mlProjection[1].x - (_659 * MacLauncherScene.mlProjection[1].w);
        float _672 = _414.y;
        float _674 = MacLauncherScene.mlProjection[0].y - (_672 * MacLauncherScene.mlProjection[0].w);
        float _678 = MacLauncherScene.mlProjection[1].y - (_672 * MacLauncherScene.mlProjection[1].w);
        float _679 = _653.x;
        float _681 = _653.y;
        _699 = float2((_678 * _679) - (_669 * _681), (_663 * _681) - (_674 * _679)) / float2((_663 * _678) - (_669 * _674));
    }
    float3 _703 = float3(_699, _298) - _570;
    float2 _709 = (((_303 + float2(0.0, -SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.y)) - _316) * _320) + _324;
    float _710 = _297 * MacLauncherScene.mlJitterSign.z;
    float2 _716 = ((_709 * ((_710 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _710)) - MacLauncherScene.mlProjection[3].xy;
    float2 _762;
    if (_349)
    {
        _762 = _716 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _722 = _709.x;
        float _726 = MacLauncherScene.mlProjection[0].x - (_722 * MacLauncherScene.mlProjection[0].w);
        float _732 = MacLauncherScene.mlProjection[1].x - (_722 * MacLauncherScene.mlProjection[1].w);
        float _735 = _709.y;
        float _737 = MacLauncherScene.mlProjection[0].y - (_735 * MacLauncherScene.mlProjection[0].w);
        float _741 = MacLauncherScene.mlProjection[1].y - (_735 * MacLauncherScene.mlProjection[1].w);
        float _742 = _716.x;
        float _744 = _716.y;
        _762 = float2((_741 * _742) - (_732 * _744), (_726 * _744) - (_737 * _742)) / float2((_726 * _741) - (_732 * _737));
    }
    float3 _766 = float3(_762, _297) - _570;
    float2 _768 = (((_303 + float2(0.0, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.y)) - _316) * _320) + _324;
    float _769 = _299 * MacLauncherScene.mlJitterSign.z;
    float2 _775 = ((_768 * ((_769 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _769)) - MacLauncherScene.mlProjection[3].xy;
    float2 _821;
    if (_349)
    {
        _821 = _775 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _781 = _768.x;
        float _785 = MacLauncherScene.mlProjection[0].x - (_781 * MacLauncherScene.mlProjection[0].w);
        float _791 = MacLauncherScene.mlProjection[1].x - (_781 * MacLauncherScene.mlProjection[1].w);
        float _794 = _768.y;
        float _796 = MacLauncherScene.mlProjection[0].y - (_794 * MacLauncherScene.mlProjection[0].w);
        float _800 = MacLauncherScene.mlProjection[1].y - (_794 * MacLauncherScene.mlProjection[1].w);
        float _801 = _775.x;
        float _803 = _775.y;
        _821 = float2((_800 * _801) - (_791 * _803), (_785 * _803) - (_796 * _801)) / float2((_785 * _800) - (_791 * _796));
    }
    float3 _825 = float3(_821, _299) - _570;
    float _826 = (-4.0) / _491;
    float _827 = dot(_646, _646);
    float _839 = dot(_703, _703);
    float _849 = dot(_766, _766);
    float _859 = dot(_825, _825);
    float _875;
    float _878;
    _875 = 0.0;
    _878 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DetailAOStrength * dot(float4(precise::max(0.0, (dot(_408, _646) / sqrt(_827)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_827 * _826) + 1.0), precise::max(0.0, (dot(_408, _703) / sqrt(_839)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_839 * _826) + 1.0), precise::max(0.0, (dot(_408, _766) / sqrt(_849)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_849 * _826) + 1.0), precise::max(0.0, (dot(_408, _825) / sqrt(_859)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_859 * _826) + 1.0)), _583);
    float _876;
    float _879;
    for (int _880 = 0; _880 < 5; _875 = _876, _878 = _879, _880++)
    {
        float2 _890 = rint(_246[_880].xy * _511);
        float2 _892 = (_890 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _282;
        float3 _897 = float3(_892, _285);
        float4 _899 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _897.xy, uint(rint(_897.z)), level(0.0));
        float _900 = _899.x;
        float2 _903 = ((_892 - _316) * _320) + _324;
        float _904 = _900 * MacLauncherScene.mlJitterSign.z;
        float2 _910 = ((_903 * ((_904 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _904)) - MacLauncherScene.mlProjection[3].xy;
        float2 _956;
        if (_349)
        {
            _956 = _910 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
        }
        else
        {
            float _916 = _903.x;
            float _920 = MacLauncherScene.mlProjection[0].x - (_916 * MacLauncherScene.mlProjection[0].w);
            float _926 = MacLauncherScene.mlProjection[1].x - (_916 * MacLauncherScene.mlProjection[1].w);
            float _929 = _903.y;
            float _931 = MacLauncherScene.mlProjection[0].y - (_929 * MacLauncherScene.mlProjection[0].w);
            float _935 = MacLauncherScene.mlProjection[1].y - (_929 * MacLauncherScene.mlProjection[1].w);
            float _936 = _910.x;
            float _938 = _910.y;
            _956 = float2((_935 * _936) - (_926 * _938), (_920 * _938) - (_931 * _936)) / float2((_920 * _935) - (_926 * _931));
        }
        float3 _960 = float3(_956, _900) - _570;
        float _961 = dot(_960, _960);
        float _981 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_960.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * _246[_880].z;
        float2 _987 = ((-_890) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _282;
        float3 _992 = float3(_987, _285);
        float4 _994 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _992.xy, uint(rint(_992.z)), level(0.0));
        float _995 = _994.x;
        float2 _998 = ((_987 - _316) * _320) + _324;
        float _999 = _995 * MacLauncherScene.mlJitterSign.z;
        float2 _1005 = ((_998 * ((_999 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _999)) - MacLauncherScene.mlProjection[3].xy;
        float2 _1051;
        if (_349)
        {
            _1051 = _1005 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
        }
        else
        {
            float _1011 = _998.x;
            float _1015 = MacLauncherScene.mlProjection[0].x - (_1011 * MacLauncherScene.mlProjection[0].w);
            float _1021 = MacLauncherScene.mlProjection[1].x - (_1011 * MacLauncherScene.mlProjection[1].w);
            float _1024 = _998.y;
            float _1026 = MacLauncherScene.mlProjection[0].y - (_1024 * MacLauncherScene.mlProjection[0].w);
            float _1030 = MacLauncherScene.mlProjection[1].y - (_1024 * MacLauncherScene.mlProjection[1].w);
            float _1031 = _1005.x;
            float _1033 = _1005.y;
            _1051 = float2((_1030 * _1031) - (_1021 * _1033), (_1015 * _1033) - (_1026 * _1031)) / float2((_1015 * _1030) - (_1021 * _1026));
        }
        float3 _1055 = float3(_1051, _995) - _570;
        float _1056 = dot(_1055, _1055);
        float _1074 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_1055.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * _246[_880].z;
        _879 = (_878 + ((precise::max(0.0, (dot(_408, _960) / sqrt(_961)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_961 * _492) + 1.0)) * _981)) + ((precise::max(0.0, (dot(_408, _1055) / sqrt(_1056)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_1056 * _492) + 1.0)) * _1074);
        _876 = (_875 + _981) + _1074;
    }
    uint3 _1120 = uint3(int3(int(_268), int(gl_GlobalInvocationID.y), _399));
    g_RwSsaoBufferPing.write(float2(powr(fast::clamp(1.0 - (precise::min(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowStrength * (_878 / _875), SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowClamp) * (fast::clamp((_514 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectFadeOutMul) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectFadeOutAdd, 0.0, 1.0) * fast::clamp(1.0 - (fast::clamp(((1.0 - _583.x) - _583.y) * 0.3499999940395355224609375, 0.0, 1.0) + fast::clamp(((1.0 - _583.z) - _583.w) * 0.3499999940395355224609375, 0.0, 1.0)), 0.0, 1.0))), 0.0, 1.0), SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowPow), dot(rint(fast::clamp(_583, float4(0.0), float4(1.0)) * 3.0499999523162841796875), float4(0.2509804069995880126953125, 0.062745101749897003173828125, 0.01568627543747425079345703125, 0.0039215688593685626983642578125))).xyyy, uint2(_1120.xy), uint(_1120.z));
}

)CACAO_GPU";
inline constexpr Binding bindings10[]={{"SSAOConstantsBuffer_t","buffer",0},{"MacLauncherScene","buffer",1},{"g_DeinterleavedDepth","texture",0},{"g_DeinterleavedNormals","texture",1},{"g_RwSsaoBufferPing","texture",2},{"g_PointMirrorSampler","sampler",0},{"g_ViewspaceDepthTapSampler","sampler",1}};
inline constexpr const char*source10=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

struct type_MacLauncherScene
{
    float4 mlProjection[4];
    float4 mlInverse[4];
    float4 mlJitterSign;
    uint4 mlDepthROI;
    float4 mlClip;
};

constant spvUnsafeArray<float4, 32> _247 = spvUnsafeArray<float4, 32>({ float4(0.78488063812255859375, 0.566616714000701904296875, 1.5, -0.12608300149440765380859375), float4(0.26022231578826904296875, -0.2957517206668853759765625, 1.5, -1.06403005123138427734375), float4(0.104593567550182342529296875, 0.083725273609161376953125, 1.11000001430511474609375, -2.7305629253387451171875), float4(-0.68286800384521484375, 0.04963044822216033935546875, 1.09000003337860107421875, -0.4988270103931427001953125), float4(-0.13570161163806915283203125, -0.641901552677154541015625, 1.25, -0.532764971256256103515625), float4(-0.2619379460811614990234375, -0.082051180303096771240234375, 0.670000016689300537109375, -1.78324496746063232421875), float4(-0.61177456378936767578125, 0.66664218902587890625, 0.709999978542327880859375, -0.044234000146389007568359375), float4(0.4367556273937225341796875, 0.251190245151519775390625, 0.61000001430511474609375, -1.16728305816650390625), float4(0.07884444296360015869140625, 0.866186678409576416015625, 0.63999998569488525390625, -0.4590019881725311279296875), float4(-0.12790934741497039794921875, -0.2986900508403778076171875, 0.60000002384185791015625, -1.729423999786376953125), float4(-0.0403112508356571197509765625, 0.0241362191736698150634765625, 0.60000002384185791015625, -4.792041778564453125), float4(0.16201244294643402099609375, -0.5285141468048095703125, 0.790000021457672119140625, -1.0670549869537353515625), float4(-0.70991218090057373046875, 0.473010718822479248046875, 0.63999998569488525390625, -0.335236012935638427734375), float4(0.0327770709991455078125, -0.22349689900875091552734375, 0.60000002384185791015625, -1.9823839664459228515625), float4(0.689217269420623779296875, 0.3680074214935302734375, 0.62999999523162841796875, -0.2667180001735687255859375), float4(0.292518138885498046875, 0.3777541220188140869140625, 0.61000001430511474609375, -1.42252004146575927734375), float4(-0.122240893542766571044921875, 0.96582591533660888671875, 0.60000002384185791015625, -0.4261420071125030517578125), float4(0.11071456968784332275390625, -0.1613105833530426025390625, 0.60000002384185791015625, -2.16594696044921875), float4(0.465621411800384521484375, -0.597476959228515625, 0.60000002384185791015625, -0.1897599995136260986328125), float4(-0.515487968921661376953125, 0.118041932582855224609375, 0.60000002384185791015625, -1.246799945831298828125), float4(0.89141309261322021484375, -0.4209044277667999267578125, 0.60000002384185791015625, 0.02819200046360492706298828125), float4(-0.3240253031253814697265625, -0.01591528952121734619140625, 0.60000002384185791015625, -1.54301798343658447265625), float4(0.607712447643280029296875, 0.416352212429046630859375, 0.60000002384185791015625, -0.605410993099212646484375), float4(0.02379564940929412841796875, -0.082398213446140289306640625, 0.60000002384185791015625, -3.8090460300445556640625), float4(0.4895115196704864501953125, -0.2365704476833343505859375, 0.60000002384185791015625, -1.18901097774505615234375), float4(-0.17611564695835113525390625, -0.8169689178466796875, 0.60000002384185791015625, -0.513724029064178466796875), float4(-0.3393018543720245361328125, -0.20732204616069793701171875, 0.60000002384185791015625, -1.69804704189300537109375), float4(-0.9197442531585693359375, 0.0540320910513401031494140625, 0.60000002384185791015625, 0.0622459985315799713134765625), float4(-0.150646269321441650390625, -0.14949332177639007568359375, 0.60000002384185791015625, -1.89606201648712158203125), float4(0.531809747219085693359375, -0.352104008197784423828125, 0.60000002384185791015625, -0.758837997913360595703125), float4(0.4148716628551483154296875, 0.814425885677337646484375, 0.60000002384185791015625, -0.50564801692962646484375), float4(-0.241069614887237548828125, -0.3272151648998260498046875, 0.60000002384185791015625, -1.66524398326873779296875) });

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], constant type_MacLauncherScene& MacLauncherScene [[buffer(1)]], texture2d_array<float> g_DeinterleavedDepth [[texture(0)]], texture2d_array<float> g_DeinterleavedNormals [[texture(1)]], texture2d_array<float, access::write> g_RwSsaoBufferPing [[texture(2)]], sampler g_PointMirrorSampler [[sampler(0)]], sampler g_ViewspaceDepthTapSampler [[sampler(1)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    float2 _253 = float2(gl_GlobalInvocationID.xy);
    float2 _255 = trunc(_253);
    uint2 _256 = uint2(_255);
    float2 _266 = ((_253 + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferNormalisedOffset;
    float _269 = float(gl_GlobalInvocationID.z);
    float3 _272 = float3(((_253 + float2(1.0)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferNormalisedOffset, _269);
    float4 _274 = g_DeinterleavedDepth.gather(g_PointMirrorSampler, _272.xy, uint(rint(_272.z)), int2(-1), component::x);
    float4 _278 = g_DeinterleavedDepth.gather(g_PointMirrorSampler, _272.xy, uint(rint(_272.z)), int2(0), component::x);
    float _279 = _274.y;
    float _280 = _274.x;
    float _281 = _274.z;
    float _282 = _278.z;
    float _283 = _278.x;
    float2 _287 = (_255 + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions;
    bool _293 = (uint(MacLauncherScene.mlJitterSign.w) & 2u) != 0u;
    float2 _300 = MacLauncherScene.mlJitterSign.xy / float2(MacLauncherScene.mlDepthROI.zw);
    float2 _304 = float2(2.0, float(_293 ? 2 : (-2)));
    float2 _308 = float2(-1.0, float(_293 ? (-1) : 1));
    float2 _309 = ((_287 - _300) * _304) + _308;
    float _312 = _279 * MacLauncherScene.mlJitterSign.z;
    float _320 = (_312 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w;
    float2 _324 = MacLauncherScene.mlProjection[2].xy * _312;
    float2 _328 = ((_309 * _320) - _324) - MacLauncherScene.mlProjection[3].xy;
    uint _331 = uint(MacLauncherScene.mlClip.w);
    bool _333 = (_331 & 1u) != 0u;
    float2 _379;
    if (_333)
    {
        _379 = _328 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _339 = _309.x;
        float _343 = MacLauncherScene.mlProjection[0].x - (_339 * MacLauncherScene.mlProjection[0].w);
        float _349 = MacLauncherScene.mlProjection[1].x - (_339 * MacLauncherScene.mlProjection[1].w);
        float _352 = _309.y;
        float _354 = MacLauncherScene.mlProjection[0].y - (_352 * MacLauncherScene.mlProjection[0].w);
        float _358 = MacLauncherScene.mlProjection[1].y - (_352 * MacLauncherScene.mlProjection[1].w);
        float _359 = _328.x;
        float _361 = _328.y;
        _379 = float2((_358 * _359) - (_349 * _361), (_343 * _361) - (_354 * _359)) / float2((_343 * _358) - (_349 * _354));
    }
    float3 _382 = float3(_379, _279);
    int _383 = int(gl_GlobalInvocationID.z);
    uint3 _389 = uint3(int3(int(_256.x), int(_256.y), _383));
    float3 _392 = g_DeinterleavedNormals.read(uint2(_389.xy), uint(_389.z), 0u).xyz;
    float2 _398 = (((_287 + float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x, 0.0)) - _300) * _304) + _308;
    float2 _401 = ((_398 * _320) - _324) - MacLauncherScene.mlProjection[3].xy;
    float2 _447;
    if (_333)
    {
        _447 = _401 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _407 = _398.x;
        float _411 = MacLauncherScene.mlProjection[0].x - (_407 * MacLauncherScene.mlProjection[0].w);
        float _417 = MacLauncherScene.mlProjection[1].x - (_407 * MacLauncherScene.mlProjection[1].w);
        float _420 = _398.y;
        float _422 = MacLauncherScene.mlProjection[0].y - (_420 * MacLauncherScene.mlProjection[0].w);
        float _426 = MacLauncherScene.mlProjection[1].y - (_420 * MacLauncherScene.mlProjection[1].w);
        _447 = float2((_426 * _401.x) - (_417 * _401.y), (_411 * _401.y) - (_422 * _401.x)) / float2((_411 * _426) - (_417 * _422));
    }
    float _471;
    if ((_331 & 2u) != 0u)
    {
        _471 = 1.0;
    }
    else
    {
        _471 = (fast::clamp(length(_382) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectSamplingRadiusNearLimitRec, 0.0, 1.0) * 0.800000011920928955078125) + 0.20000000298023223876953125;
    }
    float _472 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectRadius * _471;
    float _474 = (0.85000002384185791015625 * _472) / length(float3(_447, _279) - _382);
    float _475 = _472 * _472;
    float _476 = (-1.0) / _475;
    uint _482 = uint((_255.y * 2.0) + _255.x) % 5u;
    float2x2 _495 = float2x2(float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[gl_GlobalInvocationID.z][_482].x * _474, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[gl_GlobalInvocationID.z][_482].y * _474), float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[gl_GlobalInvocationID.z][_482].z * _474, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[gl_GlobalInvocationID.z][_482].w * _474));
    float _498 = _279 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthPrecisionOffsetMod;
    float _499 = _498 * MacLauncherScene.mlJitterSign.z;
    float2 _505 = ((_309 * ((_499 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _499)) - MacLauncherScene.mlProjection[3].xy;
    float2 _551;
    if (_333)
    {
        _551 = _505 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _511 = _309.x;
        float _515 = MacLauncherScene.mlProjection[0].x - (_511 * MacLauncherScene.mlProjection[0].w);
        float _521 = MacLauncherScene.mlProjection[1].x - (_511 * MacLauncherScene.mlProjection[1].w);
        float _524 = _309.y;
        float _526 = MacLauncherScene.mlProjection[0].y - (_524 * MacLauncherScene.mlProjection[0].w);
        float _530 = MacLauncherScene.mlProjection[1].y - (_524 * MacLauncherScene.mlProjection[1].w);
        _551 = float2((_530 * _505.x) - (_521 * _505.y), (_515 * _505.y) - (_526 * _505.x)) / float2((_515 * _530) - (_521 * _526));
    }
    float3 _554 = float3(_551, _498);
    float4 _557 = float4(_280, _282, _281, _283) - float4(_279);
    float4 _567 = fast::clamp(float4(1.2999999523162841796875) - (precise::min(abs(_557), abs(_557 + _557.yxwz)) / float4(_279 * 0.039999999105930328369140625)), float4(0.0), float4(1.0));
    float2 _573 = (((_287 + float2(-SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x, 0.0)) - _300) * _304) + _308;
    float _574 = _280 * MacLauncherScene.mlJitterSign.z;
    float2 _580 = ((_573 * ((_574 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _574)) - MacLauncherScene.mlProjection[3].xy;
    float2 _626;
    if (_333)
    {
        _626 = _580 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _586 = _573.x;
        float _590 = MacLauncherScene.mlProjection[0].x - (_586 * MacLauncherScene.mlProjection[0].w);
        float _596 = MacLauncherScene.mlProjection[1].x - (_586 * MacLauncherScene.mlProjection[1].w);
        float _599 = _573.y;
        float _601 = MacLauncherScene.mlProjection[0].y - (_599 * MacLauncherScene.mlProjection[0].w);
        float _605 = MacLauncherScene.mlProjection[1].y - (_599 * MacLauncherScene.mlProjection[1].w);
        _626 = float2((_605 * _580.x) - (_596 * _580.y), (_590 * _580.y) - (_601 * _580.x)) / float2((_590 * _605) - (_596 * _601));
    }
    float3 _630 = float3(_626, _280) - _554;
    float _631 = _282 * MacLauncherScene.mlJitterSign.z;
    float2 _637 = ((_398 * ((_631 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _631)) - MacLauncherScene.mlProjection[3].xy;
    float2 _683;
    if (_333)
    {
        _683 = _637 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _643 = _398.x;
        float _647 = MacLauncherScene.mlProjection[0].x - (_643 * MacLauncherScene.mlProjection[0].w);
        float _653 = MacLauncherScene.mlProjection[1].x - (_643 * MacLauncherScene.mlProjection[1].w);
        float _656 = _398.y;
        float _658 = MacLauncherScene.mlProjection[0].y - (_656 * MacLauncherScene.mlProjection[0].w);
        float _662 = MacLauncherScene.mlProjection[1].y - (_656 * MacLauncherScene.mlProjection[1].w);
        _683 = float2((_662 * _637.x) - (_653 * _637.y), (_647 * _637.y) - (_658 * _637.x)) / float2((_647 * _662) - (_653 * _658));
    }
    float3 _687 = float3(_683, _282) - _554;
    float2 _693 = (((_287 + float2(0.0, -SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.y)) - _300) * _304) + _308;
    float _694 = _281 * MacLauncherScene.mlJitterSign.z;
    float2 _700 = ((_693 * ((_694 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _694)) - MacLauncherScene.mlProjection[3].xy;
    float2 _746;
    if (_333)
    {
        _746 = _700 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _706 = _693.x;
        float _710 = MacLauncherScene.mlProjection[0].x - (_706 * MacLauncherScene.mlProjection[0].w);
        float _716 = MacLauncherScene.mlProjection[1].x - (_706 * MacLauncherScene.mlProjection[1].w);
        float _719 = _693.y;
        float _721 = MacLauncherScene.mlProjection[0].y - (_719 * MacLauncherScene.mlProjection[0].w);
        float _725 = MacLauncherScene.mlProjection[1].y - (_719 * MacLauncherScene.mlProjection[1].w);
        _746 = float2((_725 * _700.x) - (_716 * _700.y), (_710 * _700.y) - (_721 * _700.x)) / float2((_710 * _725) - (_716 * _721));
    }
    float3 _750 = float3(_746, _281) - _554;
    float2 _752 = (((_287 + float2(0.0, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.y)) - _300) * _304) + _308;
    float _753 = _283 * MacLauncherScene.mlJitterSign.z;
    float2 _759 = ((_752 * ((_753 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _753)) - MacLauncherScene.mlProjection[3].xy;
    float2 _805;
    if (_333)
    {
        _805 = _759 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _765 = _752.x;
        float _769 = MacLauncherScene.mlProjection[0].x - (_765 * MacLauncherScene.mlProjection[0].w);
        float _775 = MacLauncherScene.mlProjection[1].x - (_765 * MacLauncherScene.mlProjection[1].w);
        float _778 = _752.y;
        float _780 = MacLauncherScene.mlProjection[0].y - (_778 * MacLauncherScene.mlProjection[0].w);
        float _784 = MacLauncherScene.mlProjection[1].y - (_778 * MacLauncherScene.mlProjection[1].w);
        _805 = float2((_784 * _759.x) - (_775 * _759.y), (_769 * _759.y) - (_780 * _759.x)) / float2((_769 * _784) - (_775 * _780));
    }
    float3 _809 = float3(_805, _283) - _554;
    float _810 = (-4.0) / _475;
    float _811 = dot(_630, _630);
    float _823 = dot(_687, _687);
    float _833 = dot(_750, _750);
    float _843 = dot(_809, _809);
    uint2 _858 = _256 + uint2(4294967295u, 0u);
    uint3 _864 = uint3(int3(int(_858.x), int(_858.y), _383));
    uint2 _868 = _256 + uint2(1u, 0u);
    uint3 _874 = uint3(int3(int(_868.x), int(_868.y), _383));
    uint2 _878 = _256 + uint2(0u, 4294967295u);
    uint3 _884 = uint3(int3(int(_878.x), int(_878.y), _383));
    uint2 _888 = _256 + uint2(0u, 1u);
    uint3 _894 = uint3(int3(int(_888.x), int(_888.y), _383));
    float4 _911 = _567 * float4(fast::clamp(dot(_392, g_DeinterleavedNormals.read(uint2(_864.xy), uint(_864.z), 0u).xyz) + 0.5, 0.0, 1.0), fast::clamp(dot(_392, g_DeinterleavedNormals.read(uint2(_874.xy), uint(_874.z), 0u).xyz) + 0.5, 0.0, 1.0), fast::clamp(dot(_392, g_DeinterleavedNormals.read(uint2(_884.xy), uint(_884.z), 0u).xyz) + 0.5, 0.0, 1.0), fast::clamp(dot(_392, g_DeinterleavedNormals.read(uint2(_894.xy), uint(_894.z), 0u).xyz) + 0.5, 0.0, 1.0));
    float _913 = log2(_474) + (-4.30000019073486328125);
    float _915;
    float _918;
    _915 = 0.0;
    _918 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DetailAOStrength * dot(float4(precise::max(0.0, (dot(_392, _630) / sqrt(_811)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_811 * _810) + 1.0), precise::max(0.0, (dot(_392, _687) / sqrt(_823)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_823 * _810) + 1.0), precise::max(0.0, (dot(_392, _750) / sqrt(_833)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_833 * _810) + 1.0), precise::max(0.0, (dot(_392, _809) / sqrt(_843)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_843 * _810) + 1.0)), _567);
    float _916;
    float _919;
    for (int _920 = 0; _920 < 12; _915 = _916, _918 = _919, _920++)
    {
        float2 _931 = rint(_247[_920].xy * _495);
        float _932 = _247[_920].w + _913;
        float2 _934 = (_931 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _266;
        float3 _939 = float3(_934, _269);
        float4 _941 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _939.xy, uint(rint(_939.z)), level(_932));
        float _942 = _941.x;
        float2 _945 = ((_934 - _300) * _304) + _308;
        float _946 = _942 * MacLauncherScene.mlJitterSign.z;
        float2 _952 = ((_945 * ((_946 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _946)) - MacLauncherScene.mlProjection[3].xy;
        float2 _998;
        if (_333)
        {
            _998 = _952 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
        }
        else
        {
            float _958 = _945.x;
            float _962 = MacLauncherScene.mlProjection[0].x - (_958 * MacLauncherScene.mlProjection[0].w);
            float _968 = MacLauncherScene.mlProjection[1].x - (_958 * MacLauncherScene.mlProjection[1].w);
            float _971 = _945.y;
            float _973 = MacLauncherScene.mlProjection[0].y - (_971 * MacLauncherScene.mlProjection[0].w);
            float _977 = MacLauncherScene.mlProjection[1].y - (_971 * MacLauncherScene.mlProjection[1].w);
            float _978 = _952.x;
            float _980 = _952.y;
            _998 = float2((_977 * _978) - (_968 * _980), (_962 * _980) - (_973 * _978)) / float2((_962 * _977) - (_968 * _973));
        }
        float3 _1002 = float3(_998, _942) - _554;
        float _1003 = dot(_1002, _1002);
        float _1023 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_1002.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * _247[_920].z;
        float2 _1029 = ((-_931) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _266;
        float3 _1034 = float3(_1029, _269);
        float4 _1036 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _1034.xy, uint(rint(_1034.z)), level(_932));
        float _1037 = _1036.x;
        float2 _1040 = ((_1029 - _300) * _304) + _308;
        float _1041 = _1037 * MacLauncherScene.mlJitterSign.z;
        float2 _1047 = ((_1040 * ((_1041 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _1041)) - MacLauncherScene.mlProjection[3].xy;
        float2 _1093;
        if (_333)
        {
            _1093 = _1047 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
        }
        else
        {
            float _1053 = _1040.x;
            float _1057 = MacLauncherScene.mlProjection[0].x - (_1053 * MacLauncherScene.mlProjection[0].w);
            float _1063 = MacLauncherScene.mlProjection[1].x - (_1053 * MacLauncherScene.mlProjection[1].w);
            float _1066 = _1040.y;
            float _1068 = MacLauncherScene.mlProjection[0].y - (_1066 * MacLauncherScene.mlProjection[0].w);
            float _1072 = MacLauncherScene.mlProjection[1].y - (_1066 * MacLauncherScene.mlProjection[1].w);
            float _1073 = _1047.x;
            float _1075 = _1047.y;
            _1093 = float2((_1072 * _1073) - (_1063 * _1075), (_1057 * _1075) - (_1068 * _1073)) / float2((_1057 * _1072) - (_1063 * _1068));
        }
        float3 _1097 = float3(_1093, _1037) - _554;
        float _1098 = dot(_1097, _1097);
        float _1116 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_1097.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * _247[_920].z;
        _919 = (_918 + ((precise::max(0.0, (dot(_392, _1002) / sqrt(_1003)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_1003 * _476) + 1.0)) * _1023)) + ((precise::max(0.0, (dot(_392, _1097) / sqrt(_1098)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_1098 * _476) + 1.0)) * _1116);
        _916 = (_915 + _1023) + _1116;
    }
    uint3 _1164 = uint3(int3(int(gl_GlobalInvocationID.x), int(gl_GlobalInvocationID.y), _383));
    g_RwSsaoBufferPing.write(float2(powr(fast::clamp(1.0 - (precise::min(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowStrength * (_918 / _915), SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowClamp) * (fast::clamp((_498 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectFadeOutMul) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectFadeOutAdd, 0.0, 1.0) * fast::clamp(1.0 - (fast::clamp(((1.0 - _911.x) - _911.y) * 0.3499999940395355224609375, 0.0, 1.0) + fast::clamp(((1.0 - _911.z) - _911.w) * 0.3499999940395355224609375, 0.0, 1.0)), 0.0, 1.0))), 0.0, 1.0), SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowPow), dot(rint(fast::clamp(_911, float4(0.0), float4(1.0)) * 3.0499999523162841796875), float4(0.2509804069995880126953125, 0.062745101749897003173828125, 0.01568627543747425079345703125, 0.0039215688593685626983642578125))).xyyy, uint2(_1164.xy), uint(_1164.z));
}

)CACAO_GPU";
inline constexpr Binding bindings11[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_LoadCounter","buffer",1},{"MacLauncherScene","buffer",2},{"g_DeinterleavedDepth","texture",0},{"g_DeinterleavedNormals","texture",1},{"g_SsaoBufferPong","texture",2},{"g_ImportanceMap","texture",3},{"g_RwSsaoBufferPing","texture",4},{"g_PointMirrorSampler","sampler",0},{"g_LinearClampSampler","sampler",1},{"g_ViewspaceDepthTapSampler","sampler",2}};
inline constexpr const char*source11=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

struct type_StructuredBuffer_uint
{
    uint _m0[1];
};

struct type_MacLauncherScene
{
    float4 mlProjection[4];
    float4 mlInverse[4];
    float4 mlJitterSign;
    uint4 mlDepthROI;
    float4 mlClip;
};

constant spvUnsafeArray<float4, 32> _266 = spvUnsafeArray<float4, 32>({ float4(0.78488063812255859375, 0.566616714000701904296875, 1.5, -0.12608300149440765380859375), float4(0.26022231578826904296875, -0.2957517206668853759765625, 1.5, -1.06403005123138427734375), float4(0.104593567550182342529296875, 0.083725273609161376953125, 1.11000001430511474609375, -2.7305629253387451171875), float4(-0.68286800384521484375, 0.04963044822216033935546875, 1.09000003337860107421875, -0.4988270103931427001953125), float4(-0.13570161163806915283203125, -0.641901552677154541015625, 1.25, -0.532764971256256103515625), float4(-0.2619379460811614990234375, -0.082051180303096771240234375, 0.670000016689300537109375, -1.78324496746063232421875), float4(-0.61177456378936767578125, 0.66664218902587890625, 0.709999978542327880859375, -0.044234000146389007568359375), float4(0.4367556273937225341796875, 0.251190245151519775390625, 0.61000001430511474609375, -1.16728305816650390625), float4(0.07884444296360015869140625, 0.866186678409576416015625, 0.63999998569488525390625, -0.4590019881725311279296875), float4(-0.12790934741497039794921875, -0.2986900508403778076171875, 0.60000002384185791015625, -1.729423999786376953125), float4(-0.0403112508356571197509765625, 0.0241362191736698150634765625, 0.60000002384185791015625, -4.792041778564453125), float4(0.16201244294643402099609375, -0.5285141468048095703125, 0.790000021457672119140625, -1.0670549869537353515625), float4(-0.70991218090057373046875, 0.473010718822479248046875, 0.63999998569488525390625, -0.335236012935638427734375), float4(0.0327770709991455078125, -0.22349689900875091552734375, 0.60000002384185791015625, -1.9823839664459228515625), float4(0.689217269420623779296875, 0.3680074214935302734375, 0.62999999523162841796875, -0.2667180001735687255859375), float4(0.292518138885498046875, 0.3777541220188140869140625, 0.61000001430511474609375, -1.42252004146575927734375), float4(-0.122240893542766571044921875, 0.96582591533660888671875, 0.60000002384185791015625, -0.4261420071125030517578125), float4(0.11071456968784332275390625, -0.1613105833530426025390625, 0.60000002384185791015625, -2.16594696044921875), float4(0.465621411800384521484375, -0.597476959228515625, 0.60000002384185791015625, -0.1897599995136260986328125), float4(-0.515487968921661376953125, 0.118041932582855224609375, 0.60000002384185791015625, -1.246799945831298828125), float4(0.89141309261322021484375, -0.4209044277667999267578125, 0.60000002384185791015625, 0.02819200046360492706298828125), float4(-0.3240253031253814697265625, -0.01591528952121734619140625, 0.60000002384185791015625, -1.54301798343658447265625), float4(0.607712447643280029296875, 0.416352212429046630859375, 0.60000002384185791015625, -0.605410993099212646484375), float4(0.02379564940929412841796875, -0.082398213446140289306640625, 0.60000002384185791015625, -3.8090460300445556640625), float4(0.4895115196704864501953125, -0.2365704476833343505859375, 0.60000002384185791015625, -1.18901097774505615234375), float4(-0.17611564695835113525390625, -0.8169689178466796875, 0.60000002384185791015625, -0.513724029064178466796875), float4(-0.3393018543720245361328125, -0.20732204616069793701171875, 0.60000002384185791015625, -1.69804704189300537109375), float4(-0.9197442531585693359375, 0.0540320910513401031494140625, 0.60000002384185791015625, 0.0622459985315799713134765625), float4(-0.150646269321441650390625, -0.14949332177639007568359375, 0.60000002384185791015625, -1.89606201648712158203125), float4(0.531809747219085693359375, -0.352104008197784423828125, 0.60000002384185791015625, -0.758837997913360595703125), float4(0.4148716628551483154296875, 0.814425885677337646484375, 0.60000002384185791015625, -0.50564801692962646484375), float4(-0.241069614887237548828125, -0.3272151648998260498046875, 0.60000002384185791015625, -1.66524398326873779296875) });

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], const device type_StructuredBuffer_uint& g_LoadCounter [[buffer(1)]], constant type_MacLauncherScene& MacLauncherScene [[buffer(2)]], texture2d_array<float> g_DeinterleavedDepth [[texture(0)]], texture2d_array<float> g_DeinterleavedNormals [[texture(1)]], texture2d_array<float> g_SsaoBufferPong [[texture(2)]], texture2d<float> g_ImportanceMap [[texture(3)]], texture2d_array<float, access::write> g_RwSsaoBufferPing [[texture(4)]], sampler g_PointMirrorSampler [[sampler(0)]], sampler g_LinearClampSampler [[sampler(1)]], sampler g_ViewspaceDepthTapSampler [[sampler(2)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    float2 _274 = float2(gl_GlobalInvocationID.xy);
    float2 _276 = trunc(_274);
    uint2 _277 = uint2(_276);
    float2 _287 = ((_274 + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferNormalisedOffset;
    float _290 = float(gl_GlobalInvocationID.z);
    float3 _293 = float3(((_274 + float2(1.0)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferNormalisedOffset, _290);
    float4 _295 = g_DeinterleavedDepth.gather(g_PointMirrorSampler, _293.xy, uint(rint(_293.z)), int2(-1), component::x);
    float4 _299 = g_DeinterleavedDepth.gather(g_PointMirrorSampler, _293.xy, uint(rint(_293.z)), int2(0), component::x);
    float _300 = _295.y;
    float _301 = _295.x;
    float _302 = _295.z;
    float _303 = _299.z;
    float _304 = _299.x;
    float2 _308 = (_276 + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions;
    bool _314 = (uint(MacLauncherScene.mlJitterSign.w) & 2u) != 0u;
    float2 _321 = MacLauncherScene.mlJitterSign.xy / float2(MacLauncherScene.mlDepthROI.zw);
    float2 _325 = float2(2.0, float(_314 ? 2 : (-2)));
    float2 _329 = float2(-1.0, float(_314 ? (-1) : 1));
    float2 _330 = ((_308 - _321) * _325) + _329;
    float _333 = _300 * MacLauncherScene.mlJitterSign.z;
    float _341 = (_333 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w;
    float2 _345 = MacLauncherScene.mlProjection[2].xy * _333;
    float2 _349 = ((_330 * _341) - _345) - MacLauncherScene.mlProjection[3].xy;
    uint _352 = uint(MacLauncherScene.mlClip.w);
    bool _354 = (_352 & 1u) != 0u;
    float2 _400;
    if (_354)
    {
        _400 = _349 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _360 = _330.x;
        float _364 = MacLauncherScene.mlProjection[0].x - (_360 * MacLauncherScene.mlProjection[0].w);
        float _370 = MacLauncherScene.mlProjection[1].x - (_360 * MacLauncherScene.mlProjection[1].w);
        float _373 = _330.y;
        float _375 = MacLauncherScene.mlProjection[0].y - (_373 * MacLauncherScene.mlProjection[0].w);
        float _379 = MacLauncherScene.mlProjection[1].y - (_373 * MacLauncherScene.mlProjection[1].w);
        float _380 = _349.x;
        float _382 = _349.y;
        _400 = float2((_379 * _380) - (_370 * _382), (_364 * _382) - (_375 * _380)) / float2((_364 * _379) - (_370 * _375));
    }
    float3 _403 = float3(_400, _300);
    int _404 = int(gl_GlobalInvocationID.z);
    int _407 = int(_277.x);
    int _408 = int(_277.y);
    uint3 _410 = uint3(int3(_407, _408, _404));
    float3 _413 = g_DeinterleavedNormals.read(uint2(_410.xy), uint(_410.z), 0u).xyz;
    float2 _419 = (((_308 + float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x, 0.0)) - _321) * _325) + _329;
    float2 _422 = ((_419 * _341) - _345) - MacLauncherScene.mlProjection[3].xy;
    float2 _468;
    if (_354)
    {
        _468 = _422 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _428 = _419.x;
        float _432 = MacLauncherScene.mlProjection[0].x - (_428 * MacLauncherScene.mlProjection[0].w);
        float _438 = MacLauncherScene.mlProjection[1].x - (_428 * MacLauncherScene.mlProjection[1].w);
        float _441 = _419.y;
        float _443 = MacLauncherScene.mlProjection[0].y - (_441 * MacLauncherScene.mlProjection[0].w);
        float _447 = MacLauncherScene.mlProjection[1].y - (_441 * MacLauncherScene.mlProjection[1].w);
        _468 = float2((_447 * _422.x) - (_438 * _422.y), (_432 * _422.y) - (_443 * _422.x)) / float2((_432 * _447) - (_438 * _443));
    }
    float _492;
    if ((_352 & 2u) != 0u)
    {
        _492 = 1.0;
    }
    else
    {
        _492 = (fast::clamp(length(_403) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectSamplingRadiusNearLimitRec, 0.0, 1.0) * 0.800000011920928955078125) + 0.20000000298023223876953125;
    }
    float _493 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectRadius * _492;
    float _495 = (0.85000002384185791015625 * _493) / length(float3(_468, _300) - _403);
    float _496 = _493 * _493;
    float _497 = (-1.0) / _496;
    uint _503 = uint((_276.y * 2.0) + _276.x) % 5u;
    float2x2 _516 = float2x2(float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[gl_GlobalInvocationID.z][_503].x * _495, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[gl_GlobalInvocationID.z][_503].y * _495), float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[gl_GlobalInvocationID.z][_503].z * _495, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[gl_GlobalInvocationID.z][_503].w * _495));
    float _519 = _300 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthPrecisionOffsetMod;
    float _520 = _519 * MacLauncherScene.mlJitterSign.z;
    float2 _526 = ((_330 * ((_520 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _520)) - MacLauncherScene.mlProjection[3].xy;
    float2 _572;
    if (_354)
    {
        _572 = _526 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _532 = _330.x;
        float _536 = MacLauncherScene.mlProjection[0].x - (_532 * MacLauncherScene.mlProjection[0].w);
        float _542 = MacLauncherScene.mlProjection[1].x - (_532 * MacLauncherScene.mlProjection[1].w);
        float _545 = _330.y;
        float _547 = MacLauncherScene.mlProjection[0].y - (_545 * MacLauncherScene.mlProjection[0].w);
        float _551 = MacLauncherScene.mlProjection[1].y - (_545 * MacLauncherScene.mlProjection[1].w);
        _572 = float2((_551 * _526.x) - (_542 * _526.y), (_536 * _526.y) - (_547 * _526.x)) / float2((_536 * _551) - (_542 * _547));
    }
    float3 _575 = float3(_572, _519);
    float4 _578 = float4(_301, _303, _302, _304) - float4(_300);
    float4 _588 = fast::clamp(float4(1.2999999523162841796875) - (precise::min(abs(_578), abs(_578 + _578.yxwz)) / float4(_300 * 0.039999999105930328369140625)), float4(0.0), float4(1.0));
    float2 _594 = (((_308 + float2(-SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x, 0.0)) - _321) * _325) + _329;
    float _595 = _301 * MacLauncherScene.mlJitterSign.z;
    float2 _601 = ((_594 * ((_595 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _595)) - MacLauncherScene.mlProjection[3].xy;
    float2 _647;
    if (_354)
    {
        _647 = _601 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _607 = _594.x;
        float _611 = MacLauncherScene.mlProjection[0].x - (_607 * MacLauncherScene.mlProjection[0].w);
        float _617 = MacLauncherScene.mlProjection[1].x - (_607 * MacLauncherScene.mlProjection[1].w);
        float _620 = _594.y;
        float _622 = MacLauncherScene.mlProjection[0].y - (_620 * MacLauncherScene.mlProjection[0].w);
        float _626 = MacLauncherScene.mlProjection[1].y - (_620 * MacLauncherScene.mlProjection[1].w);
        _647 = float2((_626 * _601.x) - (_617 * _601.y), (_611 * _601.y) - (_622 * _601.x)) / float2((_611 * _626) - (_617 * _622));
    }
    float3 _651 = float3(_647, _301) - _575;
    float _652 = _303 * MacLauncherScene.mlJitterSign.z;
    float2 _658 = ((_419 * ((_652 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _652)) - MacLauncherScene.mlProjection[3].xy;
    float2 _704;
    if (_354)
    {
        _704 = _658 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _664 = _419.x;
        float _668 = MacLauncherScene.mlProjection[0].x - (_664 * MacLauncherScene.mlProjection[0].w);
        float _674 = MacLauncherScene.mlProjection[1].x - (_664 * MacLauncherScene.mlProjection[1].w);
        float _677 = _419.y;
        float _679 = MacLauncherScene.mlProjection[0].y - (_677 * MacLauncherScene.mlProjection[0].w);
        float _683 = MacLauncherScene.mlProjection[1].y - (_677 * MacLauncherScene.mlProjection[1].w);
        _704 = float2((_683 * _658.x) - (_674 * _658.y), (_668 * _658.y) - (_679 * _658.x)) / float2((_668 * _683) - (_674 * _679));
    }
    float3 _708 = float3(_704, _303) - _575;
    float2 _714 = (((_308 + float2(0.0, -SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.y)) - _321) * _325) + _329;
    float _715 = _302 * MacLauncherScene.mlJitterSign.z;
    float2 _721 = ((_714 * ((_715 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _715)) - MacLauncherScene.mlProjection[3].xy;
    float2 _767;
    if (_354)
    {
        _767 = _721 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _727 = _714.x;
        float _731 = MacLauncherScene.mlProjection[0].x - (_727 * MacLauncherScene.mlProjection[0].w);
        float _737 = MacLauncherScene.mlProjection[1].x - (_727 * MacLauncherScene.mlProjection[1].w);
        float _740 = _714.y;
        float _742 = MacLauncherScene.mlProjection[0].y - (_740 * MacLauncherScene.mlProjection[0].w);
        float _746 = MacLauncherScene.mlProjection[1].y - (_740 * MacLauncherScene.mlProjection[1].w);
        _767 = float2((_746 * _721.x) - (_737 * _721.y), (_731 * _721.y) - (_742 * _721.x)) / float2((_731 * _746) - (_737 * _742));
    }
    float3 _771 = float3(_767, _302) - _575;
    float2 _773 = (((_308 + float2(0.0, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.y)) - _321) * _325) + _329;
    float _774 = _304 * MacLauncherScene.mlJitterSign.z;
    float2 _780 = ((_773 * ((_774 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _774)) - MacLauncherScene.mlProjection[3].xy;
    float2 _826;
    if (_354)
    {
        _826 = _780 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _786 = _773.x;
        float _790 = MacLauncherScene.mlProjection[0].x - (_786 * MacLauncherScene.mlProjection[0].w);
        float _796 = MacLauncherScene.mlProjection[1].x - (_786 * MacLauncherScene.mlProjection[1].w);
        float _799 = _773.y;
        float _801 = MacLauncherScene.mlProjection[0].y - (_799 * MacLauncherScene.mlProjection[0].w);
        float _805 = MacLauncherScene.mlProjection[1].y - (_799 * MacLauncherScene.mlProjection[1].w);
        _826 = float2((_805 * _780.x) - (_796 * _780.y), (_790 * _780.y) - (_801 * _780.x)) / float2((_790 * _805) - (_796 * _801));
    }
    float3 _830 = float3(_826, _304) - _575;
    float _831 = (-4.0) / _496;
    float _832 = dot(_651, _651);
    float _844 = dot(_708, _708);
    float _854 = dot(_771, _771);
    float _864 = dot(_830, _830);
    uint2 _879 = _277 + uint2(4294967295u, 0u);
    uint3 _885 = uint3(int3(int(_879.x), int(_879.y), _404));
    uint2 _889 = _277 + uint2(1u, 0u);
    uint3 _895 = uint3(int3(int(_889.x), int(_889.y), _404));
    uint2 _899 = _277 + uint2(0u, 4294967295u);
    uint3 _905 = uint3(int3(int(_899.x), int(_899.y), _404));
    uint2 _909 = _277 + uint2(0u, 1u);
    uint3 _915 = uint3(int3(int(_909.x), int(_909.y), _404));
    float4 _932 = _588 * float4(fast::clamp(dot(_413, g_DeinterleavedNormals.read(uint2(_885.xy), uint(_885.z), 0u).xyz) + 0.5, 0.0, 1.0), fast::clamp(dot(_413, g_DeinterleavedNormals.read(uint2(_895.xy), uint(_895.z), 0u).xyz) + 0.5, 0.0, 1.0), fast::clamp(dot(_413, g_DeinterleavedNormals.read(uint2(_905.xy), uint(_905.z), 0u).xyz) + 0.5, 0.0, 1.0), fast::clamp(dot(_413, g_DeinterleavedNormals.read(uint2(_915.xy), uint(_915.z), 0u).xyz) + 0.5, 0.0, 1.0));
    float _934 = log2(_495) + (-4.30000019073486328125);
    float4 _942 = g_ImportanceMap.sample(g_LinearClampSampler, (_308 + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PerPassFullResUVOffset[gl_GlobalInvocationID.z].xy), level(0.0));
    float _943 = _942.x;
    int3 _948 = int4(_407, _408, _404, 0).xyz;
    float4 _950 = g_SsaoBufferPong.read(uint2(_948.xy), uint(_948.z), 0);
    float _952 = _950.y * 20.0;
    uint _971 = min(31u, (uint((27.0 * (_943 * fast::clamp(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.AdaptiveSampleCountLimit / (float(g_LoadCounter._m0[0u]) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.LoadCounterAvgDiv), 0.0, 1.0))) + 1.5) + 5u));
    float2 _977 = rint(_266[5].xy * _516) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions;
    float _979 = _266[5].w + _934;
    float2 _980 = _287 + _977;
    float _983 = _980.x;
    float3 _985 = float3(_983, _980.y, _290);
    float2 _990 = _287 - _977;
    float _993 = _990.x;
    float3 _995 = float3(_993, _990.y, _290);
    float4 _1003;
    float _1006;
    float _1008;
    float3 _1010;
    float3 _1012;
    _1003 = _266[6];
    _1006 = _952;
    _1008 = ((SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DetailAOStrength * dot(float4(precise::max(0.0, (dot(_413, _651) / sqrt(_832)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_832 * _831) + 1.0), precise::max(0.0, (dot(_413, _708) / sqrt(_844)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_844 * _831) + 1.0), precise::max(0.0, (dot(_413, _771) / sqrt(_854)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_854 * _831) + 1.0), precise::max(0.0, (dot(_413, _830) / sqrt(_864)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_864 * _831) + 1.0)), _588)) * (0.15625 + (_943 * 0.84375))) + (_950.x * _952);
    _1010 = float3(_983, _980.y, g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _985.xy, uint(rint(_985.z)), level(_979)).x);
    _1012 = float3(_993, _990.y, g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _995.xy, uint(rint(_995.z)), level(_979)).x);
    float4 _1004;
    float _1007;
    float _1009;
    float3 _1011;
    float3 _1013;
    for (uint _1014 = 5u; _1014 < (_971 - 1u); _1003 = _1004, _1006 = _1007, _1008 = _1009, _1010 = _1011, _1012 = _1013, _1014++)
    {
        float2 _1023 = rint(_1003.xy * _516) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions;
        float _1025 = _1003.w + _934;
        _1004 = _266[_1014 + 2u];
        float2 _1028 = _287 + _1023;
        float _1031 = _1028.x;
        float3 _1033 = float3(_1031, _1028.y, _290);
        _1011 = float3(_1031, _1028.y, g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _1033.xy, uint(rint(_1033.z)), level(_1025)).x);
        float2 _1037 = _287 - _1023;
        float _1040 = _1037.x;
        float3 _1042 = float3(_1040, _1037.y, _290);
        _1013 = float3(_1040, _1037.y, g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _1042.xy, uint(rint(_1042.z)), level(_1025)).x);
        float2 _1050 = ((_1010.xy - _321) * _325) + _329;
        float _1051 = _1010.z * MacLauncherScene.mlJitterSign.z;
        float2 _1057 = ((_1050 * ((_1051 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _1051)) - MacLauncherScene.mlProjection[3].xy;
        float2 _1103;
        if (_354)
        {
            _1103 = _1057 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
        }
        else
        {
            float _1063 = _1050.x;
            float _1067 = MacLauncherScene.mlProjection[0].x - (_1063 * MacLauncherScene.mlProjection[0].w);
            float _1073 = MacLauncherScene.mlProjection[1].x - (_1063 * MacLauncherScene.mlProjection[1].w);
            float _1076 = _1050.y;
            float _1078 = MacLauncherScene.mlProjection[0].y - (_1076 * MacLauncherScene.mlProjection[0].w);
            float _1082 = MacLauncherScene.mlProjection[1].y - (_1076 * MacLauncherScene.mlProjection[1].w);
            float _1083 = _1057.x;
            float _1085 = _1057.y;
            _1103 = float2((_1082 * _1083) - (_1073 * _1085), (_1067 * _1085) - (_1078 * _1083)) / float2((_1067 * _1082) - (_1073 * _1078));
        }
        float3 _1107 = float3(_1103, _1010.z) - _575;
        float _1108 = dot(_1107, _1107);
        float _1127 = (0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_1107.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625;
        float2 _1135 = ((_1012.xy - _321) * _325) + _329;
        float _1136 = _1012.z * MacLauncherScene.mlJitterSign.z;
        float2 _1142 = ((_1135 * ((_1136 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _1136)) - MacLauncherScene.mlProjection[3].xy;
        float2 _1188;
        if (_354)
        {
            _1188 = _1142 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
        }
        else
        {
            float _1148 = _1135.x;
            float _1152 = MacLauncherScene.mlProjection[0].x - (_1148 * MacLauncherScene.mlProjection[0].w);
            float _1158 = MacLauncherScene.mlProjection[1].x - (_1148 * MacLauncherScene.mlProjection[1].w);
            float _1161 = _1135.y;
            float _1163 = MacLauncherScene.mlProjection[0].y - (_1161 * MacLauncherScene.mlProjection[0].w);
            float _1167 = MacLauncherScene.mlProjection[1].y - (_1161 * MacLauncherScene.mlProjection[1].w);
            float _1168 = _1142.x;
            float _1170 = _1142.y;
            _1188 = float2((_1167 * _1168) - (_1158 * _1170), (_1152 * _1170) - (_1163 * _1168)) / float2((_1152 * _1167) - (_1158 * _1163));
        }
        float3 _1192 = float3(_1188, _1012.z) - _575;
        float _1193 = dot(_1192, _1192);
        float _1210 = (0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_1192.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625;
        _1009 = (_1008 + ((precise::max(0.0, (dot(_413, _1107) / sqrt(_1108)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_1108 * _497) + 1.0)) * _1127)) + ((precise::max(0.0, (dot(_413, _1192) / sqrt(_1193)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_1193 * _497) + 1.0)) * _1210);
        _1007 = (_1006 + _1127) + _1210;
    }
    float2 _1216 = ((_1010.xy - _321) * _325) + _329;
    float _1217 = _1010.z * MacLauncherScene.mlJitterSign.z;
    float2 _1223 = ((_1216 * ((_1217 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _1217)) - MacLauncherScene.mlProjection[3].xy;
    float2 _1269;
    if (_354)
    {
        _1269 = _1223 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _1229 = _1216.x;
        float _1233 = MacLauncherScene.mlProjection[0].x - (_1229 * MacLauncherScene.mlProjection[0].w);
        float _1239 = MacLauncherScene.mlProjection[1].x - (_1229 * MacLauncherScene.mlProjection[1].w);
        float _1242 = _1216.y;
        float _1244 = MacLauncherScene.mlProjection[0].y - (_1242 * MacLauncherScene.mlProjection[0].w);
        float _1248 = MacLauncherScene.mlProjection[1].y - (_1242 * MacLauncherScene.mlProjection[1].w);
        float _1249 = _1223.x;
        float _1251 = _1223.y;
        _1269 = float2((_1248 * _1249) - (_1239 * _1251), (_1233 * _1251) - (_1244 * _1249)) / float2((_1233 * _1248) - (_1239 * _1244));
    }
    float3 _1273 = float3(_1269, _1010.z) - _575;
    float _1274 = dot(_1273, _1273);
    float _1293 = (0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_1273.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625;
    float2 _1301 = ((_1012.xy - _321) * _325) + _329;
    float _1302 = _1012.z * MacLauncherScene.mlJitterSign.z;
    float2 _1308 = ((_1301 * ((_1302 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _1302)) - MacLauncherScene.mlProjection[3].xy;
    float2 _1354;
    if (_354)
    {
        _1354 = _1308 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _1314 = _1301.x;
        float _1318 = MacLauncherScene.mlProjection[0].x - (_1314 * MacLauncherScene.mlProjection[0].w);
        float _1324 = MacLauncherScene.mlProjection[1].x - (_1314 * MacLauncherScene.mlProjection[1].w);
        float _1327 = _1301.y;
        float _1329 = MacLauncherScene.mlProjection[0].y - (_1327 * MacLauncherScene.mlProjection[0].w);
        float _1333 = MacLauncherScene.mlProjection[1].y - (_1327 * MacLauncherScene.mlProjection[1].w);
        float _1334 = _1308.x;
        float _1336 = _1308.y;
        _1354 = float2((_1333 * _1334) - (_1324 * _1336), (_1318 * _1336) - (_1329 * _1334)) / float2((_1318 * _1333) - (_1324 * _1329));
    }
    float3 _1358 = float3(_1354, _1012.z) - _575;
    float _1359 = dot(_1358, _1358);
    float _1376 = (0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_1358.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625;
    float _1411 = 1.0 - (precise::min(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowStrength * (((_1008 + ((precise::max(0.0, (dot(_413, _1273) / sqrt(_1274)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_1274 * _497) + 1.0)) * _1293)) + ((precise::max(0.0, (dot(_413, _1358) / sqrt(_1359)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_1359 * _497) + 1.0)) * _1376)) / ((_1006 + _1293) + _1376)), SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowClamp) * (fast::clamp((_519 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectFadeOutMul) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectFadeOutAdd, 0.0, 1.0) * fast::clamp(1.0 - (fast::clamp(((1.0 - _932.x) - _932.y) * 0.3499999940395355224609375, 0.0, 1.0) + fast::clamp(((1.0 - _932.z) - _932.w) * 0.3499999940395355224609375, 0.0, 1.0)), 0.0, 1.0)));
    uint3 _1426 = uint3(int3(int(gl_GlobalInvocationID.x), int(gl_GlobalInvocationID.y), _404));
    g_RwSsaoBufferPing.write(float2(powr(fast::clamp(_1411, 0.0, 1.0), SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowPow), dot(rint(fast::clamp(_932, float4(0.0), float4(1.0)) * 3.0499999523162841796875), float4(0.2509804069995880126953125, 0.062745101749897003173828125, 0.01568627543747425079345703125, 0.0039215688593685626983642578125))).xyyy, uint2(_1426.xy), uint(_1426.z));
}

)CACAO_GPU";
inline constexpr Binding bindings12[]={{"SSAOConstantsBuffer_t","buffer",0},{"MacLauncherScene","buffer",1},{"g_DeinterleavedDepth","texture",0},{"g_DeinterleavedNormals","texture",1},{"g_RwSsaoBufferPing","texture",2},{"g_PointMirrorSampler","sampler",0},{"g_ViewspaceDepthTapSampler","sampler",1}};
inline constexpr const char*source12=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

struct type_MacLauncherScene
{
    float4 mlProjection[4];
    float4 mlInverse[4];
    float4 mlJitterSign;
    uint4 mlDepthROI;
    float4 mlClip;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], constant type_MacLauncherScene& MacLauncherScene [[buffer(1)]], texture2d_array<float> g_DeinterleavedDepth [[texture(0)]], texture2d_array<float> g_DeinterleavedNormals [[texture(1)]], texture2d_array<float, access::write> g_RwSsaoBufferPing [[texture(2)]], sampler g_PointMirrorSampler [[sampler(0)]], sampler g_ViewspaceDepthTapSampler [[sampler(1)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    float2 _109 = float2(gl_GlobalInvocationID.xy);
    float2 _111 = trunc(_109);
    uint2 _112 = uint2(_111);
    float2 _122 = ((_109 + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferNormalisedOffset;
    float _125 = float(gl_GlobalInvocationID.z);
    float3 _128 = float3(((_109 + float2(1.0)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferNormalisedOffset, _125);
    float4 _130 = g_DeinterleavedDepth.gather(g_PointMirrorSampler, _128.xy, uint(rint(_128.z)), int2(-1), component::x);
    float _131 = _130.y;
    float2 _135 = (_111 + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions;
    bool _141 = (uint(MacLauncherScene.mlJitterSign.w) & 2u) != 0u;
    float2 _148 = MacLauncherScene.mlJitterSign.xy / float2(MacLauncherScene.mlDepthROI.zw);
    float2 _152 = float2(2.0, float(_141 ? 2 : (-2)));
    float2 _156 = float2(-1.0, float(_141 ? (-1) : 1));
    float2 _157 = ((_135 - _148) * _152) + _156;
    float _160 = _131 * MacLauncherScene.mlJitterSign.z;
    float _168 = (_160 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w;
    float2 _172 = MacLauncherScene.mlProjection[2].xy * _160;
    float2 _176 = ((_157 * _168) - _172) - MacLauncherScene.mlProjection[3].xy;
    uint _179 = uint(MacLauncherScene.mlClip.w);
    bool _181 = (_179 & 1u) != 0u;
    float2 _227;
    if (_181)
    {
        _227 = _176 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _187 = _157.x;
        float _191 = MacLauncherScene.mlProjection[0].x - (_187 * MacLauncherScene.mlProjection[0].w);
        float _197 = MacLauncherScene.mlProjection[1].x - (_187 * MacLauncherScene.mlProjection[1].w);
        float _200 = _157.y;
        float _202 = MacLauncherScene.mlProjection[0].y - (_200 * MacLauncherScene.mlProjection[0].w);
        float _206 = MacLauncherScene.mlProjection[1].y - (_200 * MacLauncherScene.mlProjection[1].w);
        float _207 = _176.x;
        float _209 = _176.y;
        _227 = float2((_206 * _207) - (_197 * _209), (_191 * _209) - (_202 * _207)) / float2((_191 * _206) - (_197 * _202));
    }
    float3 _230 = float3(_227, _131);
    int _231 = int(gl_GlobalInvocationID.z);
    uint3 _237 = uint3(int3(int(_112.x), int(_112.y), _231));
    float3 _240 = g_DeinterleavedNormals.read(uint2(_237.xy), uint(_237.z), 0u).xyz;
    float2 _246 = (((_135 + float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x, 0.0)) - _148) * _152) + _156;
    float2 _249 = ((_246 * _168) - _172) - MacLauncherScene.mlProjection[3].xy;
    float2 _295;
    if (_181)
    {
        _295 = _249 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _255 = _246.x;
        float _259 = MacLauncherScene.mlProjection[0].x - (_255 * MacLauncherScene.mlProjection[0].w);
        float _265 = MacLauncherScene.mlProjection[1].x - (_255 * MacLauncherScene.mlProjection[1].w);
        float _268 = _246.y;
        float _270 = MacLauncherScene.mlProjection[0].y - (_268 * MacLauncherScene.mlProjection[0].w);
        float _274 = MacLauncherScene.mlProjection[1].y - (_268 * MacLauncherScene.mlProjection[1].w);
        _295 = float2((_274 * _249.x) - (_265 * _249.y), (_259 * _249.y) - (_270 * _249.x)) / float2((_259 * _274) - (_265 * _270));
    }
    float _315;
    if ((_179 & 2u) != 0u)
    {
        _315 = 1.0;
    }
    else
    {
        _315 = (fast::clamp(length(_230) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectSamplingRadiusNearLimitRec, 0.0, 1.0) * 0.800000011920928955078125) + 0.20000000298023223876953125;
    }
    float _316 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectRadius * _315;
    float _318 = (0.85000002384185791015625 * _316) / length(float3(_295, _131) - _230);
    float _320 = (-1.0) / (_316 * _316);
    uint _326 = uint((_111.y * 2.0) + _111.x) % 5u;
    float2x2 _339 = float2x2(float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[gl_GlobalInvocationID.z][_326].x * _318, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[gl_GlobalInvocationID.z][_326].y * _318), float2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[gl_GlobalInvocationID.z][_326].z * _318, SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.PatternRotScaleMatrices[gl_GlobalInvocationID.z][_326].w * _318));
    float _342 = _131 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthPrecisionOffsetMod;
    float _343 = _342 * MacLauncherScene.mlJitterSign.z;
    float2 _349 = ((_157 * ((_343 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _343)) - MacLauncherScene.mlProjection[3].xy;
    float2 _395;
    if (_181)
    {
        _395 = _349 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _355 = _157.x;
        float _359 = MacLauncherScene.mlProjection[0].x - (_355 * MacLauncherScene.mlProjection[0].w);
        float _365 = MacLauncherScene.mlProjection[1].x - (_355 * MacLauncherScene.mlProjection[1].w);
        float _368 = _157.y;
        float _370 = MacLauncherScene.mlProjection[0].y - (_368 * MacLauncherScene.mlProjection[0].w);
        float _374 = MacLauncherScene.mlProjection[1].y - (_368 * MacLauncherScene.mlProjection[1].w);
        _395 = float2((_374 * _349.x) - (_365 * _349.y), (_359 * _349.y) - (_370 * _349.x)) / float2((_359 * _374) - (_365 * _370));
    }
    float3 _398 = float3(_395, _342);
    float _399 = log2(_318);
    float2 _401 = rint(float2(0.78488063812255859375, 0.566616714000701904296875) * _339);
    float _402 = _399 + (-4.426083087921142578125);
    float2 _404 = (_401 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _122;
    float3 _409 = float3(_404, _125);
    float4 _411 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _409.xy, uint(rint(_409.z)), level(_402));
    float _412 = _411.x;
    float2 _415 = ((_404 - _148) * _152) + _156;
    float _416 = _412 * MacLauncherScene.mlJitterSign.z;
    float2 _422 = ((_415 * ((_416 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _416)) - MacLauncherScene.mlProjection[3].xy;
    float2 _468;
    if (_181)
    {
        _468 = _422 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _428 = _415.x;
        float _432 = MacLauncherScene.mlProjection[0].x - (_428 * MacLauncherScene.mlProjection[0].w);
        float _438 = MacLauncherScene.mlProjection[1].x - (_428 * MacLauncherScene.mlProjection[1].w);
        float _441 = _415.y;
        float _443 = MacLauncherScene.mlProjection[0].y - (_441 * MacLauncherScene.mlProjection[0].w);
        float _447 = MacLauncherScene.mlProjection[1].y - (_441 * MacLauncherScene.mlProjection[1].w);
        float _448 = _422.x;
        float _450 = _422.y;
        _468 = float2((_447 * _448) - (_438 * _450), (_432 * _450) - (_443 * _448)) / float2((_432 * _447) - (_438 * _443));
    }
    float3 _472 = float3(_468, _412) - _398;
    float _473 = dot(_472, _472);
    float _495 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_472.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * 1.5;
    float2 _499 = ((-_401) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _122;
    float3 _504 = float3(_499, _125);
    float4 _506 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _504.xy, uint(rint(_504.z)), level(_402));
    float _507 = _506.x;
    float2 _510 = ((_499 - _148) * _152) + _156;
    float _511 = _507 * MacLauncherScene.mlJitterSign.z;
    float2 _517 = ((_510 * ((_511 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _511)) - MacLauncherScene.mlProjection[3].xy;
    float2 _563;
    if (_181)
    {
        _563 = _517 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _523 = _510.x;
        float _527 = MacLauncherScene.mlProjection[0].x - (_523 * MacLauncherScene.mlProjection[0].w);
        float _533 = MacLauncherScene.mlProjection[1].x - (_523 * MacLauncherScene.mlProjection[1].w);
        float _536 = _510.y;
        float _538 = MacLauncherScene.mlProjection[0].y - (_536 * MacLauncherScene.mlProjection[0].w);
        float _542 = MacLauncherScene.mlProjection[1].y - (_536 * MacLauncherScene.mlProjection[1].w);
        float _543 = _517.x;
        float _545 = _517.y;
        _563 = float2((_542 * _543) - (_533 * _545), (_527 * _545) - (_538 * _543)) / float2((_527 * _542) - (_533 * _538));
    }
    float3 _567 = float3(_563, _507) - _398;
    float _568 = dot(_567, _567);
    float _586 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_567.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * 1.5;
    float2 _591 = rint(float2(0.26022231578826904296875, -0.2957517206668853759765625) * _339);
    float _592 = _399 + (-5.364030361175537109375);
    float2 _594 = (_591 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _122;
    float3 _599 = float3(_594, _125);
    float4 _601 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _599.xy, uint(rint(_599.z)), level(_592));
    float _602 = _601.x;
    float2 _605 = ((_594 - _148) * _152) + _156;
    float _606 = _602 * MacLauncherScene.mlJitterSign.z;
    float2 _612 = ((_605 * ((_606 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _606)) - MacLauncherScene.mlProjection[3].xy;
    float2 _658;
    if (_181)
    {
        _658 = _612 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _618 = _605.x;
        float _622 = MacLauncherScene.mlProjection[0].x - (_618 * MacLauncherScene.mlProjection[0].w);
        float _628 = MacLauncherScene.mlProjection[1].x - (_618 * MacLauncherScene.mlProjection[1].w);
        float _631 = _605.y;
        float _633 = MacLauncherScene.mlProjection[0].y - (_631 * MacLauncherScene.mlProjection[0].w);
        float _637 = MacLauncherScene.mlProjection[1].y - (_631 * MacLauncherScene.mlProjection[1].w);
        float _638 = _612.x;
        float _640 = _612.y;
        _658 = float2((_637 * _638) - (_628 * _640), (_622 * _640) - (_633 * _638)) / float2((_622 * _637) - (_628 * _633));
    }
    float3 _662 = float3(_658, _602) - _398;
    float _663 = dot(_662, _662);
    float _681 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_662.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * 1.5;
    float2 _687 = ((-_591) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _122;
    float3 _692 = float3(_687, _125);
    float4 _694 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _692.xy, uint(rint(_692.z)), level(_592));
    float _695 = _694.x;
    float2 _698 = ((_687 - _148) * _152) + _156;
    float _699 = _695 * MacLauncherScene.mlJitterSign.z;
    float2 _705 = ((_698 * ((_699 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _699)) - MacLauncherScene.mlProjection[3].xy;
    float2 _751;
    if (_181)
    {
        _751 = _705 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _711 = _698.x;
        float _715 = MacLauncherScene.mlProjection[0].x - (_711 * MacLauncherScene.mlProjection[0].w);
        float _721 = MacLauncherScene.mlProjection[1].x - (_711 * MacLauncherScene.mlProjection[1].w);
        float _724 = _698.y;
        float _726 = MacLauncherScene.mlProjection[0].y - (_724 * MacLauncherScene.mlProjection[0].w);
        float _730 = MacLauncherScene.mlProjection[1].y - (_724 * MacLauncherScene.mlProjection[1].w);
        float _731 = _705.x;
        float _733 = _705.y;
        _751 = float2((_730 * _731) - (_721 * _733), (_715 * _733) - (_726 * _731)) / float2((_715 * _730) - (_721 * _726));
    }
    float3 _755 = float3(_751, _695) - _398;
    float _756 = dot(_755, _755);
    float _774 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_755.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * 1.5;
    float2 _779 = rint(float2(0.104593567550182342529296875, 0.083725273609161376953125) * _339);
    float _780 = _399 + (-7.0305633544921875);
    float2 _782 = (_779 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _122;
    float3 _787 = float3(_782, _125);
    float4 _789 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _787.xy, uint(rint(_787.z)), level(_780));
    float _790 = _789.x;
    float2 _793 = ((_782 - _148) * _152) + _156;
    float _794 = _790 * MacLauncherScene.mlJitterSign.z;
    float2 _800 = ((_793 * ((_794 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _794)) - MacLauncherScene.mlProjection[3].xy;
    float2 _846;
    if (_181)
    {
        _846 = _800 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _806 = _793.x;
        float _810 = MacLauncherScene.mlProjection[0].x - (_806 * MacLauncherScene.mlProjection[0].w);
        float _816 = MacLauncherScene.mlProjection[1].x - (_806 * MacLauncherScene.mlProjection[1].w);
        float _819 = _793.y;
        float _821 = MacLauncherScene.mlProjection[0].y - (_819 * MacLauncherScene.mlProjection[0].w);
        float _825 = MacLauncherScene.mlProjection[1].y - (_819 * MacLauncherScene.mlProjection[1].w);
        float _826 = _800.x;
        float _828 = _800.y;
        _846 = float2((_825 * _826) - (_816 * _828), (_810 * _828) - (_821 * _826)) / float2((_810 * _825) - (_816 * _821));
    }
    float3 _850 = float3(_846, _790) - _398;
    float _851 = dot(_850, _850);
    float _869 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_850.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * 1.11000001430511474609375;
    float2 _875 = ((-_779) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _122;
    float3 _880 = float3(_875, _125);
    float4 _882 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _880.xy, uint(rint(_880.z)), level(_780));
    float _883 = _882.x;
    float2 _886 = ((_875 - _148) * _152) + _156;
    float _887 = _883 * MacLauncherScene.mlJitterSign.z;
    float2 _893 = ((_886 * ((_887 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _887)) - MacLauncherScene.mlProjection[3].xy;
    float2 _939;
    if (_181)
    {
        _939 = _893 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _899 = _886.x;
        float _903 = MacLauncherScene.mlProjection[0].x - (_899 * MacLauncherScene.mlProjection[0].w);
        float _909 = MacLauncherScene.mlProjection[1].x - (_899 * MacLauncherScene.mlProjection[1].w);
        float _912 = _886.y;
        float _914 = MacLauncherScene.mlProjection[0].y - (_912 * MacLauncherScene.mlProjection[0].w);
        float _918 = MacLauncherScene.mlProjection[1].y - (_912 * MacLauncherScene.mlProjection[1].w);
        float _919 = _893.x;
        float _921 = _893.y;
        _939 = float2((_918 * _919) - (_909 * _921), (_903 * _921) - (_914 * _919)) / float2((_903 * _918) - (_909 * _914));
    }
    float3 _943 = float3(_939, _883) - _398;
    float _944 = dot(_943, _943);
    float _962 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_943.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * 1.11000001430511474609375;
    float _964 = ((((((precise::max(0.0, (dot(_240, _472) / sqrt(_473)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_473 * _320) + 1.0)) * _495) + ((precise::max(0.0, (dot(_240, _567) / sqrt(_568)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_568 * _320) + 1.0)) * _586)) + ((precise::max(0.0, (dot(_240, _662) / sqrt(_663)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_663 * _320) + 1.0)) * _681)) + ((precise::max(0.0, (dot(_240, _755) / sqrt(_756)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_756 * _320) + 1.0)) * _774)) + ((precise::max(0.0, (dot(_240, _850) / sqrt(_851)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_851 * _320) + 1.0)) * _869)) + ((precise::max(0.0, (dot(_240, _943) / sqrt(_944)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_944 * _320) + 1.0)) * _962);
    float2 _967 = rint(float2(-0.68286800384521484375, 0.04963044822216033935546875) * _339);
    float _968 = _399 + (-4.79882717132568359375);
    float2 _970 = (_967 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _122;
    float3 _975 = float3(_970, _125);
    float4 _977 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _975.xy, uint(rint(_975.z)), level(_968));
    float _978 = _977.x;
    float2 _981 = ((_970 - _148) * _152) + _156;
    float _982 = _978 * MacLauncherScene.mlJitterSign.z;
    float2 _988 = ((_981 * ((_982 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _982)) - MacLauncherScene.mlProjection[3].xy;
    float2 _1034;
    if (_181)
    {
        _1034 = _988 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _994 = _981.x;
        float _998 = MacLauncherScene.mlProjection[0].x - (_994 * MacLauncherScene.mlProjection[0].w);
        float _1004 = MacLauncherScene.mlProjection[1].x - (_994 * MacLauncherScene.mlProjection[1].w);
        float _1007 = _981.y;
        float _1009 = MacLauncherScene.mlProjection[0].y - (_1007 * MacLauncherScene.mlProjection[0].w);
        float _1013 = MacLauncherScene.mlProjection[1].y - (_1007 * MacLauncherScene.mlProjection[1].w);
        float _1014 = _988.x;
        float _1016 = _988.y;
        _1034 = float2((_1013 * _1014) - (_1004 * _1016), (_998 * _1016) - (_1009 * _1014)) / float2((_998 * _1013) - (_1004 * _1009));
    }
    float3 _1038 = float3(_1034, _978) - _398;
    float _1039 = dot(_1038, _1038);
    float _1057 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_1038.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * 1.09000003337860107421875;
    float2 _1063 = ((-_967) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _122;
    float3 _1068 = float3(_1063, _125);
    float4 _1070 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _1068.xy, uint(rint(_1068.z)), level(_968));
    float _1071 = _1070.x;
    float2 _1074 = ((_1063 - _148) * _152) + _156;
    float _1075 = _1071 * MacLauncherScene.mlJitterSign.z;
    float2 _1081 = ((_1074 * ((_1075 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _1075)) - MacLauncherScene.mlProjection[3].xy;
    float2 _1127;
    if (_181)
    {
        _1127 = _1081 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _1087 = _1074.x;
        float _1091 = MacLauncherScene.mlProjection[0].x - (_1087 * MacLauncherScene.mlProjection[0].w);
        float _1097 = MacLauncherScene.mlProjection[1].x - (_1087 * MacLauncherScene.mlProjection[1].w);
        float _1100 = _1074.y;
        float _1102 = MacLauncherScene.mlProjection[0].y - (_1100 * MacLauncherScene.mlProjection[0].w);
        float _1106 = MacLauncherScene.mlProjection[1].y - (_1100 * MacLauncherScene.mlProjection[1].w);
        float _1107 = _1081.x;
        float _1109 = _1081.y;
        _1127 = float2((_1106 * _1107) - (_1097 * _1109), (_1091 * _1109) - (_1102 * _1107)) / float2((_1091 * _1106) - (_1097 * _1102));
    }
    float3 _1131 = float3(_1127, _1071) - _398;
    float _1132 = dot(_1131, _1131);
    float _1150 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_1131.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * 1.09000003337860107421875;
    float2 _1155 = rint(float2(-0.13570161163806915283203125, -0.641901552677154541015625) * _339);
    float _1156 = _399 + (-4.832765102386474609375);
    float2 _1158 = (_1155 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _122;
    float3 _1163 = float3(_1158, _125);
    float4 _1165 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _1163.xy, uint(rint(_1163.z)), level(_1156));
    float _1166 = _1165.x;
    float2 _1169 = ((_1158 - _148) * _152) + _156;
    float _1170 = _1166 * MacLauncherScene.mlJitterSign.z;
    float2 _1176 = ((_1169 * ((_1170 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _1170)) - MacLauncherScene.mlProjection[3].xy;
    float2 _1222;
    if (_181)
    {
        _1222 = _1176 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _1182 = _1169.x;
        float _1186 = MacLauncherScene.mlProjection[0].x - (_1182 * MacLauncherScene.mlProjection[0].w);
        float _1192 = MacLauncherScene.mlProjection[1].x - (_1182 * MacLauncherScene.mlProjection[1].w);
        float _1195 = _1169.y;
        float _1197 = MacLauncherScene.mlProjection[0].y - (_1195 * MacLauncherScene.mlProjection[0].w);
        float _1201 = MacLauncherScene.mlProjection[1].y - (_1195 * MacLauncherScene.mlProjection[1].w);
        float _1202 = _1176.x;
        float _1204 = _1176.y;
        _1222 = float2((_1201 * _1202) - (_1192 * _1204), (_1186 * _1204) - (_1197 * _1202)) / float2((_1186 * _1201) - (_1192 * _1197));
    }
    float3 _1226 = float3(_1222, _1166) - _398;
    float _1227 = dot(_1226, _1226);
    float _1245 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_1226.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * 1.25;
    float2 _1251 = ((-_1155) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferInverseDimensions) + _122;
    float3 _1256 = float3(_1251, _125);
    float4 _1258 = g_DeinterleavedDepth.sample(g_ViewspaceDepthTapSampler, _1256.xy, uint(rint(_1256.z)), level(_1156));
    float _1259 = _1258.x;
    float2 _1262 = ((_1251 - _148) * _152) + _156;
    float _1263 = _1259 * MacLauncherScene.mlJitterSign.z;
    float2 _1269 = ((_1262 * ((_1263 * MacLauncherScene.mlProjection[2].w) + MacLauncherScene.mlProjection[3].w)) - (MacLauncherScene.mlProjection[2].xy * _1263)) - MacLauncherScene.mlProjection[3].xy;
    float2 _1315;
    if (_181)
    {
        _1315 = _1269 / float2(MacLauncherScene.mlProjection[0].x, MacLauncherScene.mlProjection[1].y);
    }
    else
    {
        float _1275 = _1262.x;
        float _1279 = MacLauncherScene.mlProjection[0].x - (_1275 * MacLauncherScene.mlProjection[0].w);
        float _1285 = MacLauncherScene.mlProjection[1].x - (_1275 * MacLauncherScene.mlProjection[1].w);
        float _1288 = _1262.y;
        float _1290 = MacLauncherScene.mlProjection[0].y - (_1288 * MacLauncherScene.mlProjection[0].w);
        float _1294 = MacLauncherScene.mlProjection[1].y - (_1288 * MacLauncherScene.mlProjection[1].w);
        float _1295 = _1269.x;
        float _1297 = _1269.y;
        _1315 = float2((_1294 * _1295) - (_1285 * _1297), (_1279 * _1297) - (_1290 * _1295)) / float2((_1279 * _1294) - (_1285 * _1290));
    }
    float3 _1319 = float3(_1315, _1259) - _398;
    float _1320 = dot(_1319, _1319);
    float _1338 = ((0.60000002384185791015625 * fast::clamp((precise::max(0.0, -_1319.z) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.NegRecEffectRadius) + 2.0, 0.0, 1.0)) + 0.4000000059604644775390625) * 1.25;
    float _1341 = ((((((((_495 + _586) + _681) + _774) + _869) + _962) + _1057) + _1150) + _1245) + _1338;
    uint3 _1350 = uint3(int3(int(gl_GlobalInvocationID.x), int(gl_GlobalInvocationID.y), _231));
    g_RwSsaoBufferPing.write(float2(((((_964 + ((precise::max(0.0, (dot(_240, _1038) / sqrt(_1039)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_1039 * _320) + 1.0)) * _1057)) + ((precise::max(0.0, (dot(_240, _1131) / sqrt(_1132)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_1132 * _320) + 1.0)) * _1150)) + ((precise::max(0.0, (dot(_240, _1226) / sqrt(_1227)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_1227 * _320) + 1.0)) * _1245)) + ((precise::max(0.0, (dot(_240, _1319) / sqrt(_1320)) - SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectHorizonAngleThreshold) * precise::max(0.0, (_1320 * _320) + 1.0)) * _1338)) / _1341, _1341 * 0.0500000007450580596923828125).xyyy, uint2(_1350.xy), uint(_1350.z));
}

)CACAO_GPU";
inline constexpr Binding bindings13[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_SsaoBufferPong","texture",0},{"g_RwImportanceMap","texture",1},{"g_PointClampSampler","sampler",0}};
inline constexpr const char*source13=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d_array<float> g_SsaoBufferPong [[texture(0)]], texture2d<float, access::write> g_RwImportanceMap [[texture(1)]], sampler g_PointClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    float2 _60 = (float2(gl_GlobalInvocationID.xy * uint2(2u)) + float2(1.0)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions;
    float _63 = _60.x;
    float3 _65 = float3(_63, _60.y, 0.0);
    float4 _75 = float4(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowPow);
    float4 _76 = powr(fast::clamp(float4(1.0) - (g_SsaoBufferPong.gather(g_PointClampSampler, _65.xy, uint(rint(_65.z)), int2(0), component::x) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowStrength), float4(0.0), float4(1.0)), _75);
    float _77 = _76.x;
    float _78 = _76.y;
    float _80 = _76.z;
    float _81 = _76.w;
    float3 _91 = float3(_63, _60.y, 1.0);
    float4 _97 = powr(fast::clamp(float4(1.0) - (g_SsaoBufferPong.gather(g_PointClampSampler, _91.xy, uint(rint(_91.z)), int2(0), component::x) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowStrength), float4(0.0), float4(1.0)), _75);
    float _98 = _97.x;
    float _99 = _97.y;
    float _101 = _97.z;
    float _102 = _97.w;
    float3 _112 = float3(_63, _60.y, 2.0);
    float4 _118 = powr(fast::clamp(float4(1.0) - (g_SsaoBufferPong.gather(g_PointClampSampler, _112.xy, uint(rint(_112.z)), int2(0), component::x) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowStrength), float4(0.0), float4(1.0)), _75);
    float _119 = _118.x;
    float _120 = _118.y;
    float _122 = _118.z;
    float _123 = _118.w;
    float3 _133 = float3(_63, _60.y, 3.0);
    float4 _139 = powr(fast::clamp(float4(1.0) - (g_SsaoBufferPong.gather(g_PointClampSampler, _133.xy, uint(rint(_133.z)), int2(0), component::x) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.EffectShadowStrength), float4(0.0), float4(1.0)), _75);
    float _140 = _139.x;
    float _141 = _139.y;
    float _143 = _139.z;
    float _144 = _139.w;
    g_RwImportanceMap.write(float4(powr(fast::clamp((precise::max(precise::max(precise::max(precise::max(0.0, precise::max(precise::max(_77, _78), precise::max(_80, _81))), precise::max(precise::max(_98, _99), precise::max(_101, _102))), precise::max(precise::max(_119, _120), precise::max(_122, _123))), precise::max(precise::max(_140, _141), precise::max(_143, _144))) - precise::min(precise::min(precise::min(precise::min(1.0, precise::min(precise::min(_77, _78), precise::min(_80, _81))), precise::min(precise::min(_98, _99), precise::min(_101, _102))), precise::min(precise::min(_119, _120), precise::min(_122, _123))), precise::min(precise::min(_140, _141), precise::min(_143, _144)))) * 2.0, 0.0, 1.0), 0.800000011920928955078125)), uint2(gl_GlobalInvocationID.xy));
}

)CACAO_GPU";
inline constexpr Binding bindings14[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_ImportanceMap","texture",0},{"g_RwImportanceMapPong","texture",1},{"g_LinearClampSampler","sampler",0}};
inline constexpr const char*source14=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d<float> g_ImportanceMap [[texture(0)]], texture2d<float, access::write> g_RwImportanceMapPong [[texture(1)]], sampler g_LinearClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    float2 _52 = (float2(gl_GlobalInvocationID.xy) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.ImportanceMapInverseDimensions;
    float2 _53 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.ImportanceMapInverseDimensions * 0.5;
    float _54 = _53.x;
    float _57 = _53.y;
    g_RwImportanceMapPong.write(float4(dot(float4(g_ImportanceMap.sample(g_LinearClampSampler, (_52 + float2(_54 * (-3.0), -_57)), level(0.0)).x, g_ImportanceMap.sample(g_LinearClampSampler, (_52 + float2(_54, _57 * (-3.0))), level(0.0)).x, g_ImportanceMap.sample(g_LinearClampSampler, (_52 + float2(_54 * 3.0, _57)), level(0.0)).x, g_ImportanceMap.sample(g_LinearClampSampler, (_52 + float2(-_54, _57 * 3.0)), level(0.0)).x), float4(0.25))), uint2(gl_GlobalInvocationID.xy));
}

)CACAO_GPU";
inline constexpr Binding bindings15[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_RwLoadCounter","buffer",1},{"g_ImportanceMapPong","texture",0},{"g_RwImportanceMap","texture",1},{"g_LinearClampSampler","sampler",0}};
inline constexpr const char*source15=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wunused-variable"

#include <metal_stdlib>
#include <simd/simd.h>
#include <metal_atomic>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

struct type_RWStructuredBuffer_uint
{
    uint _m0[1];
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], device type_RWStructuredBuffer_uint& g_RwLoadCounter [[buffer(1)]], texture2d<float> g_ImportanceMapPong [[texture(0)]], texture2d<float, access::write> g_RwImportanceMap [[texture(1)]], sampler g_LinearClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    float2 _63 = (float2(gl_GlobalInvocationID.xy) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.ImportanceMapInverseDimensions;
    float2 _64 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.ImportanceMapInverseDimensions * 0.5;
    float _65 = _64.x;
    float _67 = _64.y;
    float _102 = dot(float4(g_ImportanceMapPong.sample(g_LinearClampSampler, (_63 + float2(-_65, _67 * (-3.0))), level(0.0)).x, g_ImportanceMapPong.sample(g_LinearClampSampler, (_63 + float2(_65 * 3.0, -_67)), level(0.0)).x, g_ImportanceMapPong.sample(g_LinearClampSampler, (_63 + float2(_65, _67 * 3.0)), level(0.0)).x, g_ImportanceMapPong.sample(g_LinearClampSampler, (_63 + float2(_65 * (-3.0), _67)), level(0.0)).x), float4(0.25));
    g_RwImportanceMap.write(float4(_102), uint2(gl_GlobalInvocationID.xy));
    if (((gl_GlobalInvocationID.x % 3u) + (gl_GlobalInvocationID.y % 3u)) == 0u)
    {
        uint _117 = atomic_fetch_add_explicit((device atomic_uint*)&g_RwLoadCounter._m0[0u], uint((fast::clamp(_102, 0.0, 1.0) * 255.0) + 0.5), memory_order_relaxed);
    }
}

)CACAO_GPU";
inline constexpr Binding bindings16[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_SsaoBufferPing","texture",0},{"g_RwSsaoBufferPong","texture",1},{"g_PointMirrorSampler","sampler",0}};
inline constexpr const char*source16=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d_array<float> g_SsaoBufferPing [[texture(0)]], texture2d_array<float, access::write> g_RwSsaoBufferPong [[texture(1)]], sampler g_PointMirrorSampler [[sampler(0)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Front_4;
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Back_4;
    bool _118;
    if (gl_WorkGroupID.z == 1u)
    {
        _118 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BlurNumPasses == 2;
    }
    else
    {
        _118 = false;
    }
    uint _119 = _118 ? 3u : gl_WorkGroupID.z;
    int2 _123 = int2(gl_LocalInvocationID.xy);
    int2 _125 = (int2(gl_WorkGroupID.xy) * int2(62, 46)) + (int2(4, 3) * _123);
    int2 _126 = _125 - int2(1);
    int2 _127 = int2(2, 3) * _123;
    int2 _128 = _127 + int2(1);
    float _136 = float(_119);
    float3 _139 = float3((float2(_126) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _136);
    float4 _141 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _139.xy, uint(rint(_139.z)), level(0.0));
    float3 _150 = float3((float2(_125 + int2(0, -1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _136);
    float4 _152 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _150.xy, uint(rint(_150.z)), level(0.0));
    float3 _161 = float3((float2(_125 + int2(1, -1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _136);
    float4 _163 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _161.xy, uint(rint(_161.z)), level(0.0));
    float3 _172 = float3((float2(_125 + int2(2, -1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _136);
    float4 _174 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _172.xy, uint(rint(_172.z)), level(0.0));
    float3 _183 = float3((float2(_125 + int2(-1, 0)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _136);
    float4 _185 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _183.xy, uint(rint(_183.z)), level(0.0));
    float3 _193 = float3((float2(_125) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _136);
    float4 _195 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _193.xy, uint(rint(_193.z)), level(0.0));
    float3 _204 = float3((float2(_125 + int2(1, 0)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _136);
    float4 _206 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _204.xy, uint(rint(_204.z)), level(0.0));
    float3 _215 = float3((float2(_125 + int2(2, 0)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _136);
    float4 _217 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _215.xy, uint(rint(_215.z)), level(0.0));
    float3 _226 = float3((float2(_125 + int2(-1, 1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _136);
    float4 _228 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _226.xy, uint(rint(_226.z)), level(0.0));
    float3 _237 = float3((float2(_125 + int2(0, 1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _136);
    float4 _239 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _237.xy, uint(rint(_237.z)), level(0.0));
    float3 _248 = float3((float2(_125 + int2(1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _136);
    float4 _250 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _248.xy, uint(rint(_248.z)), level(0.0));
    float3 _259 = float3((float2(_125 + int2(2, 1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _136);
    float4 _261 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _259.xy, uint(rint(_259.z)), level(0.0));
    int _270 = _128.x;
    int _271 = _128.y;
    s_FFX_CACAO_BlurF16Front_4[_270][_271] = as_type<uint>(half2(float2(_141.x, 0.0))) | (as_type<uint>(half2(float2(_152.x, 0.0))) << 16u);
    int _281 = _270 + 1;
    s_FFX_CACAO_BlurF16Front_4[_281][_271] = as_type<uint>(half2(float2(_163.x, 0.0))) | (as_type<uint>(half2(float2(_174.x, 0.0))) << 16u);
    spvUnsafeArray<float4, 3> _107;
    _107[0] = float4(_141.y, _152.y, _163.y, _174.y);
    int _297 = _271 + 1;
    s_FFX_CACAO_BlurF16Front_4[_270][_297] = as_type<uint>(half2(float2(_185.x, 0.0))) | (as_type<uint>(half2(float2(_195.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_281][_297] = as_type<uint>(half2(float2(_206.x, 0.0))) | (as_type<uint>(half2(float2(_217.x, 0.0))) << 16u);
    _107[1] = float4(_185.y, _195.y, _206.y, _217.y);
    int _322 = _271 + 2;
    s_FFX_CACAO_BlurF16Front_4[_270][_322] = as_type<uint>(half2(float2(_228.x, 0.0))) | (as_type<uint>(half2(float2(_239.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_281][_322] = as_type<uint>(half2(float2(_250.x, 0.0))) | (as_type<uint>(half2(float2(_261.x, 0.0))) << 16u);
    _107[2] = float4(_228.y, _239.y, _250.y, _261.y);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint _340 = 0u; _340 < 1u; _340++)
    {
        float2 _349 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_270][_271] & 65535u));
        float _350 = _349.x;
        float2 _351 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_270][_271] >> 16u));
        float _352 = _351.x;
        float2 _356 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_281][_271] & 65535u));
        float _357 = _356.x;
        float2 _358 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_281][_271] >> 16u));
        float _359 = _358.x;
        int _361 = _271 - 1;
        int _394 = _270 - 1;
        int _401 = _270 + 2;
        uint4 _411 = uint4(_107[0] * 255.5);
        float4 _418 = float4(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.InvSharpness);
        float4 _420 = fast::clamp((float4((_411 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
        float4 _426 = fast::clamp((float4((_411 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
        float4 _432 = fast::clamp((float4((_411 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
        float4 _437 = fast::clamp((float4(_411 & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
        float4 _450 = (((((float4(_350, _352, _357, _359) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_394][_271] >> 16u)).x, _350, _352, _357) * _420)) + (float4(_352, _357, _359, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_401][_271] & 65535u)).x) * _426)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_270][_361] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_270][_361] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_281][_361] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_281][_361] >> 16u)).x) * _432)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_270][_297] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_270][_297] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_281][_297] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_281][_297] >> 16u)).x) * _437)) / ((((float4(0.5) + _420) + _426) + _432) + _437);
        s_FFX_CACAO_BlurF16Back_4[_270][_271] = as_type<uint>(half2(float2(_450.x, 0.0))) | (as_type<uint>(half2(float2(_450.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_281][_271] = as_type<uint>(half2(float2(_450.z, 0.0))) | (as_type<uint>(half2(float2(_450.w, 0.0))) << 16u);
        int2 _469 = _127 + int2(1, 2);
        int _470 = _469.x;
        int _471 = _469.y;
        float2 _476 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_470][_471] & 65535u));
        float _477 = _476.x;
        float2 _478 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_470][_471] >> 16u));
        float _479 = _478.x;
        int _480 = _470 + 1;
        float2 _485 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_480][_471] & 65535u));
        float _486 = _485.x;
        float2 _487 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_480][_471] >> 16u));
        float _488 = _487.x;
        int _490 = _471 - 1;
        int _508 = _471 + 1;
        int _526 = _470 - 1;
        int _533 = _470 + 2;
        uint4 _543 = uint4(_107[1] * 255.5);
        float4 _549 = fast::clamp((float4((_543 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
        float4 _555 = fast::clamp((float4((_543 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
        float4 _561 = fast::clamp((float4((_543 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
        float4 _566 = fast::clamp((float4(_543 & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
        float4 _579 = (((((float4(_477, _479, _486, _488) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_526][_471] >> 16u)).x, _477, _479, _486) * _549)) + (float4(_479, _486, _488, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_533][_471] & 65535u)).x) * _555)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_470][_490] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_470][_490] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_480][_490] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_480][_490] >> 16u)).x) * _561)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_470][_508] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_470][_508] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_480][_508] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_480][_508] >> 16u)).x) * _566)) / ((((float4(0.5) + _549) + _555) + _561) + _566);
        s_FFX_CACAO_BlurF16Back_4[_470][_471] = as_type<uint>(half2(float2(_579.x, 0.0))) | (as_type<uint>(half2(float2(_579.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_480][_471] = as_type<uint>(half2(float2(_579.z, 0.0))) | (as_type<uint>(half2(float2(_579.w, 0.0))) << 16u);
        int2 _598 = _127 + int2(1, 3);
        int _599 = _598.x;
        int _600 = _598.y;
        float2 _605 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_599][_600] & 65535u));
        float _606 = _605.x;
        float2 _607 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_599][_600] >> 16u));
        float _608 = _607.x;
        int _609 = _599 + 1;
        float2 _614 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_609][_600] & 65535u));
        float _615 = _614.x;
        float2 _616 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_609][_600] >> 16u));
        float _617 = _616.x;
        int _619 = _600 - 1;
        int _637 = _600 + 1;
        int _655 = _599 - 1;
        int _662 = _599 + 2;
        uint4 _672 = uint4(_107[2] * 255.5);
        float4 _678 = fast::clamp((float4((_672 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
        float4 _684 = fast::clamp((float4((_672 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
        float4 _690 = fast::clamp((float4((_672 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
        float4 _695 = fast::clamp((float4(_672 & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
        float4 _708 = (((((float4(_606, _608, _615, _617) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_655][_600] >> 16u)).x, _606, _608, _615) * _678)) + (float4(_608, _615, _617, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_662][_600] & 65535u)).x) * _684)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_599][_619] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_599][_619] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_609][_619] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_609][_619] >> 16u)).x) * _690)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_599][_637] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_599][_637] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_609][_637] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_609][_637] >> 16u)).x) * _695)) / ((((float4(0.5) + _678) + _684) + _690) + _695);
        s_FFX_CACAO_BlurF16Back_4[_599][_600] = as_type<uint>(half2(float2(_708.x, 0.0))) | (as_type<uint>(half2(float2(_708.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_609][_600] = as_type<uint>(half2(float2(_708.z, 0.0))) | (as_type<uint>(half2(float2(_708.w, 0.0))) << 16u);
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (((2u * _340) + 1u) < 1u)
        {
            float2 _735 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_270][_271] & 65535u));
            float _736 = _735.x;
            float2 _737 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_270][_271] >> 16u));
            float _738 = _737.x;
            float2 _742 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_281][_271] & 65535u));
            float _743 = _742.x;
            float2 _744 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_281][_271] >> 16u));
            float _745 = _744.x;
            uint4 _796 = uint4(_107[0] * 255.5);
            float4 _802 = fast::clamp((float4((_796 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
            float4 _808 = fast::clamp((float4((_796 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
            float4 _814 = fast::clamp((float4((_796 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
            float4 _819 = fast::clamp((float4(_796 & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
            float4 _832 = (((((float4(_736, _738, _743, _745) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_394][_271] >> 16u)).x, _736, _738, _743) * _802)) + (float4(_738, _743, _745, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_401][_271] & 65535u)).x) * _808)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_270][_361] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_270][_361] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_281][_361] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_281][_361] >> 16u)).x) * _814)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_270][_297] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_270][_297] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_281][_297] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_281][_297] >> 16u)).x) * _819)) / ((((float4(0.5) + _802) + _808) + _814) + _819);
            s_FFX_CACAO_BlurF16Front_4[_270][_271] = as_type<uint>(half2(float2(_832.x, 0.0))) | (as_type<uint>(half2(float2(_832.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_281][_271] = as_type<uint>(half2(float2(_832.z, 0.0))) | (as_type<uint>(half2(float2(_832.w, 0.0))) << 16u);
            float2 _852 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_470][_471] & 65535u));
            float _853 = _852.x;
            float2 _854 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_470][_471] >> 16u));
            float _855 = _854.x;
            float2 _859 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_480][_471] & 65535u));
            float _860 = _859.x;
            float2 _861 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_480][_471] >> 16u));
            float _862 = _861.x;
            uint4 _913 = uint4(_107[1] * 255.5);
            float4 _919 = fast::clamp((float4((_913 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
            float4 _925 = fast::clamp((float4((_913 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
            float4 _931 = fast::clamp((float4((_913 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
            float4 _936 = fast::clamp((float4(_913 & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
            float4 _949 = (((((float4(_853, _855, _860, _862) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_526][_471] >> 16u)).x, _853, _855, _860) * _919)) + (float4(_855, _860, _862, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_533][_471] & 65535u)).x) * _925)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_470][_490] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_470][_490] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_480][_490] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_480][_490] >> 16u)).x) * _931)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_470][_508] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_470][_508] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_480][_508] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_480][_508] >> 16u)).x) * _936)) / ((((float4(0.5) + _919) + _925) + _931) + _936);
            s_FFX_CACAO_BlurF16Front_4[_470][_471] = as_type<uint>(half2(float2(_949.x, 0.0))) | (as_type<uint>(half2(float2(_949.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_480][_471] = as_type<uint>(half2(float2(_949.z, 0.0))) | (as_type<uint>(half2(float2(_949.w, 0.0))) << 16u);
            float2 _969 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_599][_600] & 65535u));
            float _970 = _969.x;
            float2 _971 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_599][_600] >> 16u));
            float _972 = _971.x;
            float2 _976 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_609][_600] & 65535u));
            float _977 = _976.x;
            float2 _978 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_609][_600] >> 16u));
            float _979 = _978.x;
            uint4 _1030 = uint4(_107[2] * 255.5);
            float4 _1036 = fast::clamp((float4((_1030 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
            float4 _1042 = fast::clamp((float4((_1030 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
            float4 _1048 = fast::clamp((float4((_1030 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
            float4 _1053 = fast::clamp((float4(_1030 & uint4(3u)) * float4(0.3333333432674407958984375)) + _418, float4(0.0), float4(1.0));
            float4 _1066 = (((((float4(_970, _972, _977, _979) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_655][_600] >> 16u)).x, _970, _972, _977) * _1036)) + (float4(_972, _977, _979, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_662][_600] & 65535u)).x) * _1042)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_599][_619] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_599][_619] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_609][_619] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_609][_619] >> 16u)).x) * _1048)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_599][_637] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_599][_637] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_609][_637] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_609][_637] >> 16u)).x) * _1053)) / ((((float4(0.5) + _1036) + _1042) + _1048) + _1053);
            s_FFX_CACAO_BlurF16Front_4[_599][_600] = as_type<uint>(half2(float2(_1066.x, 0.0))) | (as_type<uint>(half2(float2(_1066.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_609][_600] = as_type<uint>(half2(float2(_1066.z, 0.0))) | (as_type<uint>(half2(float2(_1066.w, 0.0))) << 16u);
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
    }
    for (uint _1084 = 0u; _1084 < 3u; _1084++)
    {
        uint _1092 = (3u * gl_LocalInvocationID.y) + _1084;
        bool _1097;
        if (1u <= _1092)
        {
            _1097 = _1092 < 47u;
        }
        else
        {
            _1097 = false;
        }
        if (_1097)
        {
            uint _1101 = 4u * gl_LocalInvocationID.x;
            uint _1103 = uint(_271) + _1084;
            bool _1124;
            if (1u <= _1101)
            {
                _1124 = _1101 < 63u;
            }
            else
            {
                _1124 = false;
            }
            if (_1124)
            {
                uint2 _1130 = uint2(_126 + int2(0, int(_1084)));
                uint3 _1140 = uint3(int3(int(_1130.x), int(_1130.y), int(_119)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_270][_1103] & 65535u)).x, _107[_1084].x).xyyy, uint2(_1140.xy), uint(_1140.z));
            }
            uint _1142 = _1101 + 1u;
            bool _1147;
            if (1u <= _1142)
            {
                _1147 = _1142 < 63u;
            }
            else
            {
                _1147 = false;
            }
            if (_1147)
            {
                uint2 _1153 = uint2(_126 + int2(1, int(_1084)));
                uint3 _1163 = uint3(int3(int(_1153.x), int(_1153.y), int(_119)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_270][_1103] >> 16u)).x, _107[_1084].y).xyyy, uint2(_1163.xy), uint(_1163.z));
            }
            uint _1165 = _1101 + 2u;
            bool _1170;
            if (1u <= _1165)
            {
                _1170 = _1165 < 63u;
            }
            else
            {
                _1170 = false;
            }
            if (_1170)
            {
                uint2 _1176 = uint2(_126 + int2(2, int(_1084)));
                uint3 _1186 = uint3(int3(int(_1176.x), int(_1176.y), int(_119)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_281][_1103] & 65535u)).x, _107[_1084].z).xyyy, uint2(_1186.xy), uint(_1186.z));
            }
            uint _1188 = _1101 + 3u;
            bool _1193;
            if (1u <= _1188)
            {
                _1193 = _1188 < 63u;
            }
            else
            {
                _1193 = false;
            }
            if (_1193)
            {
                uint2 _1199 = uint2(_126 + int2(3, int(_1084)));
                uint3 _1209 = uint3(int3(int(_1199.x), int(_1199.y), int(_119)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_281][_1103] >> 16u)).x, _107[_1084].w).xyyy, uint2(_1209.xy), uint(_1209.z));
            }
        }
    }
}

)CACAO_GPU";
inline constexpr Binding bindings17[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_SsaoBufferPing","texture",0},{"g_RwSsaoBufferPong","texture",1},{"g_PointMirrorSampler","sampler",0}};
inline constexpr const char*source17=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d_array<float> g_SsaoBufferPing [[texture(0)]], texture2d_array<float, access::write> g_RwSsaoBufferPong [[texture(1)]], sampler g_PointMirrorSampler [[sampler(0)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Front_4;
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Back_4;
    bool _121;
    if (gl_WorkGroupID.z == 1u)
    {
        _121 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BlurNumPasses == 2;
    }
    else
    {
        _121 = false;
    }
    uint _122 = _121 ? 3u : gl_WorkGroupID.z;
    int2 _126 = int2(gl_LocalInvocationID.xy);
    int2 _128 = (int2(gl_WorkGroupID.xy) * int2(60, 44)) + (int2(4, 3) * _126);
    int2 _129 = _128 - int2(2);
    int2 _130 = int2(2, 3) * _126;
    int2 _131 = _130 + int2(1);
    float _139 = float(_122);
    float3 _142 = float3((float2(_129) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _139);
    float4 _144 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _142.xy, uint(rint(_142.z)), level(0.0));
    float3 _153 = float3((float2(_128 + int2(-1, -2)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _139);
    float4 _155 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _153.xy, uint(rint(_153.z)), level(0.0));
    float3 _164 = float3((float2(_128 + int2(0, -2)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _139);
    float4 _166 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _164.xy, uint(rint(_164.z)), level(0.0));
    float3 _175 = float3((float2(_128 + int2(1, -2)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _139);
    float4 _177 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _175.xy, uint(rint(_175.z)), level(0.0));
    float3 _186 = float3((float2(_128 + int2(-2, -1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _139);
    float4 _188 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _186.xy, uint(rint(_186.z)), level(0.0));
    float3 _197 = float3((float2(_128 + int2(-1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _139);
    float4 _199 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _197.xy, uint(rint(_197.z)), level(0.0));
    float3 _208 = float3((float2(_128 + int2(0, -1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _139);
    float4 _210 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _208.xy, uint(rint(_208.z)), level(0.0));
    float3 _219 = float3((float2(_128 + int2(1, -1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _139);
    float4 _221 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _219.xy, uint(rint(_219.z)), level(0.0));
    float3 _230 = float3((float2(_128 + int2(-2, 0)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _139);
    float4 _232 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _230.xy, uint(rint(_230.z)), level(0.0));
    float3 _241 = float3((float2(_128 + int2(-1, 0)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _139);
    float4 _243 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _241.xy, uint(rint(_241.z)), level(0.0));
    float3 _251 = float3((float2(_128) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _139);
    float4 _253 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _251.xy, uint(rint(_251.z)), level(0.0));
    float3 _262 = float3((float2(_128 + int2(1, 0)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _139);
    float4 _264 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _262.xy, uint(rint(_262.z)), level(0.0));
    int _273 = _131.x;
    int _274 = _131.y;
    s_FFX_CACAO_BlurF16Front_4[_273][_274] = as_type<uint>(half2(float2(_144.x, 0.0))) | (as_type<uint>(half2(float2(_155.x, 0.0))) << 16u);
    int _284 = _273 + 1;
    s_FFX_CACAO_BlurF16Front_4[_284][_274] = as_type<uint>(half2(float2(_166.x, 0.0))) | (as_type<uint>(half2(float2(_177.x, 0.0))) << 16u);
    spvUnsafeArray<float4, 3> _110;
    _110[0] = float4(_144.y, _155.y, _166.y, _177.y);
    int _300 = _274 + 1;
    s_FFX_CACAO_BlurF16Front_4[_273][_300] = as_type<uint>(half2(float2(_188.x, 0.0))) | (as_type<uint>(half2(float2(_199.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_284][_300] = as_type<uint>(half2(float2(_210.x, 0.0))) | (as_type<uint>(half2(float2(_221.x, 0.0))) << 16u);
    _110[1] = float4(_188.y, _199.y, _210.y, _221.y);
    int _325 = _274 + 2;
    s_FFX_CACAO_BlurF16Front_4[_273][_325] = as_type<uint>(half2(float2(_232.x, 0.0))) | (as_type<uint>(half2(float2(_243.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_284][_325] = as_type<uint>(half2(float2(_253.x, 0.0))) | (as_type<uint>(half2(float2(_264.x, 0.0))) << 16u);
    _110[2] = float4(_232.y, _243.y, _253.y, _264.y);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint _343 = 0u; _343 < 1u; _343++)
    {
        float2 _352 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_273][_274] & 65535u));
        float _353 = _352.x;
        float2 _354 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_273][_274] >> 16u));
        float _355 = _354.x;
        float2 _359 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_284][_274] & 65535u));
        float _360 = _359.x;
        float2 _361 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_284][_274] >> 16u));
        float _362 = _361.x;
        int _364 = _274 - 1;
        int _397 = _273 - 1;
        int _404 = _273 + 2;
        uint4 _414 = uint4(_110[0] * 255.5);
        float4 _421 = float4(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.InvSharpness);
        float4 _423 = fast::clamp((float4((_414 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
        float4 _429 = fast::clamp((float4((_414 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
        float4 _435 = fast::clamp((float4((_414 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
        float4 _440 = fast::clamp((float4(_414 & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
        float4 _453 = (((((float4(_353, _355, _360, _362) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_397][_274] >> 16u)).x, _353, _355, _360) * _423)) + (float4(_355, _360, _362, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_404][_274] & 65535u)).x) * _429)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_273][_364] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_273][_364] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_284][_364] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_284][_364] >> 16u)).x) * _435)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_273][_300] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_273][_300] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_284][_300] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_284][_300] >> 16u)).x) * _440)) / ((((float4(0.5) + _423) + _429) + _435) + _440);
        s_FFX_CACAO_BlurF16Back_4[_273][_274] = as_type<uint>(half2(float2(_453.x, 0.0))) | (as_type<uint>(half2(float2(_453.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_284][_274] = as_type<uint>(half2(float2(_453.z, 0.0))) | (as_type<uint>(half2(float2(_453.w, 0.0))) << 16u);
        int2 _472 = _130 + int2(1, 2);
        int _473 = _472.x;
        int _474 = _472.y;
        float2 _479 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_473][_474] & 65535u));
        float _480 = _479.x;
        float2 _481 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_473][_474] >> 16u));
        float _482 = _481.x;
        int _483 = _473 + 1;
        float2 _488 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_483][_474] & 65535u));
        float _489 = _488.x;
        float2 _490 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_483][_474] >> 16u));
        float _491 = _490.x;
        int _493 = _474 - 1;
        int _511 = _474 + 1;
        int _529 = _473 - 1;
        int _536 = _473 + 2;
        uint4 _546 = uint4(_110[1] * 255.5);
        float4 _552 = fast::clamp((float4((_546 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
        float4 _558 = fast::clamp((float4((_546 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
        float4 _564 = fast::clamp((float4((_546 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
        float4 _569 = fast::clamp((float4(_546 & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
        float4 _582 = (((((float4(_480, _482, _489, _491) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_529][_474] >> 16u)).x, _480, _482, _489) * _552)) + (float4(_482, _489, _491, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_536][_474] & 65535u)).x) * _558)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_473][_493] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_473][_493] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_483][_493] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_483][_493] >> 16u)).x) * _564)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_473][_511] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_473][_511] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_483][_511] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_483][_511] >> 16u)).x) * _569)) / ((((float4(0.5) + _552) + _558) + _564) + _569);
        s_FFX_CACAO_BlurF16Back_4[_473][_474] = as_type<uint>(half2(float2(_582.x, 0.0))) | (as_type<uint>(half2(float2(_582.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_483][_474] = as_type<uint>(half2(float2(_582.z, 0.0))) | (as_type<uint>(half2(float2(_582.w, 0.0))) << 16u);
        int2 _601 = _130 + int2(1, 3);
        int _602 = _601.x;
        int _603 = _601.y;
        float2 _608 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_602][_603] & 65535u));
        float _609 = _608.x;
        float2 _610 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_602][_603] >> 16u));
        float _611 = _610.x;
        int _612 = _602 + 1;
        float2 _617 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_612][_603] & 65535u));
        float _618 = _617.x;
        float2 _619 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_612][_603] >> 16u));
        float _620 = _619.x;
        int _622 = _603 - 1;
        int _640 = _603 + 1;
        int _658 = _602 - 1;
        int _665 = _602 + 2;
        uint4 _675 = uint4(_110[2] * 255.5);
        float4 _681 = fast::clamp((float4((_675 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
        float4 _687 = fast::clamp((float4((_675 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
        float4 _693 = fast::clamp((float4((_675 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
        float4 _698 = fast::clamp((float4(_675 & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
        float4 _711 = (((((float4(_609, _611, _618, _620) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_658][_603] >> 16u)).x, _609, _611, _618) * _681)) + (float4(_611, _618, _620, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_665][_603] & 65535u)).x) * _687)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_602][_622] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_602][_622] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_612][_622] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_612][_622] >> 16u)).x) * _693)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_602][_640] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_602][_640] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_612][_640] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_612][_640] >> 16u)).x) * _698)) / ((((float4(0.5) + _681) + _687) + _693) + _698);
        s_FFX_CACAO_BlurF16Back_4[_602][_603] = as_type<uint>(half2(float2(_711.x, 0.0))) | (as_type<uint>(half2(float2(_711.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_612][_603] = as_type<uint>(half2(float2(_711.z, 0.0))) | (as_type<uint>(half2(float2(_711.w, 0.0))) << 16u);
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (((2u * _343) + 1u) < 2u)
        {
            float2 _738 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_273][_274] & 65535u));
            float _739 = _738.x;
            float2 _740 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_273][_274] >> 16u));
            float _741 = _740.x;
            float2 _745 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_284][_274] & 65535u));
            float _746 = _745.x;
            float2 _747 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_284][_274] >> 16u));
            float _748 = _747.x;
            uint4 _799 = uint4(_110[0] * 255.5);
            float4 _805 = fast::clamp((float4((_799 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
            float4 _811 = fast::clamp((float4((_799 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
            float4 _817 = fast::clamp((float4((_799 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
            float4 _822 = fast::clamp((float4(_799 & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
            float4 _835 = (((((float4(_739, _741, _746, _748) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_397][_274] >> 16u)).x, _739, _741, _746) * _805)) + (float4(_741, _746, _748, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_404][_274] & 65535u)).x) * _811)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_273][_364] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_273][_364] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_284][_364] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_284][_364] >> 16u)).x) * _817)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_273][_300] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_273][_300] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_284][_300] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_284][_300] >> 16u)).x) * _822)) / ((((float4(0.5) + _805) + _811) + _817) + _822);
            s_FFX_CACAO_BlurF16Front_4[_273][_274] = as_type<uint>(half2(float2(_835.x, 0.0))) | (as_type<uint>(half2(float2(_835.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_284][_274] = as_type<uint>(half2(float2(_835.z, 0.0))) | (as_type<uint>(half2(float2(_835.w, 0.0))) << 16u);
            float2 _855 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_473][_474] & 65535u));
            float _856 = _855.x;
            float2 _857 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_473][_474] >> 16u));
            float _858 = _857.x;
            float2 _862 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_483][_474] & 65535u));
            float _863 = _862.x;
            float2 _864 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_483][_474] >> 16u));
            float _865 = _864.x;
            uint4 _916 = uint4(_110[1] * 255.5);
            float4 _922 = fast::clamp((float4((_916 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
            float4 _928 = fast::clamp((float4((_916 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
            float4 _934 = fast::clamp((float4((_916 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
            float4 _939 = fast::clamp((float4(_916 & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
            float4 _952 = (((((float4(_856, _858, _863, _865) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_529][_474] >> 16u)).x, _856, _858, _863) * _922)) + (float4(_858, _863, _865, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_536][_474] & 65535u)).x) * _928)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_473][_493] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_473][_493] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_483][_493] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_483][_493] >> 16u)).x) * _934)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_473][_511] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_473][_511] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_483][_511] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_483][_511] >> 16u)).x) * _939)) / ((((float4(0.5) + _922) + _928) + _934) + _939);
            s_FFX_CACAO_BlurF16Front_4[_473][_474] = as_type<uint>(half2(float2(_952.x, 0.0))) | (as_type<uint>(half2(float2(_952.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_483][_474] = as_type<uint>(half2(float2(_952.z, 0.0))) | (as_type<uint>(half2(float2(_952.w, 0.0))) << 16u);
            float2 _972 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_602][_603] & 65535u));
            float _973 = _972.x;
            float2 _974 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_602][_603] >> 16u));
            float _975 = _974.x;
            float2 _979 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_612][_603] & 65535u));
            float _980 = _979.x;
            float2 _981 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_612][_603] >> 16u));
            float _982 = _981.x;
            uint4 _1033 = uint4(_110[2] * 255.5);
            float4 _1039 = fast::clamp((float4((_1033 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
            float4 _1045 = fast::clamp((float4((_1033 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
            float4 _1051 = fast::clamp((float4((_1033 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
            float4 _1056 = fast::clamp((float4(_1033 & uint4(3u)) * float4(0.3333333432674407958984375)) + _421, float4(0.0), float4(1.0));
            float4 _1069 = (((((float4(_973, _975, _980, _982) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_658][_603] >> 16u)).x, _973, _975, _980) * _1039)) + (float4(_975, _980, _982, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_665][_603] & 65535u)).x) * _1045)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_602][_622] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_602][_622] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_612][_622] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_612][_622] >> 16u)).x) * _1051)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_602][_640] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_602][_640] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_612][_640] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_612][_640] >> 16u)).x) * _1056)) / ((((float4(0.5) + _1039) + _1045) + _1051) + _1056);
            s_FFX_CACAO_BlurF16Front_4[_602][_603] = as_type<uint>(half2(float2(_1069.x, 0.0))) | (as_type<uint>(half2(float2(_1069.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_612][_603] = as_type<uint>(half2(float2(_1069.z, 0.0))) | (as_type<uint>(half2(float2(_1069.w, 0.0))) << 16u);
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
    }
    for (uint _1087 = 0u; _1087 < 3u; _1087++)
    {
        uint _1095 = (3u * gl_LocalInvocationID.y) + _1087;
        bool _1100;
        if (2u <= _1095)
        {
            _1100 = _1095 < 46u;
        }
        else
        {
            _1100 = false;
        }
        if (_1100)
        {
            uint _1104 = 4u * gl_LocalInvocationID.x;
            uint _1106 = uint(_274) + _1087;
            bool _1127;
            if (2u <= _1104)
            {
                _1127 = _1104 < 62u;
            }
            else
            {
                _1127 = false;
            }
            if (_1127)
            {
                uint2 _1133 = uint2(_129 + int2(0, int(_1087)));
                uint3 _1143 = uint3(int3(int(_1133.x), int(_1133.y), int(_122)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_273][_1106] & 65535u)).x, _110[_1087].x).xyyy, uint2(_1143.xy), uint(_1143.z));
            }
            uint _1145 = _1104 + 1u;
            bool _1150;
            if (2u <= _1145)
            {
                _1150 = _1145 < 62u;
            }
            else
            {
                _1150 = false;
            }
            if (_1150)
            {
                uint2 _1156 = uint2(_129 + int2(1, int(_1087)));
                uint3 _1166 = uint3(int3(int(_1156.x), int(_1156.y), int(_122)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_273][_1106] >> 16u)).x, _110[_1087].y).xyyy, uint2(_1166.xy), uint(_1166.z));
            }
            uint _1168 = _1104 + 2u;
            bool _1173;
            if (2u <= _1168)
            {
                _1173 = _1168 < 62u;
            }
            else
            {
                _1173 = false;
            }
            if (_1173)
            {
                uint2 _1179 = uint2(_129 + int2(2, int(_1087)));
                uint3 _1189 = uint3(int3(int(_1179.x), int(_1179.y), int(_122)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_284][_1106] & 65535u)).x, _110[_1087].z).xyyy, uint2(_1189.xy), uint(_1189.z));
            }
            uint _1191 = _1104 + 3u;
            bool _1196;
            if (2u <= _1191)
            {
                _1196 = _1191 < 62u;
            }
            else
            {
                _1196 = false;
            }
            if (_1196)
            {
                uint2 _1202 = uint2(_129 + int2(3, int(_1087)));
                uint3 _1212 = uint3(int3(int(_1202.x), int(_1202.y), int(_122)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_284][_1106] >> 16u)).x, _110[_1087].w).xyyy, uint2(_1212.xy), uint(_1212.z));
            }
        }
    }
}

)CACAO_GPU";
inline constexpr Binding bindings18[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_SsaoBufferPing","texture",0},{"g_RwSsaoBufferPong","texture",1},{"g_PointMirrorSampler","sampler",0}};
inline constexpr const char*source18=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d_array<float> g_SsaoBufferPing [[texture(0)]], texture2d_array<float, access::write> g_RwSsaoBufferPong [[texture(1)]], sampler g_PointMirrorSampler [[sampler(0)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Front_4;
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Back_4;
    bool _123;
    if (gl_WorkGroupID.z == 1u)
    {
        _123 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BlurNumPasses == 2;
    }
    else
    {
        _123 = false;
    }
    uint _124 = _123 ? 3u : gl_WorkGroupID.z;
    int2 _128 = int2(gl_LocalInvocationID.xy);
    int2 _130 = (int2(gl_WorkGroupID.xy) * int2(58, 42)) + (int2(4, 3) * _128);
    int2 _131 = _130 - int2(3);
    int2 _132 = int2(2, 3) * _128;
    int2 _133 = _132 + int2(1);
    float _141 = float(_124);
    float3 _144 = float3((float2(_131) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _141);
    float4 _146 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _144.xy, uint(rint(_144.z)), level(0.0));
    float3 _155 = float3((float2(_130 + int2(-2, -3)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _141);
    float4 _157 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _155.xy, uint(rint(_155.z)), level(0.0));
    float3 _166 = float3((float2(_130 + int2(-1, -3)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _141);
    float4 _168 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _166.xy, uint(rint(_166.z)), level(0.0));
    float3 _177 = float3((float2(_130 + int2(0, -3)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _141);
    float4 _179 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _177.xy, uint(rint(_177.z)), level(0.0));
    float3 _188 = float3((float2(_130 + int2(-3, -2)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _141);
    float4 _190 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _188.xy, uint(rint(_188.z)), level(0.0));
    float3 _199 = float3((float2(_130 + int2(-2)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _141);
    float4 _201 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _199.xy, uint(rint(_199.z)), level(0.0));
    float3 _210 = float3((float2(_130 + int2(-1, -2)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _141);
    float4 _212 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _210.xy, uint(rint(_210.z)), level(0.0));
    float3 _221 = float3((float2(_130 + int2(0, -2)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _141);
    float4 _223 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _221.xy, uint(rint(_221.z)), level(0.0));
    float3 _232 = float3((float2(_130 + int2(-3, -1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _141);
    float4 _234 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _232.xy, uint(rint(_232.z)), level(0.0));
    float3 _243 = float3((float2(_130 + int2(-2, -1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _141);
    float4 _245 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _243.xy, uint(rint(_243.z)), level(0.0));
    float3 _254 = float3((float2(_130 + int2(-1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _141);
    float4 _256 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _254.xy, uint(rint(_254.z)), level(0.0));
    float3 _265 = float3((float2(_130 + int2(0, -1)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _141);
    float4 _267 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _265.xy, uint(rint(_265.z)), level(0.0));
    int _276 = _133.x;
    int _277 = _133.y;
    s_FFX_CACAO_BlurF16Front_4[_276][_277] = as_type<uint>(half2(float2(_146.x, 0.0))) | (as_type<uint>(half2(float2(_157.x, 0.0))) << 16u);
    int _287 = _276 + 1;
    s_FFX_CACAO_BlurF16Front_4[_287][_277] = as_type<uint>(half2(float2(_168.x, 0.0))) | (as_type<uint>(half2(float2(_179.x, 0.0))) << 16u);
    spvUnsafeArray<float4, 3> _112;
    _112[0] = float4(_146.y, _157.y, _168.y, _179.y);
    int _303 = _277 + 1;
    s_FFX_CACAO_BlurF16Front_4[_276][_303] = as_type<uint>(half2(float2(_190.x, 0.0))) | (as_type<uint>(half2(float2(_201.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_287][_303] = as_type<uint>(half2(float2(_212.x, 0.0))) | (as_type<uint>(half2(float2(_223.x, 0.0))) << 16u);
    _112[1] = float4(_190.y, _201.y, _212.y, _223.y);
    int _328 = _277 + 2;
    s_FFX_CACAO_BlurF16Front_4[_276][_328] = as_type<uint>(half2(float2(_234.x, 0.0))) | (as_type<uint>(half2(float2(_245.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_287][_328] = as_type<uint>(half2(float2(_256.x, 0.0))) | (as_type<uint>(half2(float2(_267.x, 0.0))) << 16u);
    _112[2] = float4(_234.y, _245.y, _256.y, _267.y);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint _346 = 0u; _346 < 2u; _346++)
    {
        float2 _355 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_276][_277] & 65535u));
        float _356 = _355.x;
        float2 _357 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_276][_277] >> 16u));
        float _358 = _357.x;
        float2 _362 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_287][_277] & 65535u));
        float _363 = _362.x;
        float2 _364 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_287][_277] >> 16u));
        float _365 = _364.x;
        int _367 = _277 - 1;
        int _400 = _276 - 1;
        int _407 = _276 + 2;
        uint4 _417 = uint4(_112[0] * 255.5);
        float4 _424 = float4(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.InvSharpness);
        float4 _426 = fast::clamp((float4((_417 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
        float4 _432 = fast::clamp((float4((_417 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
        float4 _438 = fast::clamp((float4((_417 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
        float4 _443 = fast::clamp((float4(_417 & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
        float4 _456 = (((((float4(_356, _358, _363, _365) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_400][_277] >> 16u)).x, _356, _358, _363) * _426)) + (float4(_358, _363, _365, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_407][_277] & 65535u)).x) * _432)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_276][_367] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_276][_367] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_287][_367] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_287][_367] >> 16u)).x) * _438)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_276][_303] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_276][_303] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_287][_303] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_287][_303] >> 16u)).x) * _443)) / ((((float4(0.5) + _426) + _432) + _438) + _443);
        s_FFX_CACAO_BlurF16Back_4[_276][_277] = as_type<uint>(half2(float2(_456.x, 0.0))) | (as_type<uint>(half2(float2(_456.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_287][_277] = as_type<uint>(half2(float2(_456.z, 0.0))) | (as_type<uint>(half2(float2(_456.w, 0.0))) << 16u);
        int2 _475 = _132 + int2(1, 2);
        int _476 = _475.x;
        int _477 = _475.y;
        float2 _482 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_476][_477] & 65535u));
        float _483 = _482.x;
        float2 _484 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_476][_477] >> 16u));
        float _485 = _484.x;
        int _486 = _476 + 1;
        float2 _491 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_486][_477] & 65535u));
        float _492 = _491.x;
        float2 _493 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_486][_477] >> 16u));
        float _494 = _493.x;
        int _496 = _477 - 1;
        int _514 = _477 + 1;
        int _532 = _476 - 1;
        int _539 = _476 + 2;
        uint4 _549 = uint4(_112[1] * 255.5);
        float4 _555 = fast::clamp((float4((_549 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
        float4 _561 = fast::clamp((float4((_549 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
        float4 _567 = fast::clamp((float4((_549 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
        float4 _572 = fast::clamp((float4(_549 & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
        float4 _585 = (((((float4(_483, _485, _492, _494) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_532][_477] >> 16u)).x, _483, _485, _492) * _555)) + (float4(_485, _492, _494, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_539][_477] & 65535u)).x) * _561)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_476][_496] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_476][_496] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_486][_496] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_486][_496] >> 16u)).x) * _567)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_476][_514] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_476][_514] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_486][_514] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_486][_514] >> 16u)).x) * _572)) / ((((float4(0.5) + _555) + _561) + _567) + _572);
        s_FFX_CACAO_BlurF16Back_4[_476][_477] = as_type<uint>(half2(float2(_585.x, 0.0))) | (as_type<uint>(half2(float2(_585.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_486][_477] = as_type<uint>(half2(float2(_585.z, 0.0))) | (as_type<uint>(half2(float2(_585.w, 0.0))) << 16u);
        int2 _604 = _132 + int2(1, 3);
        int _605 = _604.x;
        int _606 = _604.y;
        float2 _611 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_605][_606] & 65535u));
        float _612 = _611.x;
        float2 _613 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_605][_606] >> 16u));
        float _614 = _613.x;
        int _615 = _605 + 1;
        float2 _620 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_615][_606] & 65535u));
        float _621 = _620.x;
        float2 _622 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_615][_606] >> 16u));
        float _623 = _622.x;
        int _625 = _606 - 1;
        int _643 = _606 + 1;
        int _661 = _605 - 1;
        int _668 = _605 + 2;
        uint4 _678 = uint4(_112[2] * 255.5);
        float4 _684 = fast::clamp((float4((_678 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
        float4 _690 = fast::clamp((float4((_678 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
        float4 _696 = fast::clamp((float4((_678 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
        float4 _701 = fast::clamp((float4(_678 & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
        float4 _714 = (((((float4(_612, _614, _621, _623) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_661][_606] >> 16u)).x, _612, _614, _621) * _684)) + (float4(_614, _621, _623, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_668][_606] & 65535u)).x) * _690)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_605][_625] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_605][_625] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_615][_625] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_615][_625] >> 16u)).x) * _696)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_605][_643] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_605][_643] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_615][_643] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_615][_643] >> 16u)).x) * _701)) / ((((float4(0.5) + _684) + _690) + _696) + _701);
        s_FFX_CACAO_BlurF16Back_4[_605][_606] = as_type<uint>(half2(float2(_714.x, 0.0))) | (as_type<uint>(half2(float2(_714.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_615][_606] = as_type<uint>(half2(float2(_714.z, 0.0))) | (as_type<uint>(half2(float2(_714.w, 0.0))) << 16u);
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (((2u * _346) + 1u) < 3u)
        {
            float2 _741 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_276][_277] & 65535u));
            float _742 = _741.x;
            float2 _743 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_276][_277] >> 16u));
            float _744 = _743.x;
            float2 _748 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_287][_277] & 65535u));
            float _749 = _748.x;
            float2 _750 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_287][_277] >> 16u));
            float _751 = _750.x;
            uint4 _802 = uint4(_112[0] * 255.5);
            float4 _808 = fast::clamp((float4((_802 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
            float4 _814 = fast::clamp((float4((_802 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
            float4 _820 = fast::clamp((float4((_802 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
            float4 _825 = fast::clamp((float4(_802 & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
            float4 _838 = (((((float4(_742, _744, _749, _751) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_400][_277] >> 16u)).x, _742, _744, _749) * _808)) + (float4(_744, _749, _751, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_407][_277] & 65535u)).x) * _814)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_276][_367] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_276][_367] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_287][_367] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_287][_367] >> 16u)).x) * _820)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_276][_303] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_276][_303] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_287][_303] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_287][_303] >> 16u)).x) * _825)) / ((((float4(0.5) + _808) + _814) + _820) + _825);
            s_FFX_CACAO_BlurF16Front_4[_276][_277] = as_type<uint>(half2(float2(_838.x, 0.0))) | (as_type<uint>(half2(float2(_838.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_287][_277] = as_type<uint>(half2(float2(_838.z, 0.0))) | (as_type<uint>(half2(float2(_838.w, 0.0))) << 16u);
            float2 _858 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_476][_477] & 65535u));
            float _859 = _858.x;
            float2 _860 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_476][_477] >> 16u));
            float _861 = _860.x;
            float2 _865 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_486][_477] & 65535u));
            float _866 = _865.x;
            float2 _867 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_486][_477] >> 16u));
            float _868 = _867.x;
            uint4 _919 = uint4(_112[1] * 255.5);
            float4 _925 = fast::clamp((float4((_919 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
            float4 _931 = fast::clamp((float4((_919 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
            float4 _937 = fast::clamp((float4((_919 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
            float4 _942 = fast::clamp((float4(_919 & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
            float4 _955 = (((((float4(_859, _861, _866, _868) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_532][_477] >> 16u)).x, _859, _861, _866) * _925)) + (float4(_861, _866, _868, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_539][_477] & 65535u)).x) * _931)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_476][_496] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_476][_496] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_486][_496] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_486][_496] >> 16u)).x) * _937)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_476][_514] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_476][_514] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_486][_514] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_486][_514] >> 16u)).x) * _942)) / ((((float4(0.5) + _925) + _931) + _937) + _942);
            s_FFX_CACAO_BlurF16Front_4[_476][_477] = as_type<uint>(half2(float2(_955.x, 0.0))) | (as_type<uint>(half2(float2(_955.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_486][_477] = as_type<uint>(half2(float2(_955.z, 0.0))) | (as_type<uint>(half2(float2(_955.w, 0.0))) << 16u);
            float2 _975 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_605][_606] & 65535u));
            float _976 = _975.x;
            float2 _977 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_605][_606] >> 16u));
            float _978 = _977.x;
            float2 _982 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_615][_606] & 65535u));
            float _983 = _982.x;
            float2 _984 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_615][_606] >> 16u));
            float _985 = _984.x;
            uint4 _1036 = uint4(_112[2] * 255.5);
            float4 _1042 = fast::clamp((float4((_1036 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
            float4 _1048 = fast::clamp((float4((_1036 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
            float4 _1054 = fast::clamp((float4((_1036 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
            float4 _1059 = fast::clamp((float4(_1036 & uint4(3u)) * float4(0.3333333432674407958984375)) + _424, float4(0.0), float4(1.0));
            float4 _1072 = (((((float4(_976, _978, _983, _985) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_661][_606] >> 16u)).x, _976, _978, _983) * _1042)) + (float4(_978, _983, _985, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_668][_606] & 65535u)).x) * _1048)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_605][_625] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_605][_625] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_615][_625] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_615][_625] >> 16u)).x) * _1054)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_605][_643] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_605][_643] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_615][_643] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_615][_643] >> 16u)).x) * _1059)) / ((((float4(0.5) + _1042) + _1048) + _1054) + _1059);
            s_FFX_CACAO_BlurF16Front_4[_605][_606] = as_type<uint>(half2(float2(_1072.x, 0.0))) | (as_type<uint>(half2(float2(_1072.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_615][_606] = as_type<uint>(half2(float2(_1072.z, 0.0))) | (as_type<uint>(half2(float2(_1072.w, 0.0))) << 16u);
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
    }
    for (uint _1090 = 0u; _1090 < 3u; _1090++)
    {
        uint _1098 = (3u * gl_LocalInvocationID.y) + _1090;
        bool _1103;
        if (3u <= _1098)
        {
            _1103 = _1098 < 45u;
        }
        else
        {
            _1103 = false;
        }
        if (_1103)
        {
            uint _1107 = 4u * gl_LocalInvocationID.x;
            uint _1109 = uint(_277) + _1090;
            bool _1130;
            if (3u <= _1107)
            {
                _1130 = _1107 < 61u;
            }
            else
            {
                _1130 = false;
            }
            if (_1130)
            {
                uint2 _1136 = uint2(_131 + int2(0, int(_1090)));
                uint3 _1146 = uint3(int3(int(_1136.x), int(_1136.y), int(_124)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_276][_1109] & 65535u)).x, _112[_1090].x).xyyy, uint2(_1146.xy), uint(_1146.z));
            }
            uint _1148 = _1107 + 1u;
            bool _1153;
            if (3u <= _1148)
            {
                _1153 = _1148 < 61u;
            }
            else
            {
                _1153 = false;
            }
            if (_1153)
            {
                uint2 _1159 = uint2(_131 + int2(1, int(_1090)));
                uint3 _1169 = uint3(int3(int(_1159.x), int(_1159.y), int(_124)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_276][_1109] >> 16u)).x, _112[_1090].y).xyyy, uint2(_1169.xy), uint(_1169.z));
            }
            uint _1171 = _1107 + 2u;
            bool _1176;
            if (3u <= _1171)
            {
                _1176 = _1171 < 61u;
            }
            else
            {
                _1176 = false;
            }
            if (_1176)
            {
                uint2 _1182 = uint2(_131 + int2(2, int(_1090)));
                uint3 _1192 = uint3(int3(int(_1182.x), int(_1182.y), int(_124)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_287][_1109] & 65535u)).x, _112[_1090].z).xyyy, uint2(_1192.xy), uint(_1192.z));
            }
            uint _1194 = _1107 + 3u;
            bool _1199;
            if (3u <= _1194)
            {
                _1199 = _1194 < 61u;
            }
            else
            {
                _1199 = false;
            }
            if (_1199)
            {
                uint2 _1205 = uint2(_131 + int2(3, int(_1090)));
                uint3 _1215 = uint3(int3(int(_1205.x), int(_1205.y), int(_124)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_287][_1109] >> 16u)).x, _112[_1090].w).xyyy, uint2(_1215.xy), uint(_1215.z));
            }
        }
    }
}

)CACAO_GPU";
inline constexpr Binding bindings19[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_SsaoBufferPing","texture",0},{"g_RwSsaoBufferPong","texture",1},{"g_PointMirrorSampler","sampler",0}};
inline constexpr const char*source19=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d_array<float> g_SsaoBufferPing [[texture(0)]], texture2d_array<float, access::write> g_RwSsaoBufferPong [[texture(1)]], sampler g_PointMirrorSampler [[sampler(0)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Front_4;
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Back_4;
    bool _124;
    if (gl_WorkGroupID.z == 1u)
    {
        _124 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BlurNumPasses == 2;
    }
    else
    {
        _124 = false;
    }
    uint _125 = _124 ? 3u : gl_WorkGroupID.z;
    int2 _129 = int2(gl_LocalInvocationID.xy);
    int2 _131 = (int2(gl_WorkGroupID.xy) * int2(56, 40)) + (int2(4, 3) * _129);
    int2 _132 = _131 - int2(4);
    int2 _133 = int2(2, 3) * _129;
    int2 _134 = _133 + int2(1);
    float _142 = float(_125);
    float3 _145 = float3((float2(_132) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _142);
    float4 _147 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _145.xy, uint(rint(_145.z)), level(0.0));
    float3 _156 = float3((float2(_131 + int2(-3, -4)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _142);
    float4 _158 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _156.xy, uint(rint(_156.z)), level(0.0));
    float3 _167 = float3((float2(_131 + int2(-2, -4)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _142);
    float4 _169 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _167.xy, uint(rint(_167.z)), level(0.0));
    float3 _178 = float3((float2(_131 + int2(-1, -4)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _142);
    float4 _180 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _178.xy, uint(rint(_178.z)), level(0.0));
    float3 _189 = float3((float2(_131 + int2(-4, -3)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _142);
    float4 _191 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _189.xy, uint(rint(_189.z)), level(0.0));
    float3 _200 = float3((float2(_131 + int2(-3)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _142);
    float4 _202 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _200.xy, uint(rint(_200.z)), level(0.0));
    float3 _211 = float3((float2(_131 + int2(-2, -3)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _142);
    float4 _213 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _211.xy, uint(rint(_211.z)), level(0.0));
    float3 _222 = float3((float2(_131 + int2(-1, -3)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _142);
    float4 _224 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _222.xy, uint(rint(_222.z)), level(0.0));
    float3 _233 = float3((float2(_131 + int2(-4, -2)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _142);
    float4 _235 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _233.xy, uint(rint(_233.z)), level(0.0));
    float3 _244 = float3((float2(_131 + int2(-3, -2)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _142);
    float4 _246 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _244.xy, uint(rint(_244.z)), level(0.0));
    float3 _255 = float3((float2(_131 + int2(-2)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _142);
    float4 _257 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _255.xy, uint(rint(_255.z)), level(0.0));
    float3 _266 = float3((float2(_131 + int2(-1, -2)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _142);
    float4 _268 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _266.xy, uint(rint(_266.z)), level(0.0));
    int _277 = _134.x;
    int _278 = _134.y;
    s_FFX_CACAO_BlurF16Front_4[_277][_278] = as_type<uint>(half2(float2(_147.x, 0.0))) | (as_type<uint>(half2(float2(_158.x, 0.0))) << 16u);
    int _288 = _277 + 1;
    s_FFX_CACAO_BlurF16Front_4[_288][_278] = as_type<uint>(half2(float2(_169.x, 0.0))) | (as_type<uint>(half2(float2(_180.x, 0.0))) << 16u);
    spvUnsafeArray<float4, 3> _113;
    _113[0] = float4(_147.y, _158.y, _169.y, _180.y);
    int _304 = _278 + 1;
    s_FFX_CACAO_BlurF16Front_4[_277][_304] = as_type<uint>(half2(float2(_191.x, 0.0))) | (as_type<uint>(half2(float2(_202.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_288][_304] = as_type<uint>(half2(float2(_213.x, 0.0))) | (as_type<uint>(half2(float2(_224.x, 0.0))) << 16u);
    _113[1] = float4(_191.y, _202.y, _213.y, _224.y);
    int _329 = _278 + 2;
    s_FFX_CACAO_BlurF16Front_4[_277][_329] = as_type<uint>(half2(float2(_235.x, 0.0))) | (as_type<uint>(half2(float2(_246.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_288][_329] = as_type<uint>(half2(float2(_257.x, 0.0))) | (as_type<uint>(half2(float2(_268.x, 0.0))) << 16u);
    _113[2] = float4(_235.y, _246.y, _257.y, _268.y);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint _347 = 0u; _347 < 2u; _347++)
    {
        float2 _356 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_277][_278] & 65535u));
        float _357 = _356.x;
        float2 _358 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_277][_278] >> 16u));
        float _359 = _358.x;
        float2 _363 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_288][_278] & 65535u));
        float _364 = _363.x;
        float2 _365 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_288][_278] >> 16u));
        float _366 = _365.x;
        int _368 = _278 - 1;
        int _401 = _277 - 1;
        int _408 = _277 + 2;
        uint4 _418 = uint4(_113[0] * 255.5);
        float4 _425 = float4(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.InvSharpness);
        float4 _427 = fast::clamp((float4((_418 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
        float4 _433 = fast::clamp((float4((_418 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
        float4 _439 = fast::clamp((float4((_418 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
        float4 _444 = fast::clamp((float4(_418 & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
        float4 _457 = (((((float4(_357, _359, _364, _366) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_401][_278] >> 16u)).x, _357, _359, _364) * _427)) + (float4(_359, _364, _366, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_408][_278] & 65535u)).x) * _433)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_277][_368] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_277][_368] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_288][_368] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_288][_368] >> 16u)).x) * _439)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_277][_304] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_277][_304] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_288][_304] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_288][_304] >> 16u)).x) * _444)) / ((((float4(0.5) + _427) + _433) + _439) + _444);
        s_FFX_CACAO_BlurF16Back_4[_277][_278] = as_type<uint>(half2(float2(_457.x, 0.0))) | (as_type<uint>(half2(float2(_457.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_288][_278] = as_type<uint>(half2(float2(_457.z, 0.0))) | (as_type<uint>(half2(float2(_457.w, 0.0))) << 16u);
        int2 _476 = _133 + int2(1, 2);
        int _477 = _476.x;
        int _478 = _476.y;
        float2 _483 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_477][_478] & 65535u));
        float _484 = _483.x;
        float2 _485 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_477][_478] >> 16u));
        float _486 = _485.x;
        int _487 = _477 + 1;
        float2 _492 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_487][_478] & 65535u));
        float _493 = _492.x;
        float2 _494 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_487][_478] >> 16u));
        float _495 = _494.x;
        int _497 = _478 - 1;
        int _515 = _478 + 1;
        int _533 = _477 - 1;
        int _540 = _477 + 2;
        uint4 _550 = uint4(_113[1] * 255.5);
        float4 _556 = fast::clamp((float4((_550 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
        float4 _562 = fast::clamp((float4((_550 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
        float4 _568 = fast::clamp((float4((_550 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
        float4 _573 = fast::clamp((float4(_550 & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
        float4 _586 = (((((float4(_484, _486, _493, _495) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_533][_478] >> 16u)).x, _484, _486, _493) * _556)) + (float4(_486, _493, _495, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_540][_478] & 65535u)).x) * _562)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_477][_497] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_477][_497] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_487][_497] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_487][_497] >> 16u)).x) * _568)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_477][_515] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_477][_515] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_487][_515] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_487][_515] >> 16u)).x) * _573)) / ((((float4(0.5) + _556) + _562) + _568) + _573);
        s_FFX_CACAO_BlurF16Back_4[_477][_478] = as_type<uint>(half2(float2(_586.x, 0.0))) | (as_type<uint>(half2(float2(_586.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_487][_478] = as_type<uint>(half2(float2(_586.z, 0.0))) | (as_type<uint>(half2(float2(_586.w, 0.0))) << 16u);
        int2 _605 = _133 + int2(1, 3);
        int _606 = _605.x;
        int _607 = _605.y;
        float2 _612 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_606][_607] & 65535u));
        float _613 = _612.x;
        float2 _614 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_606][_607] >> 16u));
        float _615 = _614.x;
        int _616 = _606 + 1;
        float2 _621 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_616][_607] & 65535u));
        float _622 = _621.x;
        float2 _623 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_616][_607] >> 16u));
        float _624 = _623.x;
        int _626 = _607 - 1;
        int _644 = _607 + 1;
        int _662 = _606 - 1;
        int _669 = _606 + 2;
        uint4 _679 = uint4(_113[2] * 255.5);
        float4 _685 = fast::clamp((float4((_679 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
        float4 _691 = fast::clamp((float4((_679 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
        float4 _697 = fast::clamp((float4((_679 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
        float4 _702 = fast::clamp((float4(_679 & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
        float4 _715 = (((((float4(_613, _615, _622, _624) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_662][_607] >> 16u)).x, _613, _615, _622) * _685)) + (float4(_615, _622, _624, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_669][_607] & 65535u)).x) * _691)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_606][_626] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_606][_626] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_616][_626] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_616][_626] >> 16u)).x) * _697)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_606][_644] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_606][_644] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_616][_644] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_616][_644] >> 16u)).x) * _702)) / ((((float4(0.5) + _685) + _691) + _697) + _702);
        s_FFX_CACAO_BlurF16Back_4[_606][_607] = as_type<uint>(half2(float2(_715.x, 0.0))) | (as_type<uint>(half2(float2(_715.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_616][_607] = as_type<uint>(half2(float2(_715.z, 0.0))) | (as_type<uint>(half2(float2(_715.w, 0.0))) << 16u);
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (((2u * _347) + 1u) < 4u)
        {
            float2 _742 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_277][_278] & 65535u));
            float _743 = _742.x;
            float2 _744 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_277][_278] >> 16u));
            float _745 = _744.x;
            float2 _749 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_288][_278] & 65535u));
            float _750 = _749.x;
            float2 _751 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_288][_278] >> 16u));
            float _752 = _751.x;
            uint4 _803 = uint4(_113[0] * 255.5);
            float4 _809 = fast::clamp((float4((_803 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
            float4 _815 = fast::clamp((float4((_803 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
            float4 _821 = fast::clamp((float4((_803 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
            float4 _826 = fast::clamp((float4(_803 & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
            float4 _839 = (((((float4(_743, _745, _750, _752) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_401][_278] >> 16u)).x, _743, _745, _750) * _809)) + (float4(_745, _750, _752, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_408][_278] & 65535u)).x) * _815)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_277][_368] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_277][_368] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_288][_368] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_288][_368] >> 16u)).x) * _821)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_277][_304] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_277][_304] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_288][_304] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_288][_304] >> 16u)).x) * _826)) / ((((float4(0.5) + _809) + _815) + _821) + _826);
            s_FFX_CACAO_BlurF16Front_4[_277][_278] = as_type<uint>(half2(float2(_839.x, 0.0))) | (as_type<uint>(half2(float2(_839.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_288][_278] = as_type<uint>(half2(float2(_839.z, 0.0))) | (as_type<uint>(half2(float2(_839.w, 0.0))) << 16u);
            float2 _859 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_477][_478] & 65535u));
            float _860 = _859.x;
            float2 _861 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_477][_478] >> 16u));
            float _862 = _861.x;
            float2 _866 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_487][_478] & 65535u));
            float _867 = _866.x;
            float2 _868 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_487][_478] >> 16u));
            float _869 = _868.x;
            uint4 _920 = uint4(_113[1] * 255.5);
            float4 _926 = fast::clamp((float4((_920 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
            float4 _932 = fast::clamp((float4((_920 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
            float4 _938 = fast::clamp((float4((_920 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
            float4 _943 = fast::clamp((float4(_920 & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
            float4 _956 = (((((float4(_860, _862, _867, _869) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_533][_478] >> 16u)).x, _860, _862, _867) * _926)) + (float4(_862, _867, _869, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_540][_478] & 65535u)).x) * _932)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_477][_497] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_477][_497] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_487][_497] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_487][_497] >> 16u)).x) * _938)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_477][_515] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_477][_515] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_487][_515] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_487][_515] >> 16u)).x) * _943)) / ((((float4(0.5) + _926) + _932) + _938) + _943);
            s_FFX_CACAO_BlurF16Front_4[_477][_478] = as_type<uint>(half2(float2(_956.x, 0.0))) | (as_type<uint>(half2(float2(_956.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_487][_478] = as_type<uint>(half2(float2(_956.z, 0.0))) | (as_type<uint>(half2(float2(_956.w, 0.0))) << 16u);
            float2 _976 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_606][_607] & 65535u));
            float _977 = _976.x;
            float2 _978 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_606][_607] >> 16u));
            float _979 = _978.x;
            float2 _983 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_616][_607] & 65535u));
            float _984 = _983.x;
            float2 _985 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_616][_607] >> 16u));
            float _986 = _985.x;
            uint4 _1037 = uint4(_113[2] * 255.5);
            float4 _1043 = fast::clamp((float4((_1037 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
            float4 _1049 = fast::clamp((float4((_1037 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
            float4 _1055 = fast::clamp((float4((_1037 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
            float4 _1060 = fast::clamp((float4(_1037 & uint4(3u)) * float4(0.3333333432674407958984375)) + _425, float4(0.0), float4(1.0));
            float4 _1073 = (((((float4(_977, _979, _984, _986) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_662][_607] >> 16u)).x, _977, _979, _984) * _1043)) + (float4(_979, _984, _986, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_669][_607] & 65535u)).x) * _1049)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_606][_626] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_606][_626] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_616][_626] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_616][_626] >> 16u)).x) * _1055)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_606][_644] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_606][_644] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_616][_644] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_616][_644] >> 16u)).x) * _1060)) / ((((float4(0.5) + _1043) + _1049) + _1055) + _1060);
            s_FFX_CACAO_BlurF16Front_4[_606][_607] = as_type<uint>(half2(float2(_1073.x, 0.0))) | (as_type<uint>(half2(float2(_1073.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_616][_607] = as_type<uint>(half2(float2(_1073.z, 0.0))) | (as_type<uint>(half2(float2(_1073.w, 0.0))) << 16u);
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
    }
    for (uint _1091 = 0u; _1091 < 3u; _1091++)
    {
        uint _1099 = (3u * gl_LocalInvocationID.y) + _1091;
        bool _1104;
        if (4u <= _1099)
        {
            _1104 = _1099 < 44u;
        }
        else
        {
            _1104 = false;
        }
        if (_1104)
        {
            uint _1108 = 4u * gl_LocalInvocationID.x;
            uint _1110 = uint(_278) + _1091;
            bool _1131;
            if (4u <= _1108)
            {
                _1131 = _1108 < 60u;
            }
            else
            {
                _1131 = false;
            }
            if (_1131)
            {
                uint2 _1137 = uint2(_132 + int2(0, int(_1091)));
                uint3 _1147 = uint3(int3(int(_1137.x), int(_1137.y), int(_125)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_277][_1110] & 65535u)).x, _113[_1091].x).xyyy, uint2(_1147.xy), uint(_1147.z));
            }
            uint _1149 = _1108 + 1u;
            bool _1154;
            if (4u <= _1149)
            {
                _1154 = _1149 < 60u;
            }
            else
            {
                _1154 = false;
            }
            if (_1154)
            {
                uint2 _1160 = uint2(_132 + int2(1, int(_1091)));
                uint3 _1170 = uint3(int3(int(_1160.x), int(_1160.y), int(_125)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_277][_1110] >> 16u)).x, _113[_1091].y).xyyy, uint2(_1170.xy), uint(_1170.z));
            }
            uint _1172 = _1108 + 2u;
            bool _1177;
            if (4u <= _1172)
            {
                _1177 = _1172 < 60u;
            }
            else
            {
                _1177 = false;
            }
            if (_1177)
            {
                uint2 _1183 = uint2(_132 + int2(2, int(_1091)));
                uint3 _1193 = uint3(int3(int(_1183.x), int(_1183.y), int(_125)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_288][_1110] & 65535u)).x, _113[_1091].z).xyyy, uint2(_1193.xy), uint(_1193.z));
            }
            uint _1195 = _1108 + 3u;
            bool _1200;
            if (4u <= _1195)
            {
                _1200 = _1195 < 60u;
            }
            else
            {
                _1200 = false;
            }
            if (_1200)
            {
                uint2 _1206 = uint2(_132 + int2(3, int(_1091)));
                uint3 _1216 = uint3(int3(int(_1206.x), int(_1206.y), int(_125)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_288][_1110] >> 16u)).x, _113[_1091].w).xyyy, uint2(_1216.xy), uint(_1216.z));
            }
        }
    }
}

)CACAO_GPU";
inline constexpr Binding bindings20[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_SsaoBufferPing","texture",0},{"g_RwSsaoBufferPong","texture",1},{"g_PointMirrorSampler","sampler",0}};
inline constexpr const char*source20=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d_array<float> g_SsaoBufferPing [[texture(0)]], texture2d_array<float, access::write> g_RwSsaoBufferPong [[texture(1)]], sampler g_PointMirrorSampler [[sampler(0)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Front_4;
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Back_4;
    bool _125;
    if (gl_WorkGroupID.z == 1u)
    {
        _125 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BlurNumPasses == 2;
    }
    else
    {
        _125 = false;
    }
    uint _126 = _125 ? 3u : gl_WorkGroupID.z;
    int2 _130 = int2(gl_LocalInvocationID.xy);
    int2 _132 = (int2(gl_WorkGroupID.xy) * int2(54, 38)) + (int2(4, 3) * _130);
    int2 _133 = _132 - int2(5);
    int2 _134 = int2(2, 3) * _130;
    int2 _135 = _134 + int2(1);
    float _143 = float(_126);
    float3 _146 = float3((float2(_133) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _148 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _146.xy, uint(rint(_146.z)), level(0.0));
    float3 _157 = float3((float2(_132 + int2(-4, -5)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _159 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _157.xy, uint(rint(_157.z)), level(0.0));
    float3 _168 = float3((float2(_132 + int2(-3, -5)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _170 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _168.xy, uint(rint(_168.z)), level(0.0));
    float3 _179 = float3((float2(_132 + int2(-2, -5)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _181 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _179.xy, uint(rint(_179.z)), level(0.0));
    float3 _190 = float3((float2(_132 + int2(-5, -4)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _192 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _190.xy, uint(rint(_190.z)), level(0.0));
    float3 _201 = float3((float2(_132 + int2(-4)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _203 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _201.xy, uint(rint(_201.z)), level(0.0));
    float3 _212 = float3((float2(_132 + int2(-3, -4)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _214 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _212.xy, uint(rint(_212.z)), level(0.0));
    float3 _223 = float3((float2(_132 + int2(-2, -4)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _225 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _223.xy, uint(rint(_223.z)), level(0.0));
    float3 _234 = float3((float2(_132 + int2(-5, -3)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _236 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _234.xy, uint(rint(_234.z)), level(0.0));
    float3 _245 = float3((float2(_132 + int2(-4, -3)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _247 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _245.xy, uint(rint(_245.z)), level(0.0));
    float3 _256 = float3((float2(_132 + int2(-3)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _258 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _256.xy, uint(rint(_256.z)), level(0.0));
    float3 _267 = float3((float2(_132 + int2(-2, -3)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _269 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _267.xy, uint(rint(_267.z)), level(0.0));
    int _278 = _135.x;
    int _279 = _135.y;
    s_FFX_CACAO_BlurF16Front_4[_278][_279] = as_type<uint>(half2(float2(_148.x, 0.0))) | (as_type<uint>(half2(float2(_159.x, 0.0))) << 16u);
    int _289 = _278 + 1;
    s_FFX_CACAO_BlurF16Front_4[_289][_279] = as_type<uint>(half2(float2(_170.x, 0.0))) | (as_type<uint>(half2(float2(_181.x, 0.0))) << 16u);
    spvUnsafeArray<float4, 3> _114;
    _114[0] = float4(_148.y, _159.y, _170.y, _181.y);
    int _305 = _279 + 1;
    s_FFX_CACAO_BlurF16Front_4[_278][_305] = as_type<uint>(half2(float2(_192.x, 0.0))) | (as_type<uint>(half2(float2(_203.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_289][_305] = as_type<uint>(half2(float2(_214.x, 0.0))) | (as_type<uint>(half2(float2(_225.x, 0.0))) << 16u);
    _114[1] = float4(_192.y, _203.y, _214.y, _225.y);
    int _330 = _279 + 2;
    s_FFX_CACAO_BlurF16Front_4[_278][_330] = as_type<uint>(half2(float2(_236.x, 0.0))) | (as_type<uint>(half2(float2(_247.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_289][_330] = as_type<uint>(half2(float2(_258.x, 0.0))) | (as_type<uint>(half2(float2(_269.x, 0.0))) << 16u);
    _114[2] = float4(_236.y, _247.y, _258.y, _269.y);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint _348 = 0u; _348 < 3u; _348++)
    {
        float2 _357 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_279] & 65535u));
        float _358 = _357.x;
        float2 _359 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_279] >> 16u));
        float _360 = _359.x;
        float2 _364 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_279] & 65535u));
        float _365 = _364.x;
        float2 _366 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_279] >> 16u));
        float _367 = _366.x;
        int _369 = _279 - 1;
        int _402 = _278 - 1;
        int _409 = _278 + 2;
        uint4 _419 = uint4(_114[0] * 255.5);
        float4 _426 = float4(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.InvSharpness);
        float4 _428 = fast::clamp((float4((_419 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _434 = fast::clamp((float4((_419 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _440 = fast::clamp((float4((_419 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _445 = fast::clamp((float4(_419 & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _458 = (((((float4(_358, _360, _365, _367) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_402][_279] >> 16u)).x, _358, _360, _365) * _428)) + (float4(_360, _365, _367, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_409][_279] & 65535u)).x) * _434)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_369] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_369] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_369] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_369] >> 16u)).x) * _440)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_305] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_305] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_305] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_305] >> 16u)).x) * _445)) / ((((float4(0.5) + _428) + _434) + _440) + _445);
        s_FFX_CACAO_BlurF16Back_4[_278][_279] = as_type<uint>(half2(float2(_458.x, 0.0))) | (as_type<uint>(half2(float2(_458.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_289][_279] = as_type<uint>(half2(float2(_458.z, 0.0))) | (as_type<uint>(half2(float2(_458.w, 0.0))) << 16u);
        int2 _477 = _134 + int2(1, 2);
        int _478 = _477.x;
        int _479 = _477.y;
        float2 _484 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_478][_479] & 65535u));
        float _485 = _484.x;
        float2 _486 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_478][_479] >> 16u));
        float _487 = _486.x;
        int _488 = _478 + 1;
        float2 _493 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_488][_479] & 65535u));
        float _494 = _493.x;
        float2 _495 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_488][_479] >> 16u));
        float _496 = _495.x;
        int _498 = _479 - 1;
        int _516 = _479 + 1;
        int _534 = _478 - 1;
        int _541 = _478 + 2;
        uint4 _551 = uint4(_114[1] * 255.5);
        float4 _557 = fast::clamp((float4((_551 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _563 = fast::clamp((float4((_551 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _569 = fast::clamp((float4((_551 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _574 = fast::clamp((float4(_551 & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _587 = (((((float4(_485, _487, _494, _496) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_534][_479] >> 16u)).x, _485, _487, _494) * _557)) + (float4(_487, _494, _496, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_541][_479] & 65535u)).x) * _563)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_478][_498] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_478][_498] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_488][_498] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_488][_498] >> 16u)).x) * _569)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_478][_516] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_478][_516] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_488][_516] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_488][_516] >> 16u)).x) * _574)) / ((((float4(0.5) + _557) + _563) + _569) + _574);
        s_FFX_CACAO_BlurF16Back_4[_478][_479] = as_type<uint>(half2(float2(_587.x, 0.0))) | (as_type<uint>(half2(float2(_587.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_488][_479] = as_type<uint>(half2(float2(_587.z, 0.0))) | (as_type<uint>(half2(float2(_587.w, 0.0))) << 16u);
        int2 _606 = _134 + int2(1, 3);
        int _607 = _606.x;
        int _608 = _606.y;
        float2 _613 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_607][_608] & 65535u));
        float _614 = _613.x;
        float2 _615 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_607][_608] >> 16u));
        float _616 = _615.x;
        int _617 = _607 + 1;
        float2 _622 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_617][_608] & 65535u));
        float _623 = _622.x;
        float2 _624 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_617][_608] >> 16u));
        float _625 = _624.x;
        int _627 = _608 - 1;
        int _645 = _608 + 1;
        int _663 = _607 - 1;
        int _670 = _607 + 2;
        uint4 _680 = uint4(_114[2] * 255.5);
        float4 _686 = fast::clamp((float4((_680 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _692 = fast::clamp((float4((_680 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _698 = fast::clamp((float4((_680 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _703 = fast::clamp((float4(_680 & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _716 = (((((float4(_614, _616, _623, _625) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_663][_608] >> 16u)).x, _614, _616, _623) * _686)) + (float4(_616, _623, _625, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_670][_608] & 65535u)).x) * _692)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_607][_627] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_607][_627] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_617][_627] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_617][_627] >> 16u)).x) * _698)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_607][_645] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_607][_645] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_617][_645] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_617][_645] >> 16u)).x) * _703)) / ((((float4(0.5) + _686) + _692) + _698) + _703);
        s_FFX_CACAO_BlurF16Back_4[_607][_608] = as_type<uint>(half2(float2(_716.x, 0.0))) | (as_type<uint>(half2(float2(_716.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_617][_608] = as_type<uint>(half2(float2(_716.z, 0.0))) | (as_type<uint>(half2(float2(_716.w, 0.0))) << 16u);
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (((2u * _348) + 1u) < 5u)
        {
            float2 _743 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_279] & 65535u));
            float _744 = _743.x;
            float2 _745 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_279] >> 16u));
            float _746 = _745.x;
            float2 _750 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_279] & 65535u));
            float _751 = _750.x;
            float2 _752 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_279] >> 16u));
            float _753 = _752.x;
            uint4 _804 = uint4(_114[0] * 255.5);
            float4 _810 = fast::clamp((float4((_804 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _816 = fast::clamp((float4((_804 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _822 = fast::clamp((float4((_804 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _827 = fast::clamp((float4(_804 & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _840 = (((((float4(_744, _746, _751, _753) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_402][_279] >> 16u)).x, _744, _746, _751) * _810)) + (float4(_746, _751, _753, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_409][_279] & 65535u)).x) * _816)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_369] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_369] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_369] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_369] >> 16u)).x) * _822)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_305] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_305] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_305] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_305] >> 16u)).x) * _827)) / ((((float4(0.5) + _810) + _816) + _822) + _827);
            s_FFX_CACAO_BlurF16Front_4[_278][_279] = as_type<uint>(half2(float2(_840.x, 0.0))) | (as_type<uint>(half2(float2(_840.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_289][_279] = as_type<uint>(half2(float2(_840.z, 0.0))) | (as_type<uint>(half2(float2(_840.w, 0.0))) << 16u);
            float2 _860 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_478][_479] & 65535u));
            float _861 = _860.x;
            float2 _862 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_478][_479] >> 16u));
            float _863 = _862.x;
            float2 _867 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_488][_479] & 65535u));
            float _868 = _867.x;
            float2 _869 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_488][_479] >> 16u));
            float _870 = _869.x;
            uint4 _921 = uint4(_114[1] * 255.5);
            float4 _927 = fast::clamp((float4((_921 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _933 = fast::clamp((float4((_921 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _939 = fast::clamp((float4((_921 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _944 = fast::clamp((float4(_921 & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _957 = (((((float4(_861, _863, _868, _870) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_534][_479] >> 16u)).x, _861, _863, _868) * _927)) + (float4(_863, _868, _870, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_541][_479] & 65535u)).x) * _933)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_478][_498] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_478][_498] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_488][_498] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_488][_498] >> 16u)).x) * _939)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_478][_516] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_478][_516] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_488][_516] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_488][_516] >> 16u)).x) * _944)) / ((((float4(0.5) + _927) + _933) + _939) + _944);
            s_FFX_CACAO_BlurF16Front_4[_478][_479] = as_type<uint>(half2(float2(_957.x, 0.0))) | (as_type<uint>(half2(float2(_957.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_488][_479] = as_type<uint>(half2(float2(_957.z, 0.0))) | (as_type<uint>(half2(float2(_957.w, 0.0))) << 16u);
            float2 _977 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_607][_608] & 65535u));
            float _978 = _977.x;
            float2 _979 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_607][_608] >> 16u));
            float _980 = _979.x;
            float2 _984 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_617][_608] & 65535u));
            float _985 = _984.x;
            float2 _986 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_617][_608] >> 16u));
            float _987 = _986.x;
            uint4 _1038 = uint4(_114[2] * 255.5);
            float4 _1044 = fast::clamp((float4((_1038 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _1050 = fast::clamp((float4((_1038 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _1056 = fast::clamp((float4((_1038 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _1061 = fast::clamp((float4(_1038 & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _1074 = (((((float4(_978, _980, _985, _987) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_663][_608] >> 16u)).x, _978, _980, _985) * _1044)) + (float4(_980, _985, _987, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_670][_608] & 65535u)).x) * _1050)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_607][_627] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_607][_627] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_617][_627] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_617][_627] >> 16u)).x) * _1056)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_607][_645] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_607][_645] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_617][_645] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_617][_645] >> 16u)).x) * _1061)) / ((((float4(0.5) + _1044) + _1050) + _1056) + _1061);
            s_FFX_CACAO_BlurF16Front_4[_607][_608] = as_type<uint>(half2(float2(_1074.x, 0.0))) | (as_type<uint>(half2(float2(_1074.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_617][_608] = as_type<uint>(half2(float2(_1074.z, 0.0))) | (as_type<uint>(half2(float2(_1074.w, 0.0))) << 16u);
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
    }
    for (uint _1092 = 0u; _1092 < 3u; _1092++)
    {
        uint _1100 = (3u * gl_LocalInvocationID.y) + _1092;
        bool _1105;
        if (5u <= _1100)
        {
            _1105 = _1100 < 43u;
        }
        else
        {
            _1105 = false;
        }
        if (_1105)
        {
            uint _1109 = 4u * gl_LocalInvocationID.x;
            uint _1111 = uint(_279) + _1092;
            bool _1132;
            if (5u <= _1109)
            {
                _1132 = _1109 < 59u;
            }
            else
            {
                _1132 = false;
            }
            if (_1132)
            {
                uint2 _1138 = uint2(_133 + int2(0, int(_1092)));
                uint3 _1148 = uint3(int3(int(_1138.x), int(_1138.y), int(_126)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_1111] & 65535u)).x, _114[_1092].x).xyyy, uint2(_1148.xy), uint(_1148.z));
            }
            uint _1150 = _1109 + 1u;
            bool _1155;
            if (5u <= _1150)
            {
                _1155 = _1150 < 59u;
            }
            else
            {
                _1155 = false;
            }
            if (_1155)
            {
                uint2 _1161 = uint2(_133 + int2(1, int(_1092)));
                uint3 _1171 = uint3(int3(int(_1161.x), int(_1161.y), int(_126)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_1111] >> 16u)).x, _114[_1092].y).xyyy, uint2(_1171.xy), uint(_1171.z));
            }
            uint _1173 = _1109 + 2u;
            bool _1178;
            if (5u <= _1173)
            {
                _1178 = _1173 < 59u;
            }
            else
            {
                _1178 = false;
            }
            if (_1178)
            {
                uint2 _1184 = uint2(_133 + int2(2, int(_1092)));
                uint3 _1194 = uint3(int3(int(_1184.x), int(_1184.y), int(_126)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_1111] & 65535u)).x, _114[_1092].z).xyyy, uint2(_1194.xy), uint(_1194.z));
            }
            uint _1196 = _1109 + 3u;
            bool _1201;
            if (5u <= _1196)
            {
                _1201 = _1196 < 59u;
            }
            else
            {
                _1201 = false;
            }
            if (_1201)
            {
                uint2 _1207 = uint2(_133 + int2(3, int(_1092)));
                uint3 _1217 = uint3(int3(int(_1207.x), int(_1207.y), int(_126)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_1111] >> 16u)).x, _114[_1092].w).xyyy, uint2(_1217.xy), uint(_1217.z));
            }
        }
    }
}

)CACAO_GPU";
inline constexpr Binding bindings21[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_SsaoBufferPing","texture",0},{"g_RwSsaoBufferPong","texture",1},{"g_PointMirrorSampler","sampler",0}};
inline constexpr const char*source21=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d_array<float> g_SsaoBufferPing [[texture(0)]], texture2d_array<float, access::write> g_RwSsaoBufferPong [[texture(1)]], sampler g_PointMirrorSampler [[sampler(0)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Front_4;
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Back_4;
    bool _125;
    if (gl_WorkGroupID.z == 1u)
    {
        _125 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BlurNumPasses == 2;
    }
    else
    {
        _125 = false;
    }
    uint _126 = _125 ? 3u : gl_WorkGroupID.z;
    int2 _130 = int2(gl_LocalInvocationID.xy);
    int2 _132 = (int2(gl_WorkGroupID.xy) * int2(52, 36)) + (int2(4, 3) * _130);
    int2 _133 = _132 - int2(6);
    int2 _134 = int2(2, 3) * _130;
    int2 _135 = _134 + int2(1);
    float _143 = float(_126);
    float3 _146 = float3((float2(_133) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _148 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _146.xy, uint(rint(_146.z)), level(0.0));
    float3 _157 = float3((float2(_132 + int2(-5, -6)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _159 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _157.xy, uint(rint(_157.z)), level(0.0));
    float3 _168 = float3((float2(_132 + int2(-4, -6)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _170 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _168.xy, uint(rint(_168.z)), level(0.0));
    float3 _179 = float3((float2(_132 + int2(-3, -6)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _181 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _179.xy, uint(rint(_179.z)), level(0.0));
    float3 _190 = float3((float2(_132 + int2(-6, -5)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _192 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _190.xy, uint(rint(_190.z)), level(0.0));
    float3 _201 = float3((float2(_132 + int2(-5)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _203 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _201.xy, uint(rint(_201.z)), level(0.0));
    float3 _212 = float3((float2(_132 + int2(-4, -5)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _214 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _212.xy, uint(rint(_212.z)), level(0.0));
    float3 _223 = float3((float2(_132 + int2(-3, -5)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _225 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _223.xy, uint(rint(_223.z)), level(0.0));
    float3 _234 = float3((float2(_132 + int2(-6, -4)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _236 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _234.xy, uint(rint(_234.z)), level(0.0));
    float3 _245 = float3((float2(_132 + int2(-5, -4)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _247 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _245.xy, uint(rint(_245.z)), level(0.0));
    float3 _256 = float3((float2(_132 + int2(-4)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _258 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _256.xy, uint(rint(_256.z)), level(0.0));
    float3 _267 = float3((float2(_132 + int2(-3, -4)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _143);
    float4 _269 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _267.xy, uint(rint(_267.z)), level(0.0));
    int _278 = _135.x;
    int _279 = _135.y;
    s_FFX_CACAO_BlurF16Front_4[_278][_279] = as_type<uint>(half2(float2(_148.x, 0.0))) | (as_type<uint>(half2(float2(_159.x, 0.0))) << 16u);
    int _289 = _278 + 1;
    s_FFX_CACAO_BlurF16Front_4[_289][_279] = as_type<uint>(half2(float2(_170.x, 0.0))) | (as_type<uint>(half2(float2(_181.x, 0.0))) << 16u);
    spvUnsafeArray<float4, 3> _114;
    _114[0] = float4(_148.y, _159.y, _170.y, _181.y);
    int _305 = _279 + 1;
    s_FFX_CACAO_BlurF16Front_4[_278][_305] = as_type<uint>(half2(float2(_192.x, 0.0))) | (as_type<uint>(half2(float2(_203.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_289][_305] = as_type<uint>(half2(float2(_214.x, 0.0))) | (as_type<uint>(half2(float2(_225.x, 0.0))) << 16u);
    _114[1] = float4(_192.y, _203.y, _214.y, _225.y);
    int _330 = _279 + 2;
    s_FFX_CACAO_BlurF16Front_4[_278][_330] = as_type<uint>(half2(float2(_236.x, 0.0))) | (as_type<uint>(half2(float2(_247.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_289][_330] = as_type<uint>(half2(float2(_258.x, 0.0))) | (as_type<uint>(half2(float2(_269.x, 0.0))) << 16u);
    _114[2] = float4(_236.y, _247.y, _258.y, _269.y);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint _348 = 0u; _348 < 3u; _348++)
    {
        float2 _357 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_279] & 65535u));
        float _358 = _357.x;
        float2 _359 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_279] >> 16u));
        float _360 = _359.x;
        float2 _364 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_279] & 65535u));
        float _365 = _364.x;
        float2 _366 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_279] >> 16u));
        float _367 = _366.x;
        int _369 = _279 - 1;
        int _402 = _278 - 1;
        int _409 = _278 + 2;
        uint4 _419 = uint4(_114[0] * 255.5);
        float4 _426 = float4(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.InvSharpness);
        float4 _428 = fast::clamp((float4((_419 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _434 = fast::clamp((float4((_419 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _440 = fast::clamp((float4((_419 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _445 = fast::clamp((float4(_419 & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _458 = (((((float4(_358, _360, _365, _367) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_402][_279] >> 16u)).x, _358, _360, _365) * _428)) + (float4(_360, _365, _367, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_409][_279] & 65535u)).x) * _434)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_369] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_369] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_369] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_369] >> 16u)).x) * _440)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_305] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_305] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_305] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_305] >> 16u)).x) * _445)) / ((((float4(0.5) + _428) + _434) + _440) + _445);
        s_FFX_CACAO_BlurF16Back_4[_278][_279] = as_type<uint>(half2(float2(_458.x, 0.0))) | (as_type<uint>(half2(float2(_458.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_289][_279] = as_type<uint>(half2(float2(_458.z, 0.0))) | (as_type<uint>(half2(float2(_458.w, 0.0))) << 16u);
        int2 _477 = _134 + int2(1, 2);
        int _478 = _477.x;
        int _479 = _477.y;
        float2 _484 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_478][_479] & 65535u));
        float _485 = _484.x;
        float2 _486 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_478][_479] >> 16u));
        float _487 = _486.x;
        int _488 = _478 + 1;
        float2 _493 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_488][_479] & 65535u));
        float _494 = _493.x;
        float2 _495 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_488][_479] >> 16u));
        float _496 = _495.x;
        int _498 = _479 - 1;
        int _516 = _479 + 1;
        int _534 = _478 - 1;
        int _541 = _478 + 2;
        uint4 _551 = uint4(_114[1] * 255.5);
        float4 _557 = fast::clamp((float4((_551 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _563 = fast::clamp((float4((_551 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _569 = fast::clamp((float4((_551 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _574 = fast::clamp((float4(_551 & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _587 = (((((float4(_485, _487, _494, _496) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_534][_479] >> 16u)).x, _485, _487, _494) * _557)) + (float4(_487, _494, _496, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_541][_479] & 65535u)).x) * _563)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_478][_498] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_478][_498] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_488][_498] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_488][_498] >> 16u)).x) * _569)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_478][_516] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_478][_516] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_488][_516] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_488][_516] >> 16u)).x) * _574)) / ((((float4(0.5) + _557) + _563) + _569) + _574);
        s_FFX_CACAO_BlurF16Back_4[_478][_479] = as_type<uint>(half2(float2(_587.x, 0.0))) | (as_type<uint>(half2(float2(_587.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_488][_479] = as_type<uint>(half2(float2(_587.z, 0.0))) | (as_type<uint>(half2(float2(_587.w, 0.0))) << 16u);
        int2 _606 = _134 + int2(1, 3);
        int _607 = _606.x;
        int _608 = _606.y;
        float2 _613 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_607][_608] & 65535u));
        float _614 = _613.x;
        float2 _615 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_607][_608] >> 16u));
        float _616 = _615.x;
        int _617 = _607 + 1;
        float2 _622 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_617][_608] & 65535u));
        float _623 = _622.x;
        float2 _624 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_617][_608] >> 16u));
        float _625 = _624.x;
        int _627 = _608 - 1;
        int _645 = _608 + 1;
        int _663 = _607 - 1;
        int _670 = _607 + 2;
        uint4 _680 = uint4(_114[2] * 255.5);
        float4 _686 = fast::clamp((float4((_680 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _692 = fast::clamp((float4((_680 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _698 = fast::clamp((float4((_680 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _703 = fast::clamp((float4(_680 & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
        float4 _716 = (((((float4(_614, _616, _623, _625) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_663][_608] >> 16u)).x, _614, _616, _623) * _686)) + (float4(_616, _623, _625, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_670][_608] & 65535u)).x) * _692)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_607][_627] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_607][_627] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_617][_627] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_617][_627] >> 16u)).x) * _698)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_607][_645] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_607][_645] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_617][_645] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_617][_645] >> 16u)).x) * _703)) / ((((float4(0.5) + _686) + _692) + _698) + _703);
        s_FFX_CACAO_BlurF16Back_4[_607][_608] = as_type<uint>(half2(float2(_716.x, 0.0))) | (as_type<uint>(half2(float2(_716.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_617][_608] = as_type<uint>(half2(float2(_716.z, 0.0))) | (as_type<uint>(half2(float2(_716.w, 0.0))) << 16u);
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (((2u * _348) + 1u) < 6u)
        {
            float2 _743 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_279] & 65535u));
            float _744 = _743.x;
            float2 _745 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_279] >> 16u));
            float _746 = _745.x;
            float2 _750 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_279] & 65535u));
            float _751 = _750.x;
            float2 _752 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_279] >> 16u));
            float _753 = _752.x;
            uint4 _804 = uint4(_114[0] * 255.5);
            float4 _810 = fast::clamp((float4((_804 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _816 = fast::clamp((float4((_804 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _822 = fast::clamp((float4((_804 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _827 = fast::clamp((float4(_804 & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _840 = (((((float4(_744, _746, _751, _753) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_402][_279] >> 16u)).x, _744, _746, _751) * _810)) + (float4(_746, _751, _753, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_409][_279] & 65535u)).x) * _816)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_369] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_369] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_369] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_369] >> 16u)).x) * _822)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_305] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_278][_305] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_305] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_289][_305] >> 16u)).x) * _827)) / ((((float4(0.5) + _810) + _816) + _822) + _827);
            s_FFX_CACAO_BlurF16Front_4[_278][_279] = as_type<uint>(half2(float2(_840.x, 0.0))) | (as_type<uint>(half2(float2(_840.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_289][_279] = as_type<uint>(half2(float2(_840.z, 0.0))) | (as_type<uint>(half2(float2(_840.w, 0.0))) << 16u);
            float2 _860 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_478][_479] & 65535u));
            float _861 = _860.x;
            float2 _862 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_478][_479] >> 16u));
            float _863 = _862.x;
            float2 _867 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_488][_479] & 65535u));
            float _868 = _867.x;
            float2 _869 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_488][_479] >> 16u));
            float _870 = _869.x;
            uint4 _921 = uint4(_114[1] * 255.5);
            float4 _927 = fast::clamp((float4((_921 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _933 = fast::clamp((float4((_921 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _939 = fast::clamp((float4((_921 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _944 = fast::clamp((float4(_921 & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _957 = (((((float4(_861, _863, _868, _870) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_534][_479] >> 16u)).x, _861, _863, _868) * _927)) + (float4(_863, _868, _870, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_541][_479] & 65535u)).x) * _933)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_478][_498] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_478][_498] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_488][_498] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_488][_498] >> 16u)).x) * _939)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_478][_516] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_478][_516] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_488][_516] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_488][_516] >> 16u)).x) * _944)) / ((((float4(0.5) + _927) + _933) + _939) + _944);
            s_FFX_CACAO_BlurF16Front_4[_478][_479] = as_type<uint>(half2(float2(_957.x, 0.0))) | (as_type<uint>(half2(float2(_957.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_488][_479] = as_type<uint>(half2(float2(_957.z, 0.0))) | (as_type<uint>(half2(float2(_957.w, 0.0))) << 16u);
            float2 _977 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_607][_608] & 65535u));
            float _978 = _977.x;
            float2 _979 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_607][_608] >> 16u));
            float _980 = _979.x;
            float2 _984 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_617][_608] & 65535u));
            float _985 = _984.x;
            float2 _986 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_617][_608] >> 16u));
            float _987 = _986.x;
            uint4 _1038 = uint4(_114[2] * 255.5);
            float4 _1044 = fast::clamp((float4((_1038 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _1050 = fast::clamp((float4((_1038 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _1056 = fast::clamp((float4((_1038 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _1061 = fast::clamp((float4(_1038 & uint4(3u)) * float4(0.3333333432674407958984375)) + _426, float4(0.0), float4(1.0));
            float4 _1074 = (((((float4(_978, _980, _985, _987) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_663][_608] >> 16u)).x, _978, _980, _985) * _1044)) + (float4(_980, _985, _987, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_670][_608] & 65535u)).x) * _1050)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_607][_627] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_607][_627] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_617][_627] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_617][_627] >> 16u)).x) * _1056)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_607][_645] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_607][_645] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_617][_645] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_617][_645] >> 16u)).x) * _1061)) / ((((float4(0.5) + _1044) + _1050) + _1056) + _1061);
            s_FFX_CACAO_BlurF16Front_4[_607][_608] = as_type<uint>(half2(float2(_1074.x, 0.0))) | (as_type<uint>(half2(float2(_1074.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_617][_608] = as_type<uint>(half2(float2(_1074.z, 0.0))) | (as_type<uint>(half2(float2(_1074.w, 0.0))) << 16u);
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
    }
    for (uint _1092 = 0u; _1092 < 3u; _1092++)
    {
        uint _1100 = (3u * gl_LocalInvocationID.y) + _1092;
        bool _1105;
        if (6u <= _1100)
        {
            _1105 = _1100 < 42u;
        }
        else
        {
            _1105 = false;
        }
        if (_1105)
        {
            uint _1109 = 4u * gl_LocalInvocationID.x;
            uint _1111 = uint(_279) + _1092;
            bool _1132;
            if (6u <= _1109)
            {
                _1132 = _1109 < 58u;
            }
            else
            {
                _1132 = false;
            }
            if (_1132)
            {
                uint2 _1138 = uint2(_133 + int2(0, int(_1092)));
                uint3 _1148 = uint3(int3(int(_1138.x), int(_1138.y), int(_126)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_1111] & 65535u)).x, _114[_1092].x).xyyy, uint2(_1148.xy), uint(_1148.z));
            }
            uint _1150 = _1109 + 1u;
            bool _1155;
            if (6u <= _1150)
            {
                _1155 = _1150 < 58u;
            }
            else
            {
                _1155 = false;
            }
            if (_1155)
            {
                uint2 _1161 = uint2(_133 + int2(1, int(_1092)));
                uint3 _1171 = uint3(int3(int(_1161.x), int(_1161.y), int(_126)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_278][_1111] >> 16u)).x, _114[_1092].y).xyyy, uint2(_1171.xy), uint(_1171.z));
            }
            uint _1173 = _1109 + 2u;
            bool _1178;
            if (6u <= _1173)
            {
                _1178 = _1173 < 58u;
            }
            else
            {
                _1178 = false;
            }
            if (_1178)
            {
                uint2 _1184 = uint2(_133 + int2(2, int(_1092)));
                uint3 _1194 = uint3(int3(int(_1184.x), int(_1184.y), int(_126)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_1111] & 65535u)).x, _114[_1092].z).xyyy, uint2(_1194.xy), uint(_1194.z));
            }
            uint _1196 = _1109 + 3u;
            bool _1201;
            if (6u <= _1196)
            {
                _1201 = _1196 < 58u;
            }
            else
            {
                _1201 = false;
            }
            if (_1201)
            {
                uint2 _1207 = uint2(_133 + int2(3, int(_1092)));
                uint3 _1217 = uint3(int3(int(_1207.x), int(_1207.y), int(_126)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_289][_1111] >> 16u)).x, _114[_1092].w).xyyy, uint2(_1217.xy), uint(_1217.z));
            }
        }
    }
}

)CACAO_GPU";
inline constexpr Binding bindings22[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_SsaoBufferPing","texture",0},{"g_RwSsaoBufferPong","texture",1},{"g_PointMirrorSampler","sampler",0}};
inline constexpr const char*source22=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d_array<float> g_SsaoBufferPing [[texture(0)]], texture2d_array<float, access::write> g_RwSsaoBufferPong [[texture(1)]], sampler g_PointMirrorSampler [[sampler(0)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Front_4;
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Back_4;
    bool _126;
    if (gl_WorkGroupID.z == 1u)
    {
        _126 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BlurNumPasses == 2;
    }
    else
    {
        _126 = false;
    }
    uint _127 = _126 ? 3u : gl_WorkGroupID.z;
    int2 _131 = int2(gl_LocalInvocationID.xy);
    int2 _133 = (int2(gl_WorkGroupID.xy) * int2(50, 34)) + (int2(4, 3) * _131);
    int2 _134 = _133 - int2(7);
    int2 _135 = int2(2, 3) * _131;
    int2 _136 = _135 + int2(1);
    float _144 = float(_127);
    float3 _147 = float3((float2(_134) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _149 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _147.xy, uint(rint(_147.z)), level(0.0));
    float3 _158 = float3((float2(_133 + int2(-6, -7)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _160 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _158.xy, uint(rint(_158.z)), level(0.0));
    float3 _169 = float3((float2(_133 + int2(-5, -7)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _171 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _169.xy, uint(rint(_169.z)), level(0.0));
    float3 _180 = float3((float2(_133 + int2(-4, -7)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _182 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _180.xy, uint(rint(_180.z)), level(0.0));
    float3 _191 = float3((float2(_133 + int2(-7, -6)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _193 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _191.xy, uint(rint(_191.z)), level(0.0));
    float3 _202 = float3((float2(_133 + int2(-6)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _204 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _202.xy, uint(rint(_202.z)), level(0.0));
    float3 _213 = float3((float2(_133 + int2(-5, -6)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _215 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _213.xy, uint(rint(_213.z)), level(0.0));
    float3 _224 = float3((float2(_133 + int2(-4, -6)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _226 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _224.xy, uint(rint(_224.z)), level(0.0));
    float3 _235 = float3((float2(_133 + int2(-7, -5)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _237 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _235.xy, uint(rint(_235.z)), level(0.0));
    float3 _246 = float3((float2(_133 + int2(-6, -5)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _248 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _246.xy, uint(rint(_246.z)), level(0.0));
    float3 _257 = float3((float2(_133 + int2(-5)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _259 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _257.xy, uint(rint(_257.z)), level(0.0));
    float3 _268 = float3((float2(_133 + int2(-4, -5)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _270 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _268.xy, uint(rint(_268.z)), level(0.0));
    int _279 = _136.x;
    int _280 = _136.y;
    s_FFX_CACAO_BlurF16Front_4[_279][_280] = as_type<uint>(half2(float2(_149.x, 0.0))) | (as_type<uint>(half2(float2(_160.x, 0.0))) << 16u);
    int _290 = _279 + 1;
    s_FFX_CACAO_BlurF16Front_4[_290][_280] = as_type<uint>(half2(float2(_171.x, 0.0))) | (as_type<uint>(half2(float2(_182.x, 0.0))) << 16u);
    spvUnsafeArray<float4, 3> _115;
    _115[0] = float4(_149.y, _160.y, _171.y, _182.y);
    int _306 = _280 + 1;
    s_FFX_CACAO_BlurF16Front_4[_279][_306] = as_type<uint>(half2(float2(_193.x, 0.0))) | (as_type<uint>(half2(float2(_204.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_290][_306] = as_type<uint>(half2(float2(_215.x, 0.0))) | (as_type<uint>(half2(float2(_226.x, 0.0))) << 16u);
    _115[1] = float4(_193.y, _204.y, _215.y, _226.y);
    int _331 = _280 + 2;
    s_FFX_CACAO_BlurF16Front_4[_279][_331] = as_type<uint>(half2(float2(_237.x, 0.0))) | (as_type<uint>(half2(float2(_248.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_290][_331] = as_type<uint>(half2(float2(_259.x, 0.0))) | (as_type<uint>(half2(float2(_270.x, 0.0))) << 16u);
    _115[2] = float4(_237.y, _248.y, _259.y, _270.y);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint _349 = 0u; _349 < 4u; _349++)
    {
        float2 _358 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_280] & 65535u));
        float _359 = _358.x;
        float2 _360 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_280] >> 16u));
        float _361 = _360.x;
        float2 _365 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_280] & 65535u));
        float _366 = _365.x;
        float2 _367 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_280] >> 16u));
        float _368 = _367.x;
        int _370 = _280 - 1;
        int _403 = _279 - 1;
        int _410 = _279 + 2;
        uint4 _420 = uint4(_115[0] * 255.5);
        float4 _427 = float4(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.InvSharpness);
        float4 _429 = fast::clamp((float4((_420 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _435 = fast::clamp((float4((_420 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _441 = fast::clamp((float4((_420 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _446 = fast::clamp((float4(_420 & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _459 = (((((float4(_359, _361, _366, _368) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_403][_280] >> 16u)).x, _359, _361, _366) * _429)) + (float4(_361, _366, _368, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_410][_280] & 65535u)).x) * _435)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_370] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_370] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_370] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_370] >> 16u)).x) * _441)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_306] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_306] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_306] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_306] >> 16u)).x) * _446)) / ((((float4(0.5) + _429) + _435) + _441) + _446);
        s_FFX_CACAO_BlurF16Back_4[_279][_280] = as_type<uint>(half2(float2(_459.x, 0.0))) | (as_type<uint>(half2(float2(_459.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_290][_280] = as_type<uint>(half2(float2(_459.z, 0.0))) | (as_type<uint>(half2(float2(_459.w, 0.0))) << 16u);
        int2 _478 = _135 + int2(1, 2);
        int _479 = _478.x;
        int _480 = _478.y;
        float2 _485 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_479][_480] & 65535u));
        float _486 = _485.x;
        float2 _487 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_479][_480] >> 16u));
        float _488 = _487.x;
        int _489 = _479 + 1;
        float2 _494 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_489][_480] & 65535u));
        float _495 = _494.x;
        float2 _496 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_489][_480] >> 16u));
        float _497 = _496.x;
        int _499 = _480 - 1;
        int _517 = _480 + 1;
        int _535 = _479 - 1;
        int _542 = _479 + 2;
        uint4 _552 = uint4(_115[1] * 255.5);
        float4 _558 = fast::clamp((float4((_552 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _564 = fast::clamp((float4((_552 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _570 = fast::clamp((float4((_552 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _575 = fast::clamp((float4(_552 & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _588 = (((((float4(_486, _488, _495, _497) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_535][_480] >> 16u)).x, _486, _488, _495) * _558)) + (float4(_488, _495, _497, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_542][_480] & 65535u)).x) * _564)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_479][_499] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_479][_499] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_489][_499] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_489][_499] >> 16u)).x) * _570)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_479][_517] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_479][_517] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_489][_517] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_489][_517] >> 16u)).x) * _575)) / ((((float4(0.5) + _558) + _564) + _570) + _575);
        s_FFX_CACAO_BlurF16Back_4[_479][_480] = as_type<uint>(half2(float2(_588.x, 0.0))) | (as_type<uint>(half2(float2(_588.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_489][_480] = as_type<uint>(half2(float2(_588.z, 0.0))) | (as_type<uint>(half2(float2(_588.w, 0.0))) << 16u);
        int2 _607 = _135 + int2(1, 3);
        int _608 = _607.x;
        int _609 = _607.y;
        float2 _614 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_608][_609] & 65535u));
        float _615 = _614.x;
        float2 _616 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_608][_609] >> 16u));
        float _617 = _616.x;
        int _618 = _608 + 1;
        float2 _623 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_618][_609] & 65535u));
        float _624 = _623.x;
        float2 _625 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_618][_609] >> 16u));
        float _626 = _625.x;
        int _628 = _609 - 1;
        int _646 = _609 + 1;
        int _664 = _608 - 1;
        int _671 = _608 + 2;
        uint4 _681 = uint4(_115[2] * 255.5);
        float4 _687 = fast::clamp((float4((_681 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _693 = fast::clamp((float4((_681 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _699 = fast::clamp((float4((_681 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _704 = fast::clamp((float4(_681 & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _717 = (((((float4(_615, _617, _624, _626) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_664][_609] >> 16u)).x, _615, _617, _624) * _687)) + (float4(_617, _624, _626, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_671][_609] & 65535u)).x) * _693)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_608][_628] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_608][_628] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_618][_628] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_618][_628] >> 16u)).x) * _699)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_608][_646] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_608][_646] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_618][_646] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_618][_646] >> 16u)).x) * _704)) / ((((float4(0.5) + _687) + _693) + _699) + _704);
        s_FFX_CACAO_BlurF16Back_4[_608][_609] = as_type<uint>(half2(float2(_717.x, 0.0))) | (as_type<uint>(half2(float2(_717.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_618][_609] = as_type<uint>(half2(float2(_717.z, 0.0))) | (as_type<uint>(half2(float2(_717.w, 0.0))) << 16u);
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (((2u * _349) + 1u) < 7u)
        {
            float2 _744 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_280] & 65535u));
            float _745 = _744.x;
            float2 _746 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_280] >> 16u));
            float _747 = _746.x;
            float2 _751 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_280] & 65535u));
            float _752 = _751.x;
            float2 _753 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_280] >> 16u));
            float _754 = _753.x;
            uint4 _805 = uint4(_115[0] * 255.5);
            float4 _811 = fast::clamp((float4((_805 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _817 = fast::clamp((float4((_805 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _823 = fast::clamp((float4((_805 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _828 = fast::clamp((float4(_805 & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _841 = (((((float4(_745, _747, _752, _754) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_403][_280] >> 16u)).x, _745, _747, _752) * _811)) + (float4(_747, _752, _754, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_410][_280] & 65535u)).x) * _817)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_370] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_370] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_370] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_370] >> 16u)).x) * _823)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_306] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_306] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_306] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_306] >> 16u)).x) * _828)) / ((((float4(0.5) + _811) + _817) + _823) + _828);
            s_FFX_CACAO_BlurF16Front_4[_279][_280] = as_type<uint>(half2(float2(_841.x, 0.0))) | (as_type<uint>(half2(float2(_841.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_290][_280] = as_type<uint>(half2(float2(_841.z, 0.0))) | (as_type<uint>(half2(float2(_841.w, 0.0))) << 16u);
            float2 _861 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_479][_480] & 65535u));
            float _862 = _861.x;
            float2 _863 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_479][_480] >> 16u));
            float _864 = _863.x;
            float2 _868 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_489][_480] & 65535u));
            float _869 = _868.x;
            float2 _870 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_489][_480] >> 16u));
            float _871 = _870.x;
            uint4 _922 = uint4(_115[1] * 255.5);
            float4 _928 = fast::clamp((float4((_922 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _934 = fast::clamp((float4((_922 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _940 = fast::clamp((float4((_922 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _945 = fast::clamp((float4(_922 & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _958 = (((((float4(_862, _864, _869, _871) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_535][_480] >> 16u)).x, _862, _864, _869) * _928)) + (float4(_864, _869, _871, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_542][_480] & 65535u)).x) * _934)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_479][_499] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_479][_499] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_489][_499] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_489][_499] >> 16u)).x) * _940)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_479][_517] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_479][_517] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_489][_517] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_489][_517] >> 16u)).x) * _945)) / ((((float4(0.5) + _928) + _934) + _940) + _945);
            s_FFX_CACAO_BlurF16Front_4[_479][_480] = as_type<uint>(half2(float2(_958.x, 0.0))) | (as_type<uint>(half2(float2(_958.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_489][_480] = as_type<uint>(half2(float2(_958.z, 0.0))) | (as_type<uint>(half2(float2(_958.w, 0.0))) << 16u);
            float2 _978 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_608][_609] & 65535u));
            float _979 = _978.x;
            float2 _980 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_608][_609] >> 16u));
            float _981 = _980.x;
            float2 _985 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_618][_609] & 65535u));
            float _986 = _985.x;
            float2 _987 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_618][_609] >> 16u));
            float _988 = _987.x;
            uint4 _1039 = uint4(_115[2] * 255.5);
            float4 _1045 = fast::clamp((float4((_1039 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _1051 = fast::clamp((float4((_1039 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _1057 = fast::clamp((float4((_1039 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _1062 = fast::clamp((float4(_1039 & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _1075 = (((((float4(_979, _981, _986, _988) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_664][_609] >> 16u)).x, _979, _981, _986) * _1045)) + (float4(_981, _986, _988, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_671][_609] & 65535u)).x) * _1051)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_608][_628] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_608][_628] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_618][_628] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_618][_628] >> 16u)).x) * _1057)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_608][_646] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_608][_646] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_618][_646] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_618][_646] >> 16u)).x) * _1062)) / ((((float4(0.5) + _1045) + _1051) + _1057) + _1062);
            s_FFX_CACAO_BlurF16Front_4[_608][_609] = as_type<uint>(half2(float2(_1075.x, 0.0))) | (as_type<uint>(half2(float2(_1075.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_618][_609] = as_type<uint>(half2(float2(_1075.z, 0.0))) | (as_type<uint>(half2(float2(_1075.w, 0.0))) << 16u);
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
    }
    for (uint _1093 = 0u; _1093 < 3u; _1093++)
    {
        uint _1101 = (3u * gl_LocalInvocationID.y) + _1093;
        bool _1106;
        if (7u <= _1101)
        {
            _1106 = _1101 < 41u;
        }
        else
        {
            _1106 = false;
        }
        if (_1106)
        {
            uint _1110 = 4u * gl_LocalInvocationID.x;
            uint _1112 = uint(_280) + _1093;
            bool _1133;
            if (7u <= _1110)
            {
                _1133 = _1110 < 57u;
            }
            else
            {
                _1133 = false;
            }
            if (_1133)
            {
                uint2 _1139 = uint2(_134 + int2(0, int(_1093)));
                uint3 _1149 = uint3(int3(int(_1139.x), int(_1139.y), int(_127)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_1112] & 65535u)).x, _115[_1093].x).xyyy, uint2(_1149.xy), uint(_1149.z));
            }
            uint _1151 = _1110 + 1u;
            bool _1156;
            if (7u <= _1151)
            {
                _1156 = _1151 < 57u;
            }
            else
            {
                _1156 = false;
            }
            if (_1156)
            {
                uint2 _1162 = uint2(_134 + int2(1, int(_1093)));
                uint3 _1172 = uint3(int3(int(_1162.x), int(_1162.y), int(_127)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_1112] >> 16u)).x, _115[_1093].y).xyyy, uint2(_1172.xy), uint(_1172.z));
            }
            uint _1174 = _1110 + 2u;
            bool _1179;
            if (7u <= _1174)
            {
                _1179 = _1174 < 57u;
            }
            else
            {
                _1179 = false;
            }
            if (_1179)
            {
                uint2 _1185 = uint2(_134 + int2(2, int(_1093)));
                uint3 _1195 = uint3(int3(int(_1185.x), int(_1185.y), int(_127)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_1112] & 65535u)).x, _115[_1093].z).xyyy, uint2(_1195.xy), uint(_1195.z));
            }
            uint _1197 = _1110 + 3u;
            bool _1202;
            if (7u <= _1197)
            {
                _1202 = _1197 < 57u;
            }
            else
            {
                _1202 = false;
            }
            if (_1202)
            {
                uint2 _1208 = uint2(_134 + int2(3, int(_1093)));
                uint3 _1218 = uint3(int3(int(_1208.x), int(_1208.y), int(_127)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_1112] >> 16u)).x, _115[_1093].w).xyyy, uint2(_1218.xy), uint(_1218.z));
            }
        }
    }
}

)CACAO_GPU";
inline constexpr Binding bindings23[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_SsaoBufferPing","texture",0},{"g_RwSsaoBufferPong","texture",1},{"g_PointMirrorSampler","sampler",0}};
inline constexpr const char*source23=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d_array<float> g_SsaoBufferPing [[texture(0)]], texture2d_array<float, access::write> g_RwSsaoBufferPong [[texture(1)]], sampler g_PointMirrorSampler [[sampler(0)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Front_4;
    threadgroup spvUnsafeArray<spvUnsafeArray<uint, 50>, 34> s_FFX_CACAO_BlurF16Back_4;
    bool _126;
    if (gl_WorkGroupID.z == 1u)
    {
        _126 = SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BlurNumPasses == 2;
    }
    else
    {
        _126 = false;
    }
    uint _127 = _126 ? 3u : gl_WorkGroupID.z;
    int2 _131 = int2(gl_LocalInvocationID.xy);
    int2 _133 = (int2(gl_WorkGroupID.xy) * int2(48, 32)) + (int2(4, 3) * _131);
    int2 _134 = _133 - int2(8);
    int2 _135 = int2(2, 3) * _131;
    int2 _136 = _135 + int2(1);
    float _144 = float(_127);
    float3 _147 = float3((float2(_134) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _149 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _147.xy, uint(rint(_147.z)), level(0.0));
    float3 _158 = float3((float2(_133 + int2(-7, -8)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _160 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _158.xy, uint(rint(_158.z)), level(0.0));
    float3 _169 = float3((float2(_133 + int2(-6, -8)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _171 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _169.xy, uint(rint(_169.z)), level(0.0));
    float3 _180 = float3((float2(_133 + int2(-5, -8)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _182 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _180.xy, uint(rint(_180.z)), level(0.0));
    float3 _191 = float3((float2(_133 + int2(-8, -7)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _193 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _191.xy, uint(rint(_191.z)), level(0.0));
    float3 _202 = float3((float2(_133 + int2(-7)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _204 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _202.xy, uint(rint(_202.z)), level(0.0));
    float3 _213 = float3((float2(_133 + int2(-6, -7)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _215 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _213.xy, uint(rint(_213.z)), level(0.0));
    float3 _224 = float3((float2(_133 + int2(-5, -7)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _226 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _224.xy, uint(rint(_224.z)), level(0.0));
    float3 _235 = float3((float2(_133 + int2(-8, -6)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _237 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _235.xy, uint(rint(_235.z)), level(0.0));
    float3 _246 = float3((float2(_133 + int2(-7, -6)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _248 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _246.xy, uint(rint(_246.z)), level(0.0));
    float3 _257 = float3((float2(_133 + int2(-6)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _259 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _257.xy, uint(rint(_257.z)), level(0.0));
    float3 _268 = float3((float2(_133 + int2(-5, -6)) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, _144);
    float4 _270 = g_SsaoBufferPing.sample(g_PointMirrorSampler, _268.xy, uint(rint(_268.z)), level(0.0));
    int _279 = _136.x;
    int _280 = _136.y;
    s_FFX_CACAO_BlurF16Front_4[_279][_280] = as_type<uint>(half2(float2(_149.x, 0.0))) | (as_type<uint>(half2(float2(_160.x, 0.0))) << 16u);
    int _290 = _279 + 1;
    s_FFX_CACAO_BlurF16Front_4[_290][_280] = as_type<uint>(half2(float2(_171.x, 0.0))) | (as_type<uint>(half2(float2(_182.x, 0.0))) << 16u);
    spvUnsafeArray<float4, 3> _115;
    _115[0] = float4(_149.y, _160.y, _171.y, _182.y);
    int _306 = _280 + 1;
    s_FFX_CACAO_BlurF16Front_4[_279][_306] = as_type<uint>(half2(float2(_193.x, 0.0))) | (as_type<uint>(half2(float2(_204.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_290][_306] = as_type<uint>(half2(float2(_215.x, 0.0))) | (as_type<uint>(half2(float2(_226.x, 0.0))) << 16u);
    _115[1] = float4(_193.y, _204.y, _215.y, _226.y);
    int _331 = _280 + 2;
    s_FFX_CACAO_BlurF16Front_4[_279][_331] = as_type<uint>(half2(float2(_237.x, 0.0))) | (as_type<uint>(half2(float2(_248.x, 0.0))) << 16u);
    s_FFX_CACAO_BlurF16Front_4[_290][_331] = as_type<uint>(half2(float2(_259.x, 0.0))) | (as_type<uint>(half2(float2(_270.x, 0.0))) << 16u);
    _115[2] = float4(_237.y, _248.y, _259.y, _270.y);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (uint _349 = 0u; _349 < 4u; _349++)
    {
        float2 _358 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_280] & 65535u));
        float _359 = _358.x;
        float2 _360 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_280] >> 16u));
        float _361 = _360.x;
        float2 _365 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_280] & 65535u));
        float _366 = _365.x;
        float2 _367 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_280] >> 16u));
        float _368 = _367.x;
        int _370 = _280 - 1;
        int _403 = _279 - 1;
        int _410 = _279 + 2;
        uint4 _420 = uint4(_115[0] * 255.5);
        float4 _427 = float4(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.InvSharpness);
        float4 _429 = fast::clamp((float4((_420 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _435 = fast::clamp((float4((_420 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _441 = fast::clamp((float4((_420 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _446 = fast::clamp((float4(_420 & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _459 = (((((float4(_359, _361, _366, _368) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_403][_280] >> 16u)).x, _359, _361, _366) * _429)) + (float4(_361, _366, _368, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_410][_280] & 65535u)).x) * _435)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_370] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_370] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_370] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_370] >> 16u)).x) * _441)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_306] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_306] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_306] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_306] >> 16u)).x) * _446)) / ((((float4(0.5) + _429) + _435) + _441) + _446);
        s_FFX_CACAO_BlurF16Back_4[_279][_280] = as_type<uint>(half2(float2(_459.x, 0.0))) | (as_type<uint>(half2(float2(_459.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_290][_280] = as_type<uint>(half2(float2(_459.z, 0.0))) | (as_type<uint>(half2(float2(_459.w, 0.0))) << 16u);
        int2 _478 = _135 + int2(1, 2);
        int _479 = _478.x;
        int _480 = _478.y;
        float2 _485 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_479][_480] & 65535u));
        float _486 = _485.x;
        float2 _487 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_479][_480] >> 16u));
        float _488 = _487.x;
        int _489 = _479 + 1;
        float2 _494 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_489][_480] & 65535u));
        float _495 = _494.x;
        float2 _496 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_489][_480] >> 16u));
        float _497 = _496.x;
        int _499 = _480 - 1;
        int _517 = _480 + 1;
        int _535 = _479 - 1;
        int _542 = _479 + 2;
        uint4 _552 = uint4(_115[1] * 255.5);
        float4 _558 = fast::clamp((float4((_552 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _564 = fast::clamp((float4((_552 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _570 = fast::clamp((float4((_552 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _575 = fast::clamp((float4(_552 & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _588 = (((((float4(_486, _488, _495, _497) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_535][_480] >> 16u)).x, _486, _488, _495) * _558)) + (float4(_488, _495, _497, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_542][_480] & 65535u)).x) * _564)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_479][_499] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_479][_499] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_489][_499] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_489][_499] >> 16u)).x) * _570)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_479][_517] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_479][_517] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_489][_517] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_489][_517] >> 16u)).x) * _575)) / ((((float4(0.5) + _558) + _564) + _570) + _575);
        s_FFX_CACAO_BlurF16Back_4[_479][_480] = as_type<uint>(half2(float2(_588.x, 0.0))) | (as_type<uint>(half2(float2(_588.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_489][_480] = as_type<uint>(half2(float2(_588.z, 0.0))) | (as_type<uint>(half2(float2(_588.w, 0.0))) << 16u);
        int2 _607 = _135 + int2(1, 3);
        int _608 = _607.x;
        int _609 = _607.y;
        float2 _614 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_608][_609] & 65535u));
        float _615 = _614.x;
        float2 _616 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_608][_609] >> 16u));
        float _617 = _616.x;
        int _618 = _608 + 1;
        float2 _623 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_618][_609] & 65535u));
        float _624 = _623.x;
        float2 _625 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_618][_609] >> 16u));
        float _626 = _625.x;
        int _628 = _609 - 1;
        int _646 = _609 + 1;
        int _664 = _608 - 1;
        int _671 = _608 + 2;
        uint4 _681 = uint4(_115[2] * 255.5);
        float4 _687 = fast::clamp((float4((_681 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _693 = fast::clamp((float4((_681 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _699 = fast::clamp((float4((_681 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _704 = fast::clamp((float4(_681 & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
        float4 _717 = (((((float4(_615, _617, _624, _626) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_664][_609] >> 16u)).x, _615, _617, _624) * _687)) + (float4(_617, _624, _626, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_671][_609] & 65535u)).x) * _693)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_608][_628] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_608][_628] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_618][_628] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_618][_628] >> 16u)).x) * _699)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_608][_646] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_608][_646] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_618][_646] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_618][_646] >> 16u)).x) * _704)) / ((((float4(0.5) + _687) + _693) + _699) + _704);
        s_FFX_CACAO_BlurF16Back_4[_608][_609] = as_type<uint>(half2(float2(_717.x, 0.0))) | (as_type<uint>(half2(float2(_717.y, 0.0))) << 16u);
        s_FFX_CACAO_BlurF16Back_4[_618][_609] = as_type<uint>(half2(float2(_717.z, 0.0))) | (as_type<uint>(half2(float2(_717.w, 0.0))) << 16u);
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (((2u * _349) + 1u) < 8u)
        {
            float2 _744 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_280] & 65535u));
            float _745 = _744.x;
            float2 _746 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_280] >> 16u));
            float _747 = _746.x;
            float2 _751 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_280] & 65535u));
            float _752 = _751.x;
            float2 _753 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_280] >> 16u));
            float _754 = _753.x;
            uint4 _805 = uint4(_115[0] * 255.5);
            float4 _811 = fast::clamp((float4((_805 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _817 = fast::clamp((float4((_805 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _823 = fast::clamp((float4((_805 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _828 = fast::clamp((float4(_805 & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _841 = (((((float4(_745, _747, _752, _754) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_403][_280] >> 16u)).x, _745, _747, _752) * _811)) + (float4(_747, _752, _754, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_410][_280] & 65535u)).x) * _817)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_370] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_370] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_370] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_370] >> 16u)).x) * _823)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_306] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_279][_306] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_306] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_290][_306] >> 16u)).x) * _828)) / ((((float4(0.5) + _811) + _817) + _823) + _828);
            s_FFX_CACAO_BlurF16Front_4[_279][_280] = as_type<uint>(half2(float2(_841.x, 0.0))) | (as_type<uint>(half2(float2(_841.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_290][_280] = as_type<uint>(half2(float2(_841.z, 0.0))) | (as_type<uint>(half2(float2(_841.w, 0.0))) << 16u);
            float2 _861 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_479][_480] & 65535u));
            float _862 = _861.x;
            float2 _863 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_479][_480] >> 16u));
            float _864 = _863.x;
            float2 _868 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_489][_480] & 65535u));
            float _869 = _868.x;
            float2 _870 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_489][_480] >> 16u));
            float _871 = _870.x;
            uint4 _922 = uint4(_115[1] * 255.5);
            float4 _928 = fast::clamp((float4((_922 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _934 = fast::clamp((float4((_922 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _940 = fast::clamp((float4((_922 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _945 = fast::clamp((float4(_922 & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _958 = (((((float4(_862, _864, _869, _871) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_535][_480] >> 16u)).x, _862, _864, _869) * _928)) + (float4(_864, _869, _871, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_542][_480] & 65535u)).x) * _934)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_479][_499] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_479][_499] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_489][_499] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_489][_499] >> 16u)).x) * _940)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_479][_517] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_479][_517] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_489][_517] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_489][_517] >> 16u)).x) * _945)) / ((((float4(0.5) + _928) + _934) + _940) + _945);
            s_FFX_CACAO_BlurF16Front_4[_479][_480] = as_type<uint>(half2(float2(_958.x, 0.0))) | (as_type<uint>(half2(float2(_958.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_489][_480] = as_type<uint>(half2(float2(_958.z, 0.0))) | (as_type<uint>(half2(float2(_958.w, 0.0))) << 16u);
            float2 _978 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_608][_609] & 65535u));
            float _979 = _978.x;
            float2 _980 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_608][_609] >> 16u));
            float _981 = _980.x;
            float2 _985 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_618][_609] & 65535u));
            float _986 = _985.x;
            float2 _987 = float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_618][_609] >> 16u));
            float _988 = _987.x;
            uint4 _1039 = uint4(_115[2] * 255.5);
            float4 _1045 = fast::clamp((float4((_1039 >> uint4(6u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _1051 = fast::clamp((float4((_1039 >> uint4(4u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _1057 = fast::clamp((float4((_1039 >> uint4(2u)) & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _1062 = fast::clamp((float4(_1039 & uint4(3u)) * float4(0.3333333432674407958984375)) + _427, float4(0.0), float4(1.0));
            float4 _1075 = (((((float4(_979, _981, _986, _988) * 0.5) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_664][_609] >> 16u)).x, _979, _981, _986) * _1045)) + (float4(_981, _986, _988, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_671][_609] & 65535u)).x) * _1051)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_608][_628] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_608][_628] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_618][_628] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_618][_628] >> 16u)).x) * _1057)) + (float4(float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_608][_646] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_608][_646] >> 16u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_618][_646] & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BlurF16Back_4[_618][_646] >> 16u)).x) * _1062)) / ((((float4(0.5) + _1045) + _1051) + _1057) + _1062);
            s_FFX_CACAO_BlurF16Front_4[_608][_609] = as_type<uint>(half2(float2(_1075.x, 0.0))) | (as_type<uint>(half2(float2(_1075.y, 0.0))) << 16u);
            s_FFX_CACAO_BlurF16Front_4[_618][_609] = as_type<uint>(half2(float2(_1075.z, 0.0))) | (as_type<uint>(half2(float2(_1075.w, 0.0))) << 16u);
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
    }
    for (uint _1093 = 0u; _1093 < 3u; _1093++)
    {
        uint _1101 = (3u * gl_LocalInvocationID.y) + _1093;
        bool _1106;
        if (8u <= _1101)
        {
            _1106 = _1101 < 40u;
        }
        else
        {
            _1106 = false;
        }
        if (_1106)
        {
            uint _1110 = 4u * gl_LocalInvocationID.x;
            uint _1112 = uint(_280) + _1093;
            bool _1133;
            if (8u <= _1110)
            {
                _1133 = _1110 < 56u;
            }
            else
            {
                _1133 = false;
            }
            if (_1133)
            {
                uint2 _1139 = uint2(_134 + int2(0, int(_1093)));
                uint3 _1149 = uint3(int3(int(_1139.x), int(_1139.y), int(_127)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_1112] & 65535u)).x, _115[_1093].x).xyyy, uint2(_1149.xy), uint(_1149.z));
            }
            uint _1151 = _1110 + 1u;
            bool _1156;
            if (8u <= _1151)
            {
                _1156 = _1151 < 56u;
            }
            else
            {
                _1156 = false;
            }
            if (_1156)
            {
                uint2 _1162 = uint2(_134 + int2(1, int(_1093)));
                uint3 _1172 = uint3(int3(int(_1162.x), int(_1162.y), int(_127)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_279][_1112] >> 16u)).x, _115[_1093].y).xyyy, uint2(_1172.xy), uint(_1172.z));
            }
            uint _1174 = _1110 + 2u;
            bool _1179;
            if (8u <= _1174)
            {
                _1179 = _1174 < 56u;
            }
            else
            {
                _1179 = false;
            }
            if (_1179)
            {
                uint2 _1185 = uint2(_134 + int2(2, int(_1093)));
                uint3 _1195 = uint3(int3(int(_1185.x), int(_1185.y), int(_127)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_1112] & 65535u)).x, _115[_1093].z).xyyy, uint2(_1195.xy), uint(_1195.z));
            }
            uint _1197 = _1110 + 3u;
            bool _1202;
            if (8u <= _1197)
            {
                _1202 = _1197 < 56u;
            }
            else
            {
                _1202 = false;
            }
            if (_1202)
            {
                uint2 _1208 = uint2(_134 + int2(3, int(_1093)));
                uint3 _1218 = uint3(int3(int(_1208.x), int(_1208.y), int(_127)));
                g_RwSsaoBufferPong.write(float2(float2(as_type<half2>(s_FFX_CACAO_BlurF16Front_4[_290][_1112] >> 16u)).x, _115[_1093].w).xyyy, uint2(_1218.xy), uint(_1218.z));
            }
        }
    }
}

)CACAO_GPU";
inline constexpr Binding bindings24[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_SsaoBufferPing","texture",0},{"g_RwOutput","texture",1},{"g_LinearClampSampler","sampler",0}};
inline constexpr const char*source24=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d_array<float> g_SsaoBufferPing [[texture(0)]], texture2d<float, access::write> g_RwOutput [[texture(1)]], sampler g_LinearClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    float2 _60 = float2(gl_GlobalInvocationID.xy);
    uint2 _61 = gl_GlobalInvocationID.xy / uint2(2u);
    int _64 = int(gl_GlobalInvocationID.x % 2u);
    int _67 = int(gl_GlobalInvocationID.y % 2u);
    int _68 = _67 * 2;
    int _70 = 1 - _64;
    int _73 = (1 - _67) * 2;
    int3 _81 = int4(int(_61.x), int(_61.y), _64 + _68, 0).xyz;
    float4 _83 = g_SsaoBufferPing.read(uint2(_81.xy), uint(_81.z), 0);
    uint _87 = uint(_83.y * 255.5);
    float4 _108 = fast::clamp(float4(float((_87 >> 6u) & 3u) * 0.3333333432674407958984375, float((_87 >> 4u) & 3u) * 0.3333333432674407958984375, float((_87 >> 2u) & 3u) * 0.3333333432674407958984375, float(_87 & 3u) * 0.3333333432674407958984375) + float4(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.InvSharpness), float4(0.0), float4(1.0));
    float _109 = float(_64);
    float _110 = float(_67);
    float _111 = _108.y;
    float _112 = _108.x;
    float _113 = _111 - _112;
    float _114 = _108.w;
    float _115 = _108.z;
    float3 _132 = float3(((_60 + float2((_109 + _113) - 0.5, 0.5 - _110)) * 0.5) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, float(uint(_70 + _68)));
    float _138 = (_110 - 0.5) + (_114 - _115);
    float3 _149 = float3(((_60 + float2(0.5 - _109, _138)) * 0.5) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, float(uint(_64 + _73)));
    float3 _165 = float3(((_60 + float2((_109 - 0.5) + _113, _138)) * 0.5) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, float(uint(_70 + _73)));
    float _170 = (_112 + _111) * 0.5;
    float _172 = (_115 + _114) * 0.5;
    float4 _175 = float4(1.0, _170, _172, (_170 + _172) * 0.5);
    g_RwOutput.write(float4(powr(dot(float4(_83.x, g_SsaoBufferPing.sample(g_LinearClampSampler, _132.xy, uint(rint(_132.z)), level(0.0)).x, g_SsaoBufferPing.sample(g_LinearClampSampler, _149.xy, uint(rint(_149.z)), level(0.0)).x, g_SsaoBufferPing.sample(g_LinearClampSampler, _165.xy, uint(rint(_165.z)), level(0.0)).x), _175) / dot(_175, float4(1.0)), 2.2000000476837158203125)), uint2(gl_GlobalInvocationID.xy));
}

)CACAO_GPU";
inline constexpr Binding bindings25[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_SsaoBufferPing","texture",0},{"g_RwOutput","texture",1},{"g_LinearClampSampler","sampler",0}};
inline constexpr const char*source25=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d_array<float> g_SsaoBufferPing [[texture(0)]], texture2d<float, access::write> g_RwOutput [[texture(1)]], sampler g_LinearClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    float2 _49 = float2(gl_GlobalInvocationID.xy) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions;
    float _52 = _49.x;
    float3 _54 = float3(_52, _49.y, 0.0);
    float3 _60 = float3(_52, _49.y, 1.0);
    float3 _66 = float3(_52, _49.y, 2.0);
    float3 _72 = float3(_52, _49.y, 3.0);
    g_RwOutput.write(float4((((g_SsaoBufferPing.sample(g_LinearClampSampler, _54.xy, uint(rint(_54.z)), level(0.0)).x + g_SsaoBufferPing.sample(g_LinearClampSampler, _60.xy, uint(rint(_60.z)), level(0.0)).x) + g_SsaoBufferPing.sample(g_LinearClampSampler, _66.xy, uint(rint(_66.z)), level(0.0)).x) + g_SsaoBufferPing.sample(g_LinearClampSampler, _72.xy, uint(rint(_72.z)), level(0.0)).x) * 0.25), uint2(gl_GlobalInvocationID.xy));
}

)CACAO_GPU";
inline constexpr Binding bindings26[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_SsaoBufferPing","texture",0},{"g_RwOutput","texture",1},{"g_LinearClampSampler","sampler",0}};
inline constexpr const char*source26=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d_array<float> g_SsaoBufferPing [[texture(0)]], texture2d<float, access::write> g_RwOutput [[texture(1)]], sampler g_LinearClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    float2 _47 = float2(gl_GlobalInvocationID.xy) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.OutputBufferInverseDimensions;
    float _50 = _47.x;
    float3 _52 = float3(_50, _47.y, 0.0);
    float3 _58 = float3(_50, _47.y, 3.0);
    g_RwOutput.write(float4((g_SsaoBufferPing.sample(g_LinearClampSampler, _52.xy, uint(rint(_52.z)), level(0.0)).x + g_SsaoBufferPing.sample(g_LinearClampSampler, _58.xy, uint(rint(_58.z)), level(0.0)).x) * 0.5), uint2(gl_GlobalInvocationID.xy));
}

)CACAO_GPU";
inline constexpr Binding bindings27[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_DepthIn","texture",0},{"g_DeinterleavedDepth","texture",1},{"g_SsaoBufferPing","texture",2},{"g_RwOutput","texture",3},{"g_PointClampSampler","sampler",0}};
inline constexpr const char*source27=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

struct FFX_CACAO_BilateralBufferVal
{
    uint packedDepths;
    uint packedSsaoVals;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d<float> g_DepthIn [[texture(0)]], texture2d_array<float> g_DeinterleavedDepth [[texture(1)]], texture2d_array<float> g_SsaoBufferPing [[texture(2)]], texture2d<float, access::write> g_RwOutput [[texture(3)]], sampler g_PointClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<FFX_CACAO_BilateralBufferVal, 16>, 12> s_FFX_CACAO_BilateralUpscaleBuffer;
    uint _116 = ((gl_LocalInvocationID.y * 8u) + gl_LocalInvocationID.x) * 3u;
    uint _117 = _116 % 12u;
    uint _118 = _116 / 12u;
    int2 _125;
    _125 = int2((gl_WorkGroupID.xy * uint2(8u)) + uint2(_117, _118)) - int2(2);
    int2 _126;
    for (int _128 = 0; _128 < 3; _125 = _126, _128++)
    {
        float2 _134 = float2(_125 >> int2(1));
        float2 _138 = (_134 + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions;
        int _140 = _125.y & 1;
        float2 _174;
        float2 _175;
        switch ((_140 * 2) + (_125.x & 1))
        {
            case 0:
            {
                _174 = _138 - (SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions * 0.5);
                _175 = _138;
                break;
            }
            case 1:
            {
                float2 _156 = _138;
                _156.x = _138.x + (0.5 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x);
                float2 _161 = _138;
                _161.y = _138.y - (0.5 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.y);
                _174 = _161;
                _175 = _156;
                break;
            }
            case 2:
            {
                float2 _166 = _138;
                _166.y = _138.y + (0.5 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.y);
                float2 _171 = _138;
                _171.x = _138.x - (0.5 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x);
                _174 = _171;
                _175 = _166;
                break;
            }
            case 3:
            {
                _174 = _138;
                _175 = _138 + (SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions * 0.5);
                break;
            }
            default:
            {
                _174 = _138;
                _175 = _138;
                break;
            }
        }
        float3 _180 = float3(_175, 0.0);
        float3 _188 = float3(_174, 3.0);
        _126 = _125;
        _126.x = _125.x + 1;
        int3 _207 = int4(clamp(int2(uint2(_134 + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferOffset)), int2(0), int2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferDimensions) - int2(1)), _140 * 3, 0).xyz;
        float2 _215 = float2(half2(half(g_DeinterleavedDepth.read(uint2(_207.xy), uint(_207.z), 0).x)));
        float2 _226 = float2(half2(half((g_SsaoBufferPing.sample(g_PointClampSampler, _180.xy, uint(rint(_180.z)), level(0.0)).x + g_SsaoBufferPing.sample(g_PointClampSampler, _188.xy, uint(rint(_188.z)), level(0.0)).x) * 0.5)));
        s_FFX_CACAO_BilateralUpscaleBuffer[_117 + uint(_128)][_118] = FFX_CACAO_BilateralBufferVal{ as_type<uint>(half2(float2(_215.x, 0.0))) | (as_type<uint>(half2(float2(_215.y, 0.0))) << 16u), as_type<uint>(half2(float2(_226.x, 0.0))) | (as_type<uint>(half2(float2(_226.y, 0.0))) << 16u) };
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    uint2 _239 = uint2(2u) * uint2(int3(gl_GlobalInvocationID).xy);
    int2 _243 = int2(_239) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferOffset;
    int2 _247 = int2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferDimensions) - int2(1);
    half4 _287 = half4(half(g_DepthIn.read(uint2(int3(clamp(_243, int2(0), _247), 0).xy), 0).x), half(g_DepthIn.read(uint2(int3(clamp(_243 + int2(1, 0), int2(0), _247), 0).xy), 0).x), half(g_DepthIn.read(uint2(int3(clamp(_243 + int2(0, 1), int2(0), _247), 0).xy), 0).x), half(g_DepthIn.read(uint2(int3(clamp(_243 + int2(1), int2(0), _247), 0).xy), 0).x));
    int2 _289 = int2(gl_LocalInvocationID.xy) + int2(2);
    int _290 = _289.x;
    int _291 = _289.y;
    half2 _301 = half2(float2(float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_290][_291].packedSsaoVals & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_290][_291].packedSsaoVals >> 16u)).x));
    half4 _302 = half4(half(1.0)) * half(0.00100040435791015625);
    half2 _304 = _302.xy * _301;
    half2 _306 = _302.zw * _301;
    half2 _312 = half2(half(1.0 / SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BilateralSimilarityDistanceSigma));
    half2 _317 = half2(half(1.0 / SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BilateralSigmaSquared));
    half4 _319;
    half4 _322;
    int _324;
    _319 = _302;
    _322 = half4(_304.x, _304.y, _306.x, _306.y);
    _324 = -2;
    half4 _320;
    half4 _323;
    for (; _324 <= 2; _319 = _320, _322 = _323, _324++)
    {
        _320 = _319;
        _323 = _322;
        for (int _333 = -2; _333 <= 2; )
        {
            int2 _338 = _289 + int2(_324, _333);
            int _339 = _338.x;
            int _340 = _338.y;
            half2 _349 = half2(half(short(_324))) - half2(half(0.0), half(0.5));
            half2 _352 = half2(half(short(_333)));
            half2 _353 = _352 - half2(half(0.5));
            half2 _354 = _349 * _349;
            half2 _372 = half2(float2(float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_339][_340].packedDepths & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_339][_340].packedDepths >> 16u)).x));
            half2 _374 = _287.xy - _372;
            half2 _376 = _287.zw - _372;
            half2 _385 = exp((-(_354 + (_352 * _352))) * _317) * exp((-(_374 * _374)) * _312);
            half2 _386 = exp((-(_354 + (_353 * _353))) * _317) * exp((-(_376 * _376)) * _312);
            half2 _394 = half2(float2(float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_339][_340].packedSsaoVals & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_339][_340].packedSsaoVals >> 16u)).x));
            half2 _397 = _323.xy + (_394 * _385);
            half2 _400 = _323.zw + (_394 * _386);
            half2 _402 = _320.xy + _385;
            half2 _404 = _320.zw + _386;
            _320 = half4(_402.x, _402.y, _404.x, _404.y);
            _323 = half4(_397.x, _397.y, _400.x, _400.y);
            _333++;
            continue;
        }
    }
    half4 _405 = _322 / _319;
    g_RwOutput.write(float4(float(_405.x)), uint2(_239));
    g_RwOutput.write(float4(float(_405.y)), uint2((_239 + uint2(1u, 0u))));
    g_RwOutput.write(float4(float(_405.z)), uint2((_239 + uint2(0u, 1u))));
    g_RwOutput.write(float4(float(_405.w)), uint2((_239 + uint2(1u))));
}

)CACAO_GPU";
inline constexpr Binding bindings28[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_DepthIn","texture",0},{"g_DeinterleavedDepth","texture",1},{"g_SsaoBufferPing","texture",2},{"g_RwOutput","texture",3},{"g_PointClampSampler","sampler",0}};
inline constexpr const char*source28=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

struct FFX_CACAO_BilateralBufferVal
{
    uint packedDepths;
    uint packedSsaoVals;
};

constant uint _104 = {};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d<float> g_DepthIn [[texture(0)]], texture2d_array<float> g_DeinterleavedDepth [[texture(1)]], texture2d_array<float> g_SsaoBufferPing [[texture(2)]], texture2d<float, access::write> g_RwOutput [[texture(3)]], sampler g_PointClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<FFX_CACAO_BilateralBufferVal, 16>, 12> s_FFX_CACAO_BilateralUpscaleBuffer;
    uint _117 = ((gl_LocalInvocationID.y * 8u) + gl_LocalInvocationID.x) * 3u;
    uint _118 = _117 % 12u;
    uint _119 = _117 / 12u;
    int2 _126;
    _126 = int2((gl_WorkGroupID.xy * uint2(8u)) + uint2(_118, _119)) - int2(2);
    int2 _127;
    for (int _129 = 0; _129 < 3; _126 = _127, _129++)
    {
        int2 _134 = _126 >> int2(1);
        float2 _139 = (float2(_134) + float2(0.5)) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions;
        int _145 = ((_126.y & 1) * 2) + (_126.x & 1);
        float2 _199;
        float2 _200;
        float2 _201;
        float2 _202;
        switch (_145)
        {
            case 0:
            {
                float2 _191 = _139;
                _191.x = _139.x - (0.5 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x);
                float2 _196 = _139;
                _196.y = _139.y - (0.5 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.y);
                _199 = _139 - (SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions * 0.5);
                _200 = _196;
                _201 = _191;
                _202 = _139;
                break;
            }
            case 1:
            {
                float2 _179 = _139;
                _179.x = _139.x + (0.5 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x);
                float2 _186 = _139;
                _186.y = _139.y - (0.5 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.y);
                _199 = _186;
                _200 = _139 + (float2(0.5, -0.5) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions);
                _201 = _139;
                _202 = _179;
                break;
            }
            case 2:
            {
                float2 _167 = _139;
                _167.y = _139.y + (0.5 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.y);
                float2 _174 = _139;
                _174.x = _139.x - (0.5 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x);
                _199 = _174;
                _200 = _139;
                _201 = _139 + (float2(-0.5, 0.5) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions);
                _202 = _167;
                break;
            }
            case 3:
            {
                float2 _157 = _139;
                _157.y = _139.y + (0.5 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.y);
                float2 _162 = _139;
                _162.x = _139.x + (0.5 * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions.x);
                _199 = _139;
                _200 = _162;
                _201 = _157;
                _202 = _139 + (SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions * 0.5);
                break;
            }
            default:
            {
                _199 = _139;
                _200 = _139;
                _201 = _139;
                _202 = _139;
                break;
            }
        }
        float3 _207 = float3(_202, 0.0);
        float3 _215 = float3(_201, 1.0);
        float3 _223 = float3(_200, 2.0);
        float3 _231 = float3(_199, 3.0);
        _127 = _126;
        _127.x = _126.x + 1;
        int3 _256 = int4(clamp(int2(uint2(float2(uint3(uint(_134.x), uint(_134.y), _104).xy) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferOffset)), int2(0), int2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferDimensions) - int2(1)), _145, 0).xyz;
        uint _265 = as_type<uint>(half2(float2(g_DeinterleavedDepth.read(uint2(_256.xy), uint(_256.z), 0).x, 0.0)));
        uint _269 = as_type<uint>(half2(float2((((g_SsaoBufferPing.sample(g_PointClampSampler, _207.xy, uint(rint(_207.z)), level(0.0)).x + g_SsaoBufferPing.sample(g_PointClampSampler, _215.xy, uint(rint(_215.z)), level(0.0)).x) + g_SsaoBufferPing.sample(g_PointClampSampler, _223.xy, uint(rint(_223.z)), level(0.0)).x) + g_SsaoBufferPing.sample(g_PointClampSampler, _231.xy, uint(rint(_231.z)), level(0.0)).x) * 0.25, 0.0)));
        s_FFX_CACAO_BilateralUpscaleBuffer[_118 + uint(_129)][_119] = FFX_CACAO_BilateralBufferVal{ _265 | (_265 << 16u), _269 | (_269 << 16u) };
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    uint2 _276 = uint2(2u) * uint2(int3(gl_GlobalInvocationID).xy);
    int2 _280 = int2(_276) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferOffset;
    int2 _284 = int2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferDimensions) - int2(1);
    float4 _320 = float4(g_DepthIn.read(uint2(int3(clamp(_280, int2(0), _284), 0).xy), 0).x, g_DepthIn.read(uint2(int3(clamp(_280 + int2(1, 0), int2(0), _284), 0).xy), 0).x, g_DepthIn.read(uint2(int3(clamp(_280 + int2(0, 1), int2(0), _284), 0).xy), 0).x, g_DepthIn.read(uint2(int3(clamp(_280 + int2(1), int2(0), _284), 0).xy), 0).x);
    int2 _322 = int2(gl_LocalInvocationID.xy) + int2(2);
    int _323 = _322.x;
    int _324 = _322.y;
    float2 _334 = float2(0.001000000047497451305389404296875) * float2(float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_323][_324].packedSsaoVals & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_323][_324].packedSsaoVals >> 16u)).x);
    float2 _339 = float2(1.0 / SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BilateralSimilarityDistanceSigma);
    float2 _343 = float2(1.0 / SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BilateralSigmaSquared);
    float4 _345;
    float4 _348;
    int _350;
    _345 = float4(0.001000000047497451305389404296875);
    _348 = float4(_334.x, _334.y, _334.x, _334.y);
    _350 = -2;
    float4 _346;
    float4 _349;
    for (; _350 <= 2; _345 = _346, _348 = _349, _350++)
    {
        _346 = _345;
        _349 = _348;
        for (int _359 = -2; _359 <= 2; )
        {
            int2 _364 = _322 + int2(_350, _359);
            int _365 = _364.x;
            int _366 = _364.y;
            float2 _374 = float2(float(_350)) - float2(0.0, 0.5);
            float2 _376 = float2(float(_359));
            float2 _377 = _376 - float2(0.5);
            float2 _378 = _374 * _374;
            float2 _395 = float2(float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_365][_366].packedDepths & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_365][_366].packedDepths >> 16u)).x);
            float2 _397 = _320.xy - _395;
            float2 _399 = _320.zw - _395;
            float2 _408 = exp((-(_378 + (_376 * _376))) * _343) * exp((-(_397 * _397)) * _339);
            float2 _409 = exp((-(_378 + (_377 * _377))) * _343) * exp((-(_399 * _399)) * _339);
            float2 _416 = float2(float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_365][_366].packedSsaoVals & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_365][_366].packedSsaoVals >> 16u)).x);
            float2 _419 = _349.xy + (_416 * _408);
            float2 _422 = _349.zw + (_416 * _409);
            float2 _424 = _346.xy + _408;
            float2 _426 = _346.zw + _409;
            _346 = float4(_424.x, _424.y, _426.x, _426.y);
            _349 = float4(_419.x, _419.y, _422.x, _422.y);
            _359++;
            continue;
        }
    }
    float4 _428 = powr(_348 / _345, float4(2.2000000476837158203125));
    g_RwOutput.write(float4(_428.x), uint2(_276));
    g_RwOutput.write(float4(_428.y), uint2((_276 + uint2(1u, 0u))));
    g_RwOutput.write(float4(_428.z), uint2((_276 + uint2(0u, 1u))));
    g_RwOutput.write(float4(_428.w), uint2((_276 + uint2(1u))));
}

)CACAO_GPU";
inline constexpr Binding bindings29[]={{"SSAOConstantsBuffer_t","buffer",0},{"g_DepthIn","texture",0},{"g_DeinterleavedDepth","texture",1},{"g_SsaoBufferPing","texture",2},{"g_RwOutput","texture",3},{"g_LinearClampSampler","sampler",0}};
inline constexpr const char*source29=R"CACAO_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
#pragma clang diagnostic ignored "-Wmissing-braces"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T, size_t Num>
struct spvUnsafeArray
{
    T elements[Num ? Num : 1];
    
    thread T& operator [] (size_t pos) thread
    {
        return elements[pos];
    }
    constexpr const thread T& operator [] (size_t pos) const thread
    {
        return elements[pos];
    }
    
    device T& operator [] (size_t pos) device
    {
        return elements[pos];
    }
    constexpr const device T& operator [] (size_t pos) const device
    {
        return elements[pos];
    }
    
    constexpr const constant T& operator [] (size_t pos) const constant
    {
        return elements[pos];
    }
    
    threadgroup T& operator [] (size_t pos) threadgroup
    {
        return elements[pos];
    }
    constexpr const threadgroup T& operator [] (size_t pos) const threadgroup
    {
        return elements[pos];
    }
};

struct FFX_CACAO_Constants
{
    float2 DepthUnpackConsts;
    float2 CameraTanHalfFOV;
    float2 NDCToViewMul;
    float2 NDCToViewAdd;
    float2 DepthBufferUVToViewMul;
    float2 DepthBufferUVToViewAdd;
    float EffectRadius;
    float EffectShadowStrength;
    float EffectShadowPow;
    float EffectShadowClamp;
    float EffectFadeOutMul;
    float EffectFadeOutAdd;
    float EffectHorizonAngleThreshold;
    float EffectSamplingRadiusNearLimitRec;
    float DepthPrecisionOffsetMod;
    float NegRecEffectRadius;
    float LoadCounterAvgDiv;
    float AdaptiveSampleCountLimit;
    float InvSharpness;
    int BlurNumPasses;
    float BilateralSigmaSquared;
    float BilateralSimilarityDistanceSigma;
    float4 PatternRotScaleMatrices[4][5];
    float NormalsUnpackMul;
    float NormalsUnpackAdd;
    float DetailAOStrength;
    float Dummy0;
    float2 SSAOBufferDimensions;
    float2 SSAOBufferInverseDimensions;
    float2 DepthBufferDimensions;
    float2 DepthBufferInverseDimensions;
    int2 DepthBufferOffset;
    float4 PerPassFullResUVOffset[4];
    float2 OutputBufferDimensions;
    float2 OutputBufferInverseDimensions;
    float2 ImportanceMapDimensions;
    float2 ImportanceMapInverseDimensions;
    float2 DeinterleavedDepthBufferDimensions;
    float2 DeinterleavedDepthBufferInverseDimensions;
    float2 DeinterleavedDepthBufferOffset;
    float2 DeinterleavedDepthBufferNormalisedOffset;
    float4x4 NormalsWorldToViewspaceMatrix;
};

struct type_SSAOConstantsBuffer_t
{
    FFX_CACAO_Constants g_FFX_CACAO_Consts;
};

struct FFX_CACAO_BilateralBufferVal
{
    uint packedDepths;
    uint packedSsaoVals;
};

kernel void CS(constant type_SSAOConstantsBuffer_t& SSAOConstantsBuffer_t [[buffer(0)]], texture2d<float> g_DepthIn [[texture(0)]], texture2d_array<float> g_DeinterleavedDepth [[texture(1)]], texture2d_array<float> g_SsaoBufferPing [[texture(2)]], texture2d<float, access::write> g_RwOutput [[texture(3)]], sampler g_LinearClampSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<FFX_CACAO_BilateralBufferVal, 16>, 12> s_FFX_CACAO_BilateralUpscaleBuffer;
    uint _121 = ((gl_LocalInvocationID.y * 8u) + gl_LocalInvocationID.x) * 3u;
    uint _122 = _121 % 12u;
    uint _123 = _121 / 12u;
    int2 _128 = int2((gl_WorkGroupID.xy * uint2(8u)) + uint2(_122, _123)) - int2(2);
    spvUnsafeArray<float2, 3> _109;
    for (int _130 = 0; _130 < 3; )
    {
        int _136 = _128.x + _130;
        int _137 = _128.y;
        int3 _152 = int4(clamp(int2(_136, _137) >> int2(1), int2(0), int2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferDimensions) - int2(1)), (_136 & 1) + (2 * (_137 & 1)), 0).xyz;
        _109[_130] = g_SsaoBufferPing.read(uint2(_152.xy), uint(_152.z), 0).xy;
        _130++;
        continue;
    }
    int2 _158;
    _158 = _128;
    for (int _161 = 0; _161 < 3; )
    {
        int _166 = _158.x & 1;
        int _168 = _158.y & 1;
        int _169 = _168 * 2;
        int _171 = 1 - _166;
        int _174 = (1 - _168) * 2;
        uint _182 = uint(_109[_161].y * 255.5);
        float4 _203 = fast::clamp(float4(float((_182 >> 6u) & 3u) * 0.3333333432674407958984375, float((_182 >> 4u) & 3u) * 0.3333333432674407958984375, float((_182 >> 2u) & 3u) * 0.3333333432674407958984375, float(_182 & 3u) * 0.3333333432674407958984375) + float4(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.InvSharpness), float4(0.0), float4(1.0));
        float _204 = float(_166);
        float _205 = float(_168);
        float _206 = _203.y;
        float _207 = _203.x;
        float _208 = _206 - _207;
        float _209 = _203.w;
        float _210 = _203.z;
        float2 _212 = float2(_158);
        float3 _228 = float3(((_212 + float2((_204 + _208) - 0.5, 0.5 - _205)) * 0.5) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, float(uint(_171 + _169)));
        float _234 = (_205 - 0.5) + (_209 - _210);
        float3 _245 = float3(((_212 + float2(0.5 - _204, _234)) * 0.5) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, float(uint(_166 + _174)));
        float3 _261 = float3(((_212 + float2((_204 - 0.5) + _208, _234)) * 0.5) * SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.SSAOBufferInverseDimensions, float(uint(_171 + _174)));
        float _266 = (_207 + _206) * 0.5;
        float _268 = (_210 + _209) * 0.5;
        float4 _271 = float4(1.0, _266, _268, (_266 + _268) * 0.5);
        int2 _159 = _158;
        _159.x = _158.x + 1;
        int3 _292 = int4(clamp(int2(uint2(float2(_159 >> int2(1)) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferOffset)), int2(0), int2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DeinterleavedDepthBufferDimensions) - int2(1)), _166 + _169, 0).xyz;
        uint _297 = as_type<uint>(half2(float2(g_DeinterleavedDepth.read(uint2(_292.xy), uint(_292.z), 0).x, 0.0)));
        uint _301 = as_type<uint>(half2(float2(dot(float4(_109[_161].x, g_SsaoBufferPing.sample(g_LinearClampSampler, _228.xy, uint(rint(_228.z)), level(0.0)).x, g_SsaoBufferPing.sample(g_LinearClampSampler, _245.xy, uint(rint(_245.z)), level(0.0)).x, g_SsaoBufferPing.sample(g_LinearClampSampler, _261.xy, uint(rint(_261.z)), level(0.0)).x), _271) / dot(_271, float4(1.0)), 0.0)));
        s_FFX_CACAO_BilateralUpscaleBuffer[_122 + uint(_161)][_123] = FFX_CACAO_BilateralBufferVal{ _297 | (_297 << 16u), _301 | (_301 << 16u) };
        _158 = _159;
        _161++;
        continue;
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    uint2 _308 = uint2(2u) * uint2(int3(gl_GlobalInvocationID).xy);
    int2 _312 = int2(_308) + SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferOffset;
    int2 _316 = int2(SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.DepthBufferDimensions) - int2(1);
    float4 _352 = float4(g_DepthIn.read(uint2(int3(clamp(_312, int2(0), _316), 0).xy), 0).x, g_DepthIn.read(uint2(int3(clamp(_312 + int2(1, 0), int2(0), _316), 0).xy), 0).x, g_DepthIn.read(uint2(int3(clamp(_312 + int2(0, 1), int2(0), _316), 0).xy), 0).x, g_DepthIn.read(uint2(int3(clamp(_312 + int2(1), int2(0), _316), 0).xy), 0).x);
    int2 _354 = int2(gl_LocalInvocationID.xy) + int2(2);
    int _355 = _354.x;
    int _356 = _354.y;
    float2 _366 = float2(0.001000000047497451305389404296875) * float2(float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_355][_356].packedSsaoVals & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_355][_356].packedSsaoVals >> 16u)).x);
    float2 _371 = float2(1.0 / SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BilateralSimilarityDistanceSigma);
    float2 _375 = float2(1.0 / SSAOConstantsBuffer_t.g_FFX_CACAO_Consts.BilateralSigmaSquared);
    float4 _377;
    float4 _380;
    int _382;
    _377 = float4(0.001000000047497451305389404296875);
    _380 = float4(_366.x, _366.y, _366.x, _366.y);
    _382 = -2;
    float4 _378;
    float4 _381;
    for (; _382 <= 2; _377 = _378, _380 = _381, _382++)
    {
        _378 = _377;
        _381 = _380;
        for (int _391 = -2; _391 <= 2; )
        {
            int2 _396 = _354 + int2(_382, _391);
            int _397 = _396.x;
            int _398 = _396.y;
            float2 _406 = float2(float(_382)) - float2(0.0, 0.5);
            float2 _408 = float2(float(_391));
            float2 _409 = _408 - float2(0.5);
            float2 _410 = _406 * _406;
            float2 _427 = float2(float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_397][_398].packedDepths & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_397][_398].packedDepths >> 16u)).x);
            float2 _429 = _352.xy - _427;
            float2 _431 = _352.zw - _427;
            float2 _440 = exp((-(_410 + (_408 * _408))) * _375) * exp((-(_429 * _429)) * _371);
            float2 _441 = exp((-(_410 + (_409 * _409))) * _375) * exp((-(_431 * _431)) * _371);
            float2 _448 = float2(float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_397][_398].packedSsaoVals & 65535u)).x, float2(as_type<half2>(s_FFX_CACAO_BilateralUpscaleBuffer[_397][_398].packedSsaoVals >> 16u)).x);
            float2 _451 = _381.xy + (_448 * _440);
            float2 _454 = _381.zw + (_448 * _441);
            float2 _456 = _378.xy + _440;
            float2 _458 = _378.zw + _441;
            _378 = float4(_456.x, _456.y, _458.x, _458.y);
            _381 = float4(_451.x, _451.y, _454.x, _454.y);
            _391++;
            continue;
        }
    }
    float4 _460 = powr(_380 / _377, float4(2.2000000476837158203125));
    g_RwOutput.write(float4(_460.x), uint2(_308));
    g_RwOutput.write(float4(_460.y), uint2((_308 + uint2(1u, 0u))));
    g_RwOutput.write(float4(_460.z), uint2((_308 + uint2(0u, 1u))));
    g_RwOutput.write(float4(_460.w), uint2((_308 + uint2(1u))));
}

)CACAO_GPU";
inline constexpr Binding bindings30[]={{"MacLauncherScene","buffer",0},{"mlRawDepth","texture",0},{"mlLinearDepth","texture",1}};
inline constexpr const char*source30=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct type_MacLauncherScene
{
    float4 mlProjection[4];
    float4 mlInverse[4];
    float4 mlJitterSign;
    uint4 mlDepthROI;
    float4 mlClip;
};

kernel void CSUnprojectDepth(constant type_MacLauncherScene& MacLauncherScene [[buffer(0)]], texture2d<float> mlRawDepth [[texture(0)]], texture2d<float, access::write> mlLinearDepth [[texture(1)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    uint2 _54 = gl_GlobalInvocationID.xy;
    do
    {
        if (any(_54 >= MacLauncherScene.mlDepthROI.zw))
        {
            break;
        }
        uint _67 = uint(MacLauncherScene.mlJitterSign.w);
        uint2 _78;
        if ((_67 & 1u) != 0u)
        {
            uint2 _77 = _54;
            _77.y = (MacLauncherScene.mlDepthROI.w - 1u) - gl_GlobalInvocationID.y;
            _78 = _77;
        }
        else
        {
            _78 = _54;
        }
        uint2 _80 = _78 + MacLauncherScene.mlDepthROI.xy;
        float2 _92 = float2(MacLauncherScene.mlDepthROI.zw);
        bool _95 = (_67 & 2u) != 0u;
        float2 _107 = ((((float2(_54) + float2(0.5)) / _92) - (MacLauncherScene.mlJitterSign.xy / _92)) * float2(2.0, float(_95 ? 2 : (-2)))) + float2(-1.0, float(_95 ? (-1) : 1));
        float4 _130 = (((MacLauncherScene.mlInverse[0] * _107.x) + (MacLauncherScene.mlInverse[1] * _107.y)) + (MacLauncherScene.mlInverse[2] * ((mlRawDepth.read(uint2(int3(int(_80.x), int(_80.y), 0).xy), 0).x * MacLauncherScene.mlClip.x) + MacLauncherScene.mlClip.y))) + (MacLauncherScene.mlInverse[3] * 1.0);
        float _136 = (_130.z / _130.w) * MacLauncherScene.mlJitterSign.z;
        bool _144;
        if (!(isnan(_136) || isinf(_136)))
        {
            _144 = _136 > 0.0;
        }
        else
        {
            _144 = false;
        }
        float _149;
        if (_144)
        {
            _149 = precise::min(_136, 65504.0);
        }
        else
        {
            _149 = 65504.0;
        }
        mlLinearDepth.write(float4(_149), uint2(_54));
        break;
    } while(false);
}

)CACAO_GPU";
inline constexpr Binding bindings31[]={{"MacLauncherScene","buffer",0},{"mlColor","texture",0},{"mlAO","texture",1},{"mlOutput","texture",2}};
inline constexpr const char*source31=R"CACAO_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct type_MacLauncherScene
{
    float4 mlProjection[4];
    float4 mlInverse[4];
    float4 mlJitterSign;
    uint4 mlDepthROI;
    float4 mlClip;
};

kernel void CSApplyAO(constant type_MacLauncherScene& MacLauncherScene [[buffer(0)]], texture2d<float> mlColor [[texture(0)]], texture2d<float> mlAO [[texture(1)]], texture2d<float, access::write> mlOutput [[texture(2)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    uint2 _43 = gl_GlobalInvocationID.xy;
    do
    {
        if (any(_43 >= MacLauncherScene.mlDepthROI.zw))
        {
            break;
        }
        uint2 _66;
        if ((uint(MacLauncherScene.mlJitterSign.w) & 1u) != 0u)
        {
            uint2 _65 = _43;
            _65.y = (MacLauncherScene.mlDepthROI.w - 1u) - gl_GlobalInvocationID.y;
            _66 = _65;
        }
        else
        {
            _66 = _43;
        }
        float4 _74 = mlColor.read(uint2(int3(int(gl_GlobalInvocationID.x), int(gl_GlobalInvocationID.y), 0).xy), 0);
        mlOutput.write(float4(_74.xyz * fast::clamp(mlAO.read(uint2(int3(int(_66.x), int(_66.y), 0).xy), 0).x, 0.0, 1.0), _74.w), uint2(_43));
        break;
    } while(false);
}

)CACAO_GPU";
inline constexpr Shader shaders[]={{"prepare-native-depths","CS",source0,bindings0,sizeof(bindings0)/sizeof(Binding),8,8,1},{"prepare-native-depths-and-mips","CS",source1,bindings1,sizeof(bindings1)/sizeof(Binding),8,8,1},{"prepare-native-depths-half","CS",source2,bindings2,sizeof(bindings2)/sizeof(Binding),8,8,1},{"prepare-native-normals","CS",source3,bindings3,sizeof(bindings3)/sizeof(Binding),8,8,1},{"prepare-downsampled-depths","CS",source4,bindings4,sizeof(bindings4)/sizeof(Binding),8,8,1},{"prepare-downsampled-depths-and-mips","CS",source5,bindings5,sizeof(bindings5)/sizeof(Binding),8,8,1},{"prepare-downsampled-depths-half","CS",source6,bindings6,sizeof(bindings6)/sizeof(Binding),8,8,1},{"prepare-downsampled-normals","CS",source7,bindings7,sizeof(bindings7)/sizeof(Binding),8,8,1},{"generate-q0","CS",source8,bindings8,sizeof(bindings8)/sizeof(Binding),4,16,1},{"generate-q1","CS",source9,bindings9,sizeof(bindings9)/sizeof(Binding),4,16,1},{"generate-q2","CS",source10,bindings10,sizeof(bindings10)/sizeof(Binding),8,8,1},{"generate-q3","CS",source11,bindings11,sizeof(bindings11)/sizeof(Binding),8,8,1},{"generate-q3-base","CS",source12,bindings12,sizeof(bindings12)/sizeof(Binding),8,8,1},{"importance","CS",source13,bindings13,sizeof(bindings13)/sizeof(Binding),8,8,1},{"importance-a","CS",source14,bindings14,sizeof(bindings14)/sizeof(Binding),8,8,1},{"importance-b","CS",source15,bindings15,sizeof(bindings15)/sizeof(Binding),8,8,1},{"blur-1","CS",source16,bindings16,sizeof(bindings16)/sizeof(Binding),16,16,1},{"blur-2","CS",source17,bindings17,sizeof(bindings17)/sizeof(Binding),16,16,1},{"blur-3","CS",source18,bindings18,sizeof(bindings18)/sizeof(Binding),16,16,1},{"blur-4","CS",source19,bindings19,sizeof(bindings19)/sizeof(Binding),16,16,1},{"blur-5","CS",source20,bindings20,sizeof(bindings20)/sizeof(Binding),16,16,1},{"blur-6","CS",source21,bindings21,sizeof(bindings21)/sizeof(Binding),16,16,1},{"blur-7","CS",source22,bindings22,sizeof(bindings22)/sizeof(Binding),16,16,1},{"blur-8","CS",source23,bindings23,sizeof(bindings23)/sizeof(Binding),16,16,1},{"apply","CS",source24,bindings24,sizeof(bindings24)/sizeof(Binding),8,8,1},{"apply-non-smart","CS",source25,bindings25,sizeof(bindings25)/sizeof(Binding),8,8,1},{"apply-non-smart-half","CS",source26,bindings26,sizeof(bindings26)/sizeof(Binding),8,8,1},{"upscale-half","CS",source27,bindings27,sizeof(bindings27)/sizeof(Binding),8,8,1},{"upscale-linear","CS",source28,bindings28,sizeof(bindings28)/sizeof(Binding),8,8,1},{"upscale-smart","CS",source29,bindings29,sizeof(bindings29)/sizeof(Binding),8,8,1},{"unproject","CSUnprojectDepth",source30,bindings30,sizeof(bindings30)/sizeof(Binding),8,8,1},{"compose","CSApplyAO",source31,bindings31,sizeof(bindings31)/sizeof(Binding),8,8,1},};
}
