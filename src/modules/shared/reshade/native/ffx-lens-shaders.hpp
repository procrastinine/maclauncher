// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see ffx-lens-MIT.txt.
// Generated original FidelityFX lens compute kernels.
#pragma once
#include <cstddef>
namespace macfx::ffx_lens_shaders {
struct Binding{const char*name;const char*kind;unsigned index;};
struct Shader{const char*name;const char*entry;const char*source;const Binding*bindings;size_t count;unsigned dimension,sigma,x,y,z;};
inline constexpr Binding bindings0[]={{"cbLens","buffer",0},{"r_input_texture","texture",0},{"rw_output_texture","texture",1},{"s_LinearClamp","sampler",0}};
inline constexpr const char*source0=R"FFX_IMAGE(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct type_cbLens
{
    float grainScale;
    float grainAmount;
    uint grainSeed;
    uint pad;
    uint2 center;
    float chromAb;
    float vignette;
};

constant uint _72 = {};

kernel void CS(constant type_cbLens& cbLens [[buffer(0)]], texture2d<float> r_input_texture [[texture(0)]], texture2d<float, access::write> rw_output_texture [[texture(1)]], sampler s_LinearClamp [[sampler(0)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    uint2 _92 = uint2((gl_LocalInvocationID.x & 1u) | ((gl_LocalInvocationID.x >> 2u) & 6u), ((gl_LocalInvocationID.x >> 1u) & 3u) | ((gl_LocalInvocationID.x >> 3u) & 4u)) + uint2(gl_WorkGroupID.x << 3u, gl_WorkGroupID.y << 3u);
    int2 _93 = int2(_92);
    float _100 = (cbLens.chromAb * 0.021319486200809478759765625) + 0.52199995517730712890625;
    int2 _106 = int2(cbLens.center);
    int2 _107 = _93 - _106;
    float2 _108 = float2(_107);
    float2 _110 = float2(_106);
    float2 _115 = float2(1.0) / float2(int2(2) * _106);
    float2 _131 = float2(_93);
    float2 _146 = cos(((float2(abs(_107)) / _110) * cbLens.vignette) * 0.78539752960205078125);
    float2 _147 = _146 * _146;
    float2 _148 = _147 * _147;
    float3 _153 = float3(r_input_texture.sample(s_LinearClamp, ((((_108 * (((cbLens.chromAb * 0.012254902161657810211181640625) + 0.52199995517730712890625) / _100)) + _110) + float2(0.5)) * _115), level(0.0)).x, r_input_texture.sample(s_LinearClamp, ((((_108 * (((cbLens.chromAb * 0.01522888056933879852294921875) + 0.52199995517730712890625) / _100)) + _110) + float2(0.5)) * _115), level(0.0)).y, r_input_texture.sample(s_LinearClamp, (_131 * _115), level(0.0)).z) * fast::clamp(_148.x * _148.y, 0.0, 1.0);
    float2 _162 = _131 / float2(cbLens.grainScale * 0.125);
    uint3 _169 = (uint3(uint(_162.x), uint(_162.y), cbLens.grainSeed) * uint3(12829u)) + uint3(47989u);
    uint _170 = _169.y;
    uint _171 = _169.z;
    uint _174 = _169.x + (_170 * _171);
    uint _176 = _170 + (_171 * _174);
    uint _178 = _171 + (_174 * _176);
    uint _180 = _174 + (_176 * _178);
    float2 _191 = (_131 / float2(cbLens.grainScale)) + ((float2((uint3(_180, _176 + (_178 * _180), _72) >> uint3(16u)).xy) * 1.52587890625e-05) - float2(0.5));
    float2 _198 = rint(_191 + float2((_191.x + _191.y) * 0.366025388240814208984375));
    uint2 _217 = uint2(rw_output_texture.get_width(), rw_output_texture.get_height());
    bool _229;
    if (all(_93 >= int2(0)))
    {
        _229 = all(_93 < int2(int(_217.x), int(_217.y)));
    }
    else
    {
        _229 = false;
    }
    if (_229)
    {
        rw_output_texture.write(float4(_153 + ((precise::min(_153, float3(1.0) - _153) * (1.0 - (2.0 * exp2(length(_191 - (_198 - float2((_198.x + _198.y) * 0.211324870586395263671875))) * (-3.0))))) * cbLens.grainAmount), 1.0), uint2(_92));
    }
}

)FFX_IMAGE";
inline constexpr Shader shaders[]={{"lens","CS",source0,bindings0,sizeof(bindings0)/sizeof(Binding),0,0,64,1,1}};
}
