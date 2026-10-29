// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see dof-MIT.txt.
// Generated original FidelityFX DoF compute kernels.
#pragma once
#include <cstddef>
namespace macfx::dof_shaders {
struct Binding{const char*name;const char*kind;unsigned index;};
struct Shader{const char*name;const char*entry;const char*source;const Binding*bindings;size_t count;unsigned x,y,z;};
inline constexpr Binding bindings0[]={{"cbDOF","buffer",0},{"rw_internal_globals","buffer",1},{"r_input_depth","texture",0},{"rw_internal_radius","texture",1},{"LinearSampler","sampler",0}};
inline constexpr const char*source0=R"DOF_GPU(#pragma clang diagnostic ignored "-Wunused-variable"

#include <metal_stdlib>
#include <simd/simd.h>
#include <metal_atomic>

using namespace metal;

struct type_cbDOF
{
    float cocScale;
    float cocBias;
    uint2 inputSizeHalf;
    uint2 inputSize;
    float2 inputSizeHalfRcp;
    float cocLimit;
    uint maxRings;
};

struct DofGlobalVars
{
    uint maxTileRad;
};

struct type_RWStructuredBuffer_DofGlobalVars
{
    DofGlobalVars _m0[1];
};

kernel void CS(constant type_cbDOF& cbDOF [[buffer(0)]], volatile device type_RWStructuredBuffer_DofGlobalVars& rw_internal_globals [[buffer(1)]], texture2d<float> r_input_depth [[texture(0)]], texture2d<float, access::write> rw_internal_radius [[texture(1)]], sampler LinearSampler [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    uint2 _59 = gl_GlobalInvocationID.xy * uint2(8u);
    float2 _61 = float2(1.0) / float2(cbDOF.inputSize);
    float _63;
    float _66;
    uint _68;
    _63 = 3.4028234663852885981170418348452e+38;
    _66 = 0.0;
    _68 = 0u;
    float _64;
    float _67;
    for (; _68 < 8u; _63 = _64, _66 = _67, _68 += 2u)
    {
        _67 = _66;
        _64 = _63;
        for (uint _77 = 0u; _77 < 8u; )
        {
            float4 _89 = r_input_depth.gather(LinearSampler, fast::clamp(float2(_59 + uint2(_77, _68)) * _61, float2(0.0), float2(1.0)), int2(0), component::x);
            float _90 = _89.x;
            float _91 = _89.y;
            float _93 = _89.z;
            float _95 = _89.w;
            _67 = precise::max(_67, precise::max(precise::max(precise::max(_90, _91), _93), _95));
            _64 = precise::min(_64, precise::min(precise::min(precise::min(_90, _91), _93), _95));
            _77 += 2u;
            continue;
        }
    }
    float _108 = -cbDOF.cocLimit;
    float2 _113 = float2(fast::clamp((cbDOF.cocScale * _66) + cbDOF.cocBias, _108, cbDOF.cocLimit), fast::clamp((cbDOF.cocScale * _63) + cbDOF.cocBias, _108, cbDOF.cocLimit));
    uint2 _118 = uint2(ceil(abs(_113) * float2(0.25))) + uint2(1u);
    uint _123 = atomic_fetch_max_explicit((volatile device atomic_uint*)&rw_internal_globals._m0[0u].maxTileRad, max(_118.x, _118.y), memory_order_relaxed);
    if (all(gl_GlobalInvocationID.xy < uint2(rw_internal_radius.get_width(), rw_internal_radius.get_height())))
    {
        rw_internal_radius.write(_113.xyyy, uint2(gl_GlobalInvocationID.xy));
    }
}

)DOF_GPU";
inline constexpr Binding bindings1[]={{"cbDOF","buffer",0},{"r_input_depth","texture",0},{"r_input_color","texture",1},{"rw_internal_bilat_color_mip0","texture",2},{"rw_internal_bilat_color_mip1","texture",3},{"rw_internal_bilat_color_mip2","texture",4},{"rw_internal_bilat_color_mip3","texture",5}};
inline constexpr const char*source1=R"DOF_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbDOF
{
    float cocScale;
    float cocBias;
    uint2 inputSizeHalf;
    uint2 inputSize;
    float2 inputSizeHalfRcp;
    float cocLimit;
    uint maxRings;
};

kernel void CS(constant type_cbDOF& cbDOF [[buffer(0)]], texture2d<float> r_input_depth [[texture(0)]], texture2d<float> r_input_color [[texture(1)]], texture2d<float, access::write> rw_internal_bilat_color_mip0 [[texture(2)]], texture2d<float, access::write> rw_internal_bilat_color_mip1 [[texture(3)]], texture2d<float, access::write> rw_internal_bilat_color_mip2 [[texture(4)]], texture2d<float, access::write> rw_internal_bilat_color_mip3 [[texture(5)]], uint gl_LocalInvocationIndex [[thread_index_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<spvUnsafeArray<float, 16>, 16> spdIntermediateR;
    threadgroup spvUnsafeArray<spvUnsafeArray<float, 16>, 16> spdIntermediateG;
    threadgroup spvUnsafeArray<spvUnsafeArray<float, 16>, 16> spdIntermediateB;
    threadgroup spvUnsafeArray<spvUnsafeArray<float, 16>, 16> spdIntermediateA;
    uint _85 = gl_LocalInvocationIndex % 64u;
    uint _98 = ((_85 & 1u) | ((_85 >> 2u) & 6u)) + (8u * ((gl_LocalInvocationIndex >> 6u) % 2u));
    uint _101 = (((_85 >> 1u) & 3u) | ((_85 >> 3u) & 4u)) + (8u * (gl_LocalInvocationIndex >> 7u));
    int2 _103 = int2(gl_WorkGroupID.xy * uint2(64u));
    uint _104 = _98 * 2u;
    int _105 = int(_104);
    uint _106 = _101 * 2u;
    int _107 = int(_106);
    int2 _109 = _103 + int2(_105, _107);
    int2 _111 = int2(gl_WorkGroupID.xy * uint2(32u));
    int _112 = int(_98);
    int _113 = int(_101);
    int2 _114 = int2(_112, _113);
    int2 _115 = _111 + _114;
    uint2 _116 = uint2(_109);
    uint2 _117 = _116 + uint2(0u, 1u);
    uint2 _118 = _116 + uint2(1u, 0u);
    uint2 _119 = _116 + uint2(1u);
    float _130;
    if (all(_116 < cbDOF.inputSize))
    {
        _130 = r_input_depth.read(uint2(_116), 0u).x;
    }
    else
    {
        _130 = 0.0;
    }
    float _139 = -cbDOF.cocLimit;
    float _140 = fast::clamp((cbDOF.cocScale * _130) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _148;
    if (all(_109 >= int2(0)))
    {
        _148 = all(_109 < int2(cbDOF.inputSize));
    }
    else
    {
        _148 = false;
    }
    float4 _154;
    if (_148)
    {
        _154 = r_input_color.read(uint2(_116), 0u);
    }
    else
    {
        _154 = float4(0.0);
    }
    int2 _159 = int2(_117);
    float _168;
    if (all(_117 < cbDOF.inputSize))
    {
        _168 = r_input_depth.read(uint2(_117), 0u).x;
    }
    else
    {
        _168 = 0.0;
    }
    float _171 = fast::clamp((cbDOF.cocScale * _168) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _179;
    if (all(_159 >= int2(0)))
    {
        _179 = all(_159 < int2(cbDOF.inputSize));
    }
    else
    {
        _179 = false;
    }
    float4 _185;
    if (_179)
    {
        _185 = r_input_color.read(uint2(_117), 0u);
    }
    else
    {
        _185 = float4(0.0);
    }
    int2 _190 = int2(_118);
    float _199;
    if (all(_118 < cbDOF.inputSize))
    {
        _199 = r_input_depth.read(uint2(_118), 0u).x;
    }
    else
    {
        _199 = 0.0;
    }
    float _202 = fast::clamp((cbDOF.cocScale * _199) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _210;
    if (all(_190 >= int2(0)))
    {
        _210 = all(_190 < int2(cbDOF.inputSize));
    }
    else
    {
        _210 = false;
    }
    float4 _216;
    if (_210)
    {
        _216 = r_input_color.read(uint2(_118), 0u);
    }
    else
    {
        _216 = float4(0.0);
    }
    int2 _221 = int2(_119);
    float _230;
    if (all(_119 < cbDOF.inputSize))
    {
        _230 = r_input_depth.read(uint2(_119), 0u).x;
    }
    else
    {
        _230 = 0.0;
    }
    float _233 = fast::clamp((cbDOF.cocScale * _230) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _241;
    if (all(_221 >= int2(0)))
    {
        _241 = all(_221 < int2(cbDOF.inputSize));
    }
    else
    {
        _241 = false;
    }
    float4 _247;
    if (_241)
    {
        _247 = r_input_color.read(uint2(_119), 0u);
    }
    else
    {
        _247 = float4(0.0);
    }
    float _255 = fast::clamp(1.0 - abs(_140 - _171), 0.0, 1.0);
    float _259 = fast::clamp(1.0 - abs(_140 - _202), 0.0, 1.0);
    float _263 = fast::clamp(1.0 - abs(_140 - _233), 0.0, 1.0);
    spvUnsafeArray<float4, 4> _81;
    _81[0] = float4((((float4(_154.xyz, _140).xyz + (float4(_185.xyz, _171).xyz * _255)) + (float4(_216.xyz, _202).xyz * _259)) + (float4(_247.xyz, _233).xyz * _263)) / float3(((1.0 + _255) + _259) + _263), _140);
    do
    {
        bool _298;
        if (!any(_115 < int2(0)))
        {
            _298 = any(_115 >= max(int2(cbDOF.inputSizeHalf), int2(1)));
        }
        else
        {
            _298 = true;
        }
        if (_298)
        {
            break;
        }
        rw_internal_bilat_color_mip0.write(_81[0], uint2(uint2(_115)));
        break;
    } while(false);
    int _304 = int(_104 + 32u);
    int2 _306 = _103 + int2(_304, _107);
    int _308 = int(_98 + 16u);
    int2 _310 = _111 + int2(_308, _113);
    uint2 _311 = uint2(_306);
    uint2 _312 = _311 + uint2(0u, 1u);
    uint2 _313 = _311 + uint2(1u, 0u);
    uint2 _314 = _311 + uint2(1u);
    float _323;
    if (all(_311 < cbDOF.inputSize))
    {
        _323 = r_input_depth.read(uint2(_311), 0u).x;
    }
    else
    {
        _323 = 0.0;
    }
    float _326 = fast::clamp((cbDOF.cocScale * _323) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _334;
    if (all(_306 >= int2(0)))
    {
        _334 = all(_306 < int2(cbDOF.inputSize));
    }
    else
    {
        _334 = false;
    }
    float4 _340;
    if (_334)
    {
        _340 = r_input_color.read(uint2(_311), 0u);
    }
    else
    {
        _340 = float4(0.0);
    }
    int2 _345 = int2(_312);
    float _354;
    if (all(_312 < cbDOF.inputSize))
    {
        _354 = r_input_depth.read(uint2(_312), 0u).x;
    }
    else
    {
        _354 = 0.0;
    }
    float _357 = fast::clamp((cbDOF.cocScale * _354) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _365;
    if (all(_345 >= int2(0)))
    {
        _365 = all(_345 < int2(cbDOF.inputSize));
    }
    else
    {
        _365 = false;
    }
    float4 _371;
    if (_365)
    {
        _371 = r_input_color.read(uint2(_312), 0u);
    }
    else
    {
        _371 = float4(0.0);
    }
    int2 _376 = int2(_313);
    float _385;
    if (all(_313 < cbDOF.inputSize))
    {
        _385 = r_input_depth.read(uint2(_313), 0u).x;
    }
    else
    {
        _385 = 0.0;
    }
    float _388 = fast::clamp((cbDOF.cocScale * _385) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _396;
    if (all(_376 >= int2(0)))
    {
        _396 = all(_376 < int2(cbDOF.inputSize));
    }
    else
    {
        _396 = false;
    }
    float4 _402;
    if (_396)
    {
        _402 = r_input_color.read(uint2(_313), 0u);
    }
    else
    {
        _402 = float4(0.0);
    }
    int2 _407 = int2(_314);
    float _416;
    if (all(_314 < cbDOF.inputSize))
    {
        _416 = r_input_depth.read(uint2(_314), 0u).x;
    }
    else
    {
        _416 = 0.0;
    }
    float _419 = fast::clamp((cbDOF.cocScale * _416) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _427;
    if (all(_407 >= int2(0)))
    {
        _427 = all(_407 < int2(cbDOF.inputSize));
    }
    else
    {
        _427 = false;
    }
    float4 _433;
    if (_427)
    {
        _433 = r_input_color.read(uint2(_314), 0u);
    }
    else
    {
        _433 = float4(0.0);
    }
    float _441 = fast::clamp(1.0 - abs(_326 - _357), 0.0, 1.0);
    float _445 = fast::clamp(1.0 - abs(_326 - _388), 0.0, 1.0);
    float _449 = fast::clamp(1.0 - abs(_326 - _419), 0.0, 1.0);
    _81[1] = float4((((float4(_340.xyz, _326).xyz + (float4(_371.xyz, _357).xyz * _441)) + (float4(_402.xyz, _388).xyz * _445)) + (float4(_433.xyz, _419).xyz * _449)) / float3(((1.0 + _441) + _445) + _449), _326);
    do
    {
        bool _484;
        if (!any(_310 < int2(0)))
        {
            _484 = any(_310 >= max(int2(cbDOF.inputSizeHalf), int2(1)));
        }
        else
        {
            _484 = true;
        }
        if (_484)
        {
            break;
        }
        rw_internal_bilat_color_mip0.write(_81[1], uint2(uint2(_310)));
        break;
    } while(false);
    int _490 = int(_106 + 32u);
    int2 _492 = _103 + int2(_105, _490);
    int _494 = int(_101 + 16u);
    int2 _496 = _111 + int2(_112, _494);
    uint2 _497 = uint2(_492);
    uint2 _498 = _497 + uint2(0u, 1u);
    uint2 _499 = _497 + uint2(1u, 0u);
    uint2 _500 = _497 + uint2(1u);
    float _509;
    if (all(_497 < cbDOF.inputSize))
    {
        _509 = r_input_depth.read(uint2(_497), 0u).x;
    }
    else
    {
        _509 = 0.0;
    }
    float _512 = fast::clamp((cbDOF.cocScale * _509) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _520;
    if (all(_492 >= int2(0)))
    {
        _520 = all(_492 < int2(cbDOF.inputSize));
    }
    else
    {
        _520 = false;
    }
    float4 _526;
    if (_520)
    {
        _526 = r_input_color.read(uint2(_497), 0u);
    }
    else
    {
        _526 = float4(0.0);
    }
    int2 _531 = int2(_498);
    float _540;
    if (all(_498 < cbDOF.inputSize))
    {
        _540 = r_input_depth.read(uint2(_498), 0u).x;
    }
    else
    {
        _540 = 0.0;
    }
    float _543 = fast::clamp((cbDOF.cocScale * _540) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _551;
    if (all(_531 >= int2(0)))
    {
        _551 = all(_531 < int2(cbDOF.inputSize));
    }
    else
    {
        _551 = false;
    }
    float4 _557;
    if (_551)
    {
        _557 = r_input_color.read(uint2(_498), 0u);
    }
    else
    {
        _557 = float4(0.0);
    }
    int2 _562 = int2(_499);
    float _571;
    if (all(_499 < cbDOF.inputSize))
    {
        _571 = r_input_depth.read(uint2(_499), 0u).x;
    }
    else
    {
        _571 = 0.0;
    }
    float _574 = fast::clamp((cbDOF.cocScale * _571) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _582;
    if (all(_562 >= int2(0)))
    {
        _582 = all(_562 < int2(cbDOF.inputSize));
    }
    else
    {
        _582 = false;
    }
    float4 _588;
    if (_582)
    {
        _588 = r_input_color.read(uint2(_499), 0u);
    }
    else
    {
        _588 = float4(0.0);
    }
    int2 _593 = int2(_500);
    float _602;
    if (all(_500 < cbDOF.inputSize))
    {
        _602 = r_input_depth.read(uint2(_500), 0u).x;
    }
    else
    {
        _602 = 0.0;
    }
    float _605 = fast::clamp((cbDOF.cocScale * _602) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _613;
    if (all(_593 >= int2(0)))
    {
        _613 = all(_593 < int2(cbDOF.inputSize));
    }
    else
    {
        _613 = false;
    }
    float4 _619;
    if (_613)
    {
        _619 = r_input_color.read(uint2(_500), 0u);
    }
    else
    {
        _619 = float4(0.0);
    }
    float _627 = fast::clamp(1.0 - abs(_512 - _543), 0.0, 1.0);
    float _631 = fast::clamp(1.0 - abs(_512 - _574), 0.0, 1.0);
    float _635 = fast::clamp(1.0 - abs(_512 - _605), 0.0, 1.0);
    _81[2] = float4((((float4(_526.xyz, _512).xyz + (float4(_557.xyz, _543).xyz * _627)) + (float4(_588.xyz, _574).xyz * _631)) + (float4(_619.xyz, _605).xyz * _635)) / float3(((1.0 + _627) + _631) + _635), _512);
    do
    {
        bool _670;
        if (!any(_496 < int2(0)))
        {
            _670 = any(_496 >= max(int2(cbDOF.inputSizeHalf), int2(1)));
        }
        else
        {
            _670 = true;
        }
        if (_670)
        {
            break;
        }
        rw_internal_bilat_color_mip0.write(_81[2], uint2(uint2(_496)));
        break;
    } while(false);
    int2 _676 = _103 + int2(_304, _490);
    int2 _678 = _111 + int2(_308, _494);
    uint2 _679 = uint2(_676);
    uint2 _680 = _679 + uint2(0u, 1u);
    uint2 _681 = _679 + uint2(1u, 0u);
    uint2 _682 = _679 + uint2(1u);
    float _691;
    if (all(_679 < cbDOF.inputSize))
    {
        _691 = r_input_depth.read(uint2(_679), 0u).x;
    }
    else
    {
        _691 = 0.0;
    }
    float _694 = fast::clamp((cbDOF.cocScale * _691) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _702;
    if (all(_676 >= int2(0)))
    {
        _702 = all(_676 < int2(cbDOF.inputSize));
    }
    else
    {
        _702 = false;
    }
    float4 _708;
    if (_702)
    {
        _708 = r_input_color.read(uint2(_679), 0u);
    }
    else
    {
        _708 = float4(0.0);
    }
    int2 _713 = int2(_680);
    float _722;
    if (all(_680 < cbDOF.inputSize))
    {
        _722 = r_input_depth.read(uint2(_680), 0u).x;
    }
    else
    {
        _722 = 0.0;
    }
    float _725 = fast::clamp((cbDOF.cocScale * _722) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _733;
    if (all(_713 >= int2(0)))
    {
        _733 = all(_713 < int2(cbDOF.inputSize));
    }
    else
    {
        _733 = false;
    }
    float4 _739;
    if (_733)
    {
        _739 = r_input_color.read(uint2(_680), 0u);
    }
    else
    {
        _739 = float4(0.0);
    }
    int2 _744 = int2(_681);
    float _753;
    if (all(_681 < cbDOF.inputSize))
    {
        _753 = r_input_depth.read(uint2(_681), 0u).x;
    }
    else
    {
        _753 = 0.0;
    }
    float _756 = fast::clamp((cbDOF.cocScale * _753) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _764;
    if (all(_744 >= int2(0)))
    {
        _764 = all(_744 < int2(cbDOF.inputSize));
    }
    else
    {
        _764 = false;
    }
    float4 _770;
    if (_764)
    {
        _770 = r_input_color.read(uint2(_681), 0u);
    }
    else
    {
        _770 = float4(0.0);
    }
    int2 _775 = int2(_682);
    float _784;
    if (all(_682 < cbDOF.inputSize))
    {
        _784 = r_input_depth.read(uint2(_682), 0u).x;
    }
    else
    {
        _784 = 0.0;
    }
    float _787 = fast::clamp((cbDOF.cocScale * _784) + cbDOF.cocBias, _139, cbDOF.cocLimit);
    bool _795;
    if (all(_775 >= int2(0)))
    {
        _795 = all(_775 < int2(cbDOF.inputSize));
    }
    else
    {
        _795 = false;
    }
    float4 _801;
    if (_795)
    {
        _801 = r_input_color.read(uint2(_682), 0u);
    }
    else
    {
        _801 = float4(0.0);
    }
    float _809 = fast::clamp(1.0 - abs(_694 - _725), 0.0, 1.0);
    float _813 = fast::clamp(1.0 - abs(_694 - _756), 0.0, 1.0);
    float _817 = fast::clamp(1.0 - abs(_694 - _787), 0.0, 1.0);
    _81[3] = float4((((float4(_708.xyz, _694).xyz + (float4(_739.xyz, _725).xyz * _809)) + (float4(_770.xyz, _756).xyz * _813)) + (float4(_801.xyz, _787).xyz * _817)) / float3(((1.0 + _809) + _813) + _817), _694);
    do
    {
        bool _852;
        if (!any(_678 < int2(0)))
        {
            _852 = any(_678 >= max(int2(cbDOF.inputSizeHalf), int2(1)));
        }
        else
        {
            _852 = true;
        }
        if (_852)
        {
            break;
        }
        rw_internal_bilat_color_mip0.write(_81[3], uint2(uint2(_678)));
        break;
    } while(false);
    for (uint _858 = 0u; _858 < 4u; _858++)
    {
        spdIntermediateR[_98][_101] = _81[_858].x;
        spdIntermediateG[_98][_101] = _81[_858].y;
        spdIntermediateB[_98][_101] = _81[_858].z;
        spdIntermediateA[_98][_101] = _81[_858].w;
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (gl_LocalInvocationIndex < 64u)
        {
            uint _877 = _104 + 1u;
            uint _878 = _106 + 1u;
            float _918 = fast::clamp(1.0 - abs(spdIntermediateA[_104][_106] - spdIntermediateA[_877][_106]), 0.0, 1.0);
            float _922 = fast::clamp(1.0 - abs(spdIntermediateA[_104][_106] - spdIntermediateA[_104][_878]), 0.0, 1.0);
            float _926 = fast::clamp(1.0 - abs(spdIntermediateA[_104][_106] - spdIntermediateA[_877][_878]), 0.0, 1.0);
            _81[_858] = float4((((float4(spdIntermediateR[_104][_106], spdIntermediateG[_104][_106], spdIntermediateB[_104][_106], spdIntermediateA[_104][_106]).xyz + (float4(spdIntermediateR[_877][_106], spdIntermediateG[_877][_106], spdIntermediateB[_877][_106], spdIntermediateA[_877][_106]).xyz * _918)) + (float4(spdIntermediateR[_104][_878], spdIntermediateG[_104][_878], spdIntermediateB[_104][_878], spdIntermediateA[_104][_878]).xyz * _922)) + (float4(spdIntermediateR[_877][_878], spdIntermediateG[_877][_878], spdIntermediateB[_877][_878], spdIntermediateA[_877][_878]).xyz * _926)) / float3(((1.0 + _918) + _922) + _926), spdIntermediateA[_104][_106]);
            int2 _957 = int2(gl_WorkGroupID.xy * uint2(16u)) + int2(int(_98 + ((_858 % 2u) * 8u)), int(_101 + ((_858 / 2u) * 8u)));
            do
            {
                bool _973;
                if (!any(_957 < int2(0)))
                {
                    _973 = any(_957 >= max((int2(cbDOF.inputSizeHalf) >> int2(1)), int2(1)));
                }
                else
                {
                    _973 = true;
                }
                if (_973)
                {
                    break;
                }
                rw_internal_bilat_color_mip1.write(_81[_858], uint2(uint2(_957)));
                break;
            } while(false);
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }
    bool _978 = gl_LocalInvocationIndex < 64u;
    if (_978)
    {
        spdIntermediateR[_98][_101] = _81[0].x;
        spdIntermediateG[_98][_101] = _81[0].y;
        spdIntermediateB[_98][_101] = _81[0].z;
        spdIntermediateA[_98][_101] = _81[0].w;
        uint _990 = _98 + 8u;
        spdIntermediateR[_990][_101] = _81[1].x;
        spdIntermediateG[_990][_101] = _81[1].y;
        spdIntermediateB[_990][_101] = _81[1].z;
        spdIntermediateA[_990][_101] = _81[1].w;
        uint _1000 = _101 + 8u;
        spdIntermediateR[_98][_1000] = _81[2].x;
        spdIntermediateG[_98][_1000] = _81[2].y;
        spdIntermediateB[_98][_1000] = _81[2].z;
        spdIntermediateA[_98][_1000] = _81[2].w;
        spdIntermediateR[_990][_1000] = _81[3].x;
        spdIntermediateG[_990][_1000] = _81[3].y;
        spdIntermediateB[_990][_1000] = _81[3].z;
        spdIntermediateA[_990][_1000] = _81[3].w;
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (_978)
    {
        uint _1021 = _104 + 1u;
        uint _1022 = _106 + 1u;
        float _1024 = spdIntermediateR[_104][_106];
        float _1026 = spdIntermediateG[_104][_106];
        float _1033 = spdIntermediateR[_1021][_106];
        float _1035 = spdIntermediateG[_1021][_106];
        float _1042 = spdIntermediateR[_104][_1022];
        float _1044 = spdIntermediateG[_104][_1022];
        float _1051 = spdIntermediateR[_1021][_1022];
        float _1053 = spdIntermediateG[_1021][_1022];
        float _1062 = fast::clamp(1.0 - abs(spdIntermediateA[_104][_106] - spdIntermediateA[_1021][_106]), 0.0, 1.0);
        float _1066 = fast::clamp(1.0 - abs(spdIntermediateA[_104][_106] - spdIntermediateA[_104][_1022]), 0.0, 1.0);
        float _1070 = fast::clamp(1.0 - abs(spdIntermediateA[_104][_106] - spdIntermediateA[_1021][_1022]), 0.0, 1.0);
        float3 _1085 = (((float4(_1024, _1026, spdIntermediateB[_104][_106], spdIntermediateA[_104][_106]).xyz + (float4(_1033, _1035, spdIntermediateB[_1021][_106], spdIntermediateA[_1021][_106]).xyz * _1062)) + (float4(_1042, _1044, spdIntermediateB[_104][_1022], spdIntermediateA[_104][_1022]).xyz * _1066)) + (float4(_1051, _1053, spdIntermediateB[_1021][_1022], spdIntermediateA[_1021][_1022]).xyz * _1070)) / float3(((1.0 + _1062) + _1066) + _1070);
        float _1086 = _1085.x;
        int2 _1092 = int2(gl_WorkGroupID.xy * uint2(8u)) + _114;
        do
        {
            bool _1107;
            if (!any(_1092 < int2(0)))
            {
                _1107 = any(_1092 >= max((int2(cbDOF.inputSizeHalf) >> int2(2)), int2(1)));
            }
            else
            {
                _1107 = true;
            }
            if (_1107)
            {
                break;
            }
            rw_internal_bilat_color_mip2.write(float4(_1086, _1085.yz, spdIntermediateA[_104][_106]), uint2(uint2(_1092)));
            break;
        } while(false);
        uint _1113 = _104 + (_101 % 2u);
        spdIntermediateR[_1113][_106] = _1086;
        spdIntermediateG[_1113][_106] = _1085.y;
        spdIntermediateB[_1113][_106] = _1085.z;
        spdIntermediateA[_1113][_106] = spdIntermediateA[_104][_106];
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (gl_LocalInvocationIndex < 16u)
    {
        uint _1121 = _98 * 4u;
        uint _1122 = _101 * 4u;
        uint _1123 = _1121 + 2u;
        uint _1124 = _1121 + 1u;
        uint _1125 = _1122 + 2u;
        uint _1126 = _1121 + 3u;
        float _1166 = fast::clamp(1.0 - abs(spdIntermediateA[_1121][_1122] - spdIntermediateA[_1123][_1122]), 0.0, 1.0);
        float _1170 = fast::clamp(1.0 - abs(spdIntermediateA[_1121][_1122] - spdIntermediateA[_1124][_1125]), 0.0, 1.0);
        float _1174 = fast::clamp(1.0 - abs(spdIntermediateA[_1121][_1122] - spdIntermediateA[_1126][_1125]), 0.0, 1.0);
        float3 _1189 = (((float4(spdIntermediateR[_1121][_1122], spdIntermediateG[_1121][_1122], spdIntermediateB[_1121][_1122], spdIntermediateA[_1121][_1122]).xyz + (float4(spdIntermediateR[_1123][_1122], spdIntermediateG[_1123][_1122], spdIntermediateB[_1123][_1122], spdIntermediateA[_1123][_1122]).xyz * _1166)) + (float4(spdIntermediateR[_1124][_1125], spdIntermediateG[_1124][_1125], spdIntermediateB[_1124][_1125], spdIntermediateA[_1124][_1125]).xyz * _1170)) + (float4(spdIntermediateR[_1126][_1125], spdIntermediateG[_1126][_1125], spdIntermediateB[_1126][_1125], spdIntermediateA[_1126][_1125]).xyz * _1174)) / float3(((1.0 + _1166) + _1170) + _1174);
        float _1190 = _1189.x;
        int2 _1196 = int2(gl_WorkGroupID.xy * uint2(4u)) + _114;
        do
        {
            bool _1211;
            if (!any(_1196 < int2(0)))
            {
                _1211 = any(_1196 >= max((int2(cbDOF.inputSizeHalf) >> int2(3)), int2(1)));
            }
            else
            {
                _1211 = true;
            }
            if (_1211)
            {
                break;
            }
            rw_internal_bilat_color_mip3.write(float4(_1190, _1189.yz, spdIntermediateA[_1121][_1122]), uint2(uint2(_1196)));
            break;
        } while(false);
        uint _1216 = _1121 + _101;
        spdIntermediateR[_1216][_1122] = _1190;
        spdIntermediateG[_1216][_1122] = _1189.y;
        spdIntermediateB[_1216][_1122] = _1189.z;
        spdIntermediateA[_1216][_1122] = spdIntermediateA[_1121][_1122];
    }
}

)DOF_GPU";
inline constexpr Binding bindings2[]={{"cbDOF","buffer",0},{"rw_internal_globals","buffer",1},{"rw_internal_radius","texture",0},{"rw_internal_dilated_radius","texture",1}};
inline constexpr const char*source2=R"DOF_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct type_cbDOF
{
    float cocScale;
    float cocBias;
    uint2 inputSizeHalf;
    uint2 inputSize;
    float2 inputSizeHalfRcp;
    float cocLimit;
    uint maxRings;
};

struct DofGlobalVars
{
    uint maxTileRad;
};

struct type_RWStructuredBuffer_DofGlobalVars
{
    DofGlobalVars _m0[1];
};

kernel void CS(constant type_cbDOF& cbDOF [[buffer(0)]], volatile const device type_RWStructuredBuffer_DofGlobalVars& rw_internal_globals [[buffer(1)]], texture2d<float> rw_internal_radius [[texture(0)]], texture2d<float, access::write> rw_internal_dilated_radius [[texture(1)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    uint2 _53 = uint2(ceil(float2(cbDOF.inputSize) * float2(0.125)));
    int _56 = int(rw_internal_globals._m0[0u].maxTileRad);
    float2 _67;
    if (all(gl_GlobalInvocationID.xy < uint2(rw_internal_radius.get_width(), rw_internal_radius.get_height())))
    {
        _67 = rw_internal_radius.read(uint2(gl_GlobalInvocationID.xy)).xy;
    }
    else
    {
        _67 = float2(0.0);
    }
    float2 _68 = abs(_67);
    float _337;
    float _338;
    if (_56 > 0)
    {
        int _74 = -_56;
        int _75 = _56 * _56;
        bool _76 = _75 <= _75;
        float _140;
        float _141;
        if (_76)
        {
            int2 _81 = int2(gl_GlobalInvocationID.xy) + int2(_74, 0);
            int _82 = _81.x;
            bool _88;
            if (_82 >= 0)
            {
                _88 = _81.y >= 0;
            }
            else
            {
                _88 = false;
            }
            bool _94;
            if (_88)
            {
                _94 = uint(_82) < _53.x;
            }
            else
            {
                _94 = false;
            }
            bool _101;
            if (_94)
            {
                _101 = uint(_81.y) < _53.y;
            }
            else
            {
                _101 = false;
            }
            float _138;
            float _139;
            if (_101)
            {
                uint2 _104 = uint2(_81);
                float2 _115;
                if (all(_104 < uint2(rw_internal_radius.get_width(), rw_internal_radius.get_height())))
                {
                    _115 = rw_internal_radius.read(uint2(_104)).xy;
                }
                else
                {
                    _115 = float2(0.0);
                }
                uint2 _120 = uint2(ceil(abs(_115) * float2(0.25))) + uint2(1u);
                uint _121 = uint(_75);
                uint _122 = _120.x;
                float _129;
                if (_121 < (_122 * _122))
                {
                    _129 = precise::max(_67.x, _115.x);
                }
                else
                {
                    _129 = _67.x;
                }
                uint _130 = _120.y;
                float _137;
                if (_121 < (_130 * _130))
                {
                    _137 = precise::min(_67.y, _115.y);
                }
                else
                {
                    _137 = _67.y;
                }
                _138 = _137;
                _139 = _129;
            }
            else
            {
                _138 = _67.y;
                _139 = _67.x;
            }
            _140 = _138;
            _141 = _139;
        }
        else
        {
            _140 = _67.y;
            _141 = _67.x;
        }
        float _205;
        float _206;
        if (_76)
        {
            int2 _146 = int2(gl_GlobalInvocationID.xy) + int2(_56, 0);
            int _147 = _146.x;
            bool _153;
            if (_147 >= 0)
            {
                _153 = _146.y >= 0;
            }
            else
            {
                _153 = false;
            }
            bool _159;
            if (_153)
            {
                _159 = uint(_147) < _53.x;
            }
            else
            {
                _159 = false;
            }
            bool _166;
            if (_159)
            {
                _166 = uint(_146.y) < _53.y;
            }
            else
            {
                _166 = false;
            }
            float _203;
            float _204;
            if (_166)
            {
                uint2 _169 = uint2(_146);
                float2 _180;
                if (all(_169 < uint2(rw_internal_radius.get_width(), rw_internal_radius.get_height())))
                {
                    _180 = rw_internal_radius.read(uint2(_169)).xy;
                }
                else
                {
                    _180 = float2(0.0);
                }
                uint2 _185 = uint2(ceil(abs(_180) * float2(0.25))) + uint2(1u);
                uint _186 = uint(_75);
                uint _187 = _185.x;
                float _194;
                if (_186 < (_187 * _187))
                {
                    _194 = precise::max(_141, _180.x);
                }
                else
                {
                    _194 = _141;
                }
                uint _195 = _185.y;
                float _202;
                if (_186 < (_195 * _195))
                {
                    _202 = precise::min(_140, _180.y);
                }
                else
                {
                    _202 = _140;
                }
                _203 = _202;
                _204 = _194;
            }
            else
            {
                _203 = _140;
                _204 = _141;
            }
            _205 = _203;
            _206 = _204;
        }
        else
        {
            _205 = _140;
            _206 = _141;
        }
        float _270;
        float _271;
        if (_76)
        {
            int2 _211 = int2(gl_GlobalInvocationID.xy) + int2(0, _74);
            int _212 = _211.x;
            bool _218;
            if (_212 >= 0)
            {
                _218 = _211.y >= 0;
            }
            else
            {
                _218 = false;
            }
            bool _224;
            if (_218)
            {
                _224 = uint(_212) < _53.x;
            }
            else
            {
                _224 = false;
            }
            bool _231;
            if (_224)
            {
                _231 = uint(_211.y) < _53.y;
            }
            else
            {
                _231 = false;
            }
            float _268;
            float _269;
            if (_231)
            {
                uint2 _234 = uint2(_211);
                float2 _245;
                if (all(_234 < uint2(rw_internal_radius.get_width(), rw_internal_radius.get_height())))
                {
                    _245 = rw_internal_radius.read(uint2(_234)).xy;
                }
                else
                {
                    _245 = float2(0.0);
                }
                uint2 _250 = uint2(ceil(abs(_245) * float2(0.25))) + uint2(1u);
                uint _251 = uint(_75);
                uint _252 = _250.x;
                float _259;
                if (_251 < (_252 * _252))
                {
                    _259 = precise::max(_206, _245.x);
                }
                else
                {
                    _259 = _206;
                }
                uint _260 = _250.y;
                float _267;
                if (_251 < (_260 * _260))
                {
                    _267 = precise::min(_205, _245.y);
                }
                else
                {
                    _267 = _205;
                }
                _268 = _267;
                _269 = _259;
            }
            else
            {
                _268 = _205;
                _269 = _206;
            }
            _270 = _268;
            _271 = _269;
        }
        else
        {
            _270 = _205;
            _271 = _206;
        }
        float _335;
        float _336;
        if (_76)
        {
            int2 _276 = int2(gl_GlobalInvocationID.xy) + int2(0, _56);
            int _277 = _276.x;
            bool _283;
            if (_277 >= 0)
            {
                _283 = _276.y >= 0;
            }
            else
            {
                _283 = false;
            }
            bool _289;
            if (_283)
            {
                _289 = uint(_277) < _53.x;
            }
            else
            {
                _289 = false;
            }
            bool _296;
            if (_289)
            {
                _296 = uint(_276.y) < _53.y;
            }
            else
            {
                _296 = false;
            }
            float _333;
            float _334;
            if (_296)
            {
                uint2 _299 = uint2(_276);
                float2 _310;
                if (all(_299 < uint2(rw_internal_radius.get_width(), rw_internal_radius.get_height())))
                {
                    _310 = rw_internal_radius.read(uint2(_299)).xy;
                }
                else
                {
                    _310 = float2(0.0);
                }
                uint2 _315 = uint2(ceil(abs(_310) * float2(0.25))) + uint2(1u);
                uint _316 = uint(_75);
                uint _317 = _315.x;
                float _324;
                if (_316 < (_317 * _317))
                {
                    _324 = precise::max(_271, _310.x);
                }
                else
                {
                    _324 = _271;
                }
                uint _325 = _315.y;
                float _332;
                if (_316 < (_325 * _325))
                {
                    _332 = precise::min(_270, _310.y);
                }
                else
                {
                    _332 = _270;
                }
                _333 = _332;
                _334 = _324;
            }
            else
            {
                _333 = _270;
                _334 = _271;
            }
            _335 = _333;
            _336 = _334;
        }
        else
        {
            _335 = _270;
            _336 = _271;
        }
        _337 = _335;
        _338 = _336;
    }
    else
    {
        _337 = _67.y;
        _338 = _67.x;
    }
    int _339 = 1 - _56;
    float _341;
    float _344;
    _341 = _337;
    _344 = _338;
    float _342;
    float _345;
    for (int _346 = _339; _346 < _56; _341 = _342, _344 = _345, _346++)
    {
        _342 = _341;
        _345 = _344;
        float _352;
        float _354;
        for (int _355 = _339; _355 < _56; _342 = _352, _345 = _354, _355++)
        {
            bool _364;
            if (_346 == 0)
            {
                _364 = _355 == 0;
            }
            else
            {
                _364 = false;
            }
            if (_364)
            {
                _352 = _342;
                _354 = _345;
                continue;
            }
            int _369 = (_346 * _346) + (_355 * _355);
            float _435;
            float _436;
            if (_369 <= (_56 * _56))
            {
                int2 _376 = int2(gl_GlobalInvocationID.xy) + int2(_346, _355);
                int _377 = _376.x;
                bool _383;
                if (_377 >= 0)
                {
                    _383 = _376.y >= 0;
                }
                else
                {
                    _383 = false;
                }
                bool _389;
                if (_383)
                {
                    _389 = uint(_377) < _53.x;
                }
                else
                {
                    _389 = false;
                }
                bool _396;
                if (_389)
                {
                    _396 = uint(_376.y) < _53.y;
                }
                else
                {
                    _396 = false;
                }
                float _433;
                float _434;
                if (_396)
                {
                    uint2 _399 = uint2(_376);
                    float2 _410;
                    if (all(_399 < uint2(rw_internal_radius.get_width(), rw_internal_radius.get_height())))
                    {
                        _410 = rw_internal_radius.read(uint2(_399)).xy;
                    }
                    else
                    {
                        _410 = float2(0.0);
                    }
                    uint2 _415 = uint2(ceil(abs(_410) * float2(0.25))) + uint2(1u);
                    uint _416 = uint(_369);
                    uint _417 = _415.x;
                    float _424;
                    if (_416 < (_417 * _417))
                    {
                        _424 = precise::max(_345, _410.x);
                    }
                    else
                    {
                        _424 = _345;
                    }
                    uint _425 = _415.y;
                    float _432;
                    if (_416 < (_425 * _425))
                    {
                        _432 = precise::min(_342, _410.y);
                    }
                    else
                    {
                        _432 = _342;
                    }
                    _433 = _432;
                    _434 = _424;
                }
                else
                {
                    _433 = _342;
                    _434 = _345;
                }
                _435 = _433;
                _436 = _434;
            }
            else
            {
                _435 = _342;
                _436 = _345;
            }
            _352 = _435;
            _354 = _436;
        }
    }
    bool _443;
    if (_68.x < 0.5)
    {
        _443 = _68.y < 0.5;
    }
    else
    {
        _443 = false;
    }
    if (all(gl_GlobalInvocationID.xy < uint2(rw_internal_dilated_radius.get_width(), rw_internal_dilated_radius.get_height())))
    {
        rw_internal_dilated_radius.write(float2(_344, _443 ? _67.y : _341).xyyy, uint2(gl_GlobalInvocationID.xy));
    }
}

)DOF_GPU";
inline constexpr Binding bindings3[]={{"cbDOF","buffer",0},{"rw_internal_globals","buffer",1},{"r_internal_bilat_color","texture",0},{"r_internal_dilated_radius","texture",1},{"rw_internal_near","texture",2},{"rw_internal_far","texture",3},{"LinearSampler","sampler",0},{"PointSampler","sampler",1}};
inline constexpr const char*source3=R"DOF_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T>
inline T spvSubgroupBroadcastFirst(T value)
{
    return simd_broadcast_first(value);
}

template<>
inline bool spvSubgroupBroadcastFirst(bool value)
{
    return !!simd_broadcast_first((ushort)value);
}

template<uint N>
inline vec<bool, N> spvSubgroupBroadcastFirst(vec<bool, N> value)
{
    return (vec<bool, N>)simd_broadcast_first((vec<ushort, N>)value);
}

struct type_cbDOF
{
    float cocScale;
    float cocBias;
    uint2 inputSizeHalf;
    uint2 inputSize;
    float2 inputSizeHalfRcp;
    float cocLimit;
    uint maxRings;
};

struct DofGlobalVars
{
    uint maxTileRad;
};

struct type_RWStructuredBuffer_DofGlobalVars
{
    DofGlobalVars _m0[1];
};

constant float _81 = {};
constant uint _82 = {};
constant bool _83 = {};
constant float2 _84 = {};

kernel void CS(constant type_cbDOF& cbDOF [[buffer(0)]], volatile device type_RWStructuredBuffer_DofGlobalVars& rw_internal_globals [[buffer(1)]], texture2d<float> r_internal_bilat_color [[texture(0)]], texture2d<float> r_internal_dilated_radius [[texture(1)]], texture2d<float, access::write> rw_internal_near [[texture(2)]], texture2d<float, access::write> rw_internal_far [[texture(3)]], sampler LinearSampler [[sampler(0)]], sampler PointSampler [[sampler(1)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    do
    {
        float2 _100;
        rw_internal_globals._m0[0u].maxTileRad = 0u;
        float2 _179;
        float _180;
        float _181;
        uint _182;
        bool _183;
        uint _184;
        uint _185;
        float _186;
        float _187;
        float _188;
        bool _189;
        bool _190;
        bool _191;
        do
        {
            float2 _98 = float2(gl_GlobalInvocationID.xy);
            _100 = cbDOF.inputSizeHalfRcp;
            float4 _103 = r_internal_dilated_radius.sample(LinearSampler, (_98 * _100), level(0.0));
            float2 _105 = abs(_103.xy);
            float _108 = precise::max(_105.x, _105.y);
            if (simd_all(_108 < 0.5))
            {
                _179 = _84;
                _180 = _81;
                _181 = _81;
                _182 = _82;
                _183 = _83;
                _184 = _82;
                _185 = _82;
                _186 = _81;
                _187 = _81;
                _188 = _81;
                _189 = false;
                _190 = false;
                _191 = false;
                break;
            }
            float _114 = simd_max(ceil(_108));
            float _118 = float(cbDOF.maxRings);
            bool _119 = _114 > _118;
            uint _126;
            if (_119)
            {
                _126 = uint(log2(_114 * (1.0 / _118)));
            }
            else
            {
                _126 = 0u;
            }
            uint _127 = _119 ? cbDOF.maxRings : uint(_114);
            float _128 = float(_127);
            float3 _133 = (_98 + float2(0.25)).xyx * float3(0.103100001811981201171875, 0.10300000011920928955078125, 0.097300000488758087158203125);
            float3 _135 = _133 - floor(_133);
            float3 _140 = _135 + float3(dot(_135, _135.yzx + float3(33.3300018310546875)));
            float2 _145 = (_140.xx + _140.yz) * _140.zy;
            float4 _157;
            if (all(gl_GlobalInvocationID.xy < cbDOF.inputSizeHalf))
            {
                _157 = r_internal_bilat_color.read(uint2(gl_GlobalInvocationID.xy), 0u);
            }
            else
            {
                _157 = float4(0.0);
            }
            float _166 = 0.5 / _128;
            float _170 = _103.x;
            float _173 = _103.y;
            _179 = _98 + ((_145 - floor(_145)) * 0.5);
            _180 = _108;
            _181 = (_114 / _128) - 1.0;
            _182 = _126;
            _183 = _157.w > 0.0;
            _184 = uint(3.125 * float(_127 * (_127 + 1u)));
            _185 = _127;
            _186 = spvSubgroupBroadcastFirst(_166 * _108);
            _187 = spvSubgroupBroadcastFirst(_166);
            _188 = abs(_157.w);
            _189 = simd_all((_170 - _173) < 0.5);
            _190 = simd_any(_170 > (-1.0));
            _191 = simd_any(_173 < 1.0);
            break;
        } while(false);
        float _194 = fast::clamp(0.25 / (_188 * _188), 0.0, 1.0);
        bool _199 = all(gl_GlobalInvocationID.xy < cbDOF.inputSizeHalf);
        float4 _205;
        if (_199)
        {
            _205 = r_internal_bilat_color.read(uint2(gl_GlobalInvocationID.xy), 0u);
        }
        else
        {
            _205 = float4(0.0);
        }
        float4 _209 = float4(_205.xyz, 1.0);
        float4 _226;
        float4 _227;
        if (_183)
        {
            float _218 = precise::max(1.0, (_180 * (1.0 / float(_185))) - powr(2.0, float(_182)));
            float _220 = fast::clamp(_188, 0.0, 1.0);
            _226 = ((_209 * _194) * (_218 * _218)) * _220;
            _227 = _209 * (1.0 - _220);
        }
        else
        {
            _226 = float4(0.0);
            _227 = float4(0.0);
        }
        float4 _2765;
        float4 _2766;
        float4 _2767;
        float _2768;
        uint _2769;
        float _2770;
        if (_190 ? _191 : false)
        {
            float4 _233;
            float4 _236;
            float4 _238;
            float _240;
            uint _242;
            float _244;
            _233 = _226;
            _236 = _227;
            _238 = float4(0.0);
            _240 = 0.0;
            _242 = 0u;
            _244 = 0.0;
            float4 _239;
            float _241;
            uint _243;
            float _245;
            float4 _234;
            float4 _237;
            for (uint _246 = 0u; _246 < _185; _233 = _234, _236 = _237, _238 = _239, _240 = _241, _242 = _243, _244 = _245, _246++)
            {
                float _251 = float(_185);
                float _252 = 1.0 / _251;
                float _254 = float(_185 - _246);
                float _255 = _252 * _254;
                float _257 = _251 - float(_246);
                uint _259 = uint(6.25 * _257);
                float _260 = _180 * _252;
                float _265 = float(_259);
                float _266 = 6.283185482025146484375 / _265;
                float _267 = sin(_266);
                float _268 = cos(_266);
                float2 _271 = float2(cbDOF.inputSizeHalf) * _100.yx;
                float _273 = _267 * _271.x;
                float _274 = -_267;
                float _276 = _274 * _271.y;
                float2 _285 = _100 * ((_179 - (float2(_268, _267) * _179.x)) - (float2(_274, _268) * _179.y));
                float _286 = _260 * _254;
                float _294 = ((float((_185 - 1u) - _246) + 2.5) * _180) * (1.0 / (0.5 + _251));
                float _295 = _286 - _181;
                float _297 = precise::max(0.0, _295 - 0.5);
                float _298 = precise::max(0.0, _295);
                float _299 = _188 - _286;
                float _301 = 1.0 / (_286 * _286);
                float4 _303;
                float4 _306;
                float2 _308;
                float4 _310;
                float4 _312;
                float _314;
                uint _316;
                float _318;
                uint _320;
                uint _322;
                _303 = _233;
                _306 = _236;
                _308 = _100 * (_179 + float2(_260 * _257, 0.0));
                _310 = float4(0.0);
                _312 = _238;
                _314 = 0.0;
                _316 = _242;
                _318 = _244;
                _320 = 0u;
                _322 = 0u;
                float4 _304;
                float2 _309;
                float4 _307;
                float4 _311;
                float4 _313;
                float _315;
                uint _317;
                float _319;
                uint _321;
                uint _323;
                for (;;)
                {
                    _323 = _322 + 2u;
                    if (_323 <= _259)
                    {
                        float2 _336 = float2((_268 * _308.x) + (_276 * _308.y), (_273 * _308.x) + (_268 * _308.y)) + _285;
                        uint2 _338 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                        float2 _345 = float2(max((cbDOF.inputSizeHalf >> (uint2(_182) & uint2(31u))), uint2(1u)));
                        float2 _346 = float2(0.5) / _345;
                        float2 _347 = float2(1.0) - _346;
                        float _356 = float(_182);
                        float4 _358 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_308, _346, _347) * _345) / float2(float(_338.x), float(_338.y))), level(_356));
                        float _359 = _358.w;
                        float _360 = -_359;
                        float _363 = abs(_359);
                        float _366 = fast::clamp((_186 / _363) + _187, 0.0, 1.0);
                        float4 _374 = float4(_358.xyz, 1.0) * fast::clamp(0.25 / (_363 * _363), 0.0, 1.0);
                        float4 _375 = _374 * fast::clamp(_360 - _298, 0.0, 1.0);
                        uint _386;
                        float4 _387;
                        float _388;
                        uint _389;
                        float4 _390;
                        float _391;
                        if (_360 >= _294)
                        {
                            _386 = _316 + 1u;
                            _387 = _312 + _375;
                            _388 = _318 + _366;
                            _389 = _320;
                            _390 = _310;
                            _391 = _314;
                        }
                        else
                        {
                            _386 = _316;
                            _387 = _312;
                            _388 = _318;
                            _389 = _320 + 1u;
                            _390 = _310 + _375;
                            _391 = _314 + _366;
                        }
                        float4 _401;
                        if (_183)
                        {
                            _401 = _306 + ((_374 * _301) * ((_359 < _299) ? 1.0 : 0.00048828125));
                        }
                        else
                        {
                            _401 = _306;
                        }
                        float _404 = _336.x;
                        float _406 = _336.y;
                        _309 = float2((_268 * _404) + (_276 * _406), (_273 * _404) + (_268 * _406)) + _285;
                        uint2 _414 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                        float4 _426 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_336, _346, _347) * _345) / float2(float(_414.x), float(_414.y))), level(_356));
                        float _427 = _426.w;
                        float _428 = -_427;
                        float _431 = abs(_427);
                        float _434 = fast::clamp((_186 / _431) + _187, 0.0, 1.0);
                        float4 _442 = float4(_426.xyz, 1.0) * fast::clamp(0.25 / (_431 * _431), 0.0, 1.0);
                        float4 _443 = _442 * fast::clamp(_428 - _298, 0.0, 1.0);
                        if (_428 >= _294)
                        {
                            _317 = _386 + 1u;
                            _313 = _387 + _443;
                            _319 = _388 + _434;
                            _321 = _389;
                            _311 = _390;
                            _315 = _391;
                        }
                        else
                        {
                            _317 = _386;
                            _313 = _387;
                            _319 = _388;
                            _321 = _389 + 1u;
                            _311 = _390 + _443;
                            _315 = _391 + _434;
                        }
                        if (_183)
                        {
                            _307 = _401 + ((_442 * _301) * ((_427 < _299) ? 1.0 : 0.00048828125));
                        }
                        else
                        {
                            _307 = _401;
                        }
                        _304 = (_303 + (_374 * fast::clamp(_359 - _297, 0.0, 1.0))) + (_442 * fast::clamp(_427 - _297, 0.0, 1.0));
                        _303 = _304;
                        _306 = _307;
                        _308 = _309;
                        _310 = _311;
                        _312 = _313;
                        _314 = _315;
                        _316 = _317;
                        _318 = _319;
                        _320 = _321;
                        _322 = _323;
                        continue;
                    }
                    else
                    {
                        break;
                    }
                }
                float2 _468;
                float4 _470;
                float4 _472;
                float _474;
                uint _476;
                float _478;
                uint _480;
                _234 = _303;
                _237 = _306;
                _468 = _308;
                _470 = _310;
                _472 = _312;
                _474 = _314;
                _476 = _316;
                _478 = _318;
                _480 = _320;
                float4 _465;
                float2 _469;
                float4 _467;
                float4 _471;
                float4 _473;
                float _475;
                uint _477;
                float _479;
                uint _481;
                for (uint _482 = _322; _482 < _259; _234 = _465, _237 = _467, _468 = _469, _470 = _471, _472 = _473, _474 = _475, _476 = _477, _478 = _479, _480 = _481, _482++)
                {
                    _469 = float2((_268 * _468.x) + (_276 * _468.y), (_273 * _468.x) + (_268 * _468.y)) + _285;
                    uint2 _497 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                    float2 _504 = float2(max((cbDOF.inputSizeHalf >> (uint2(_182) & uint2(31u))), uint2(1u)));
                    float2 _505 = float2(0.5) / _504;
                    float4 _517 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_468, _505, float2(1.0) - _505) * _504) / float2(float(_497.x), float(_497.y))), level(float(_182)));
                    float _518 = _517.w;
                    float _519 = -_518;
                    float _522 = abs(_518);
                    float _525 = fast::clamp((_186 / _522) + _187, 0.0, 1.0);
                    float4 _533 = float4(_517.xyz, 1.0) * fast::clamp(0.25 / (_522 * _522), 0.0, 1.0);
                    float4 _534 = _533 * fast::clamp(_519 - _298, 0.0, 1.0);
                    if (_519 >= _294)
                    {
                        _471 = _470;
                        _473 = _472 + _534;
                        _475 = _474;
                        _477 = _476 + 1u;
                        _479 = _478 + _525;
                        _481 = _480;
                    }
                    else
                    {
                        _471 = _470 + _534;
                        _473 = _472;
                        _475 = _474 + _525;
                        _477 = _476;
                        _479 = _478;
                        _481 = _480 + 1u;
                    }
                    if (_183)
                    {
                        _467 = _237 + ((_533 * _301) * ((_518 < _299) ? 1.0 : 0.00048828125));
                    }
                    else
                    {
                        _467 = _237;
                    }
                    _465 = _234 + (_533 * fast::clamp(_518 - _297, 0.0, 1.0));
                }
                float _555 = float(_480);
                float _557 = float(_476);
                float _559 = fast::clamp(_478 / _557, 0.0, 1.0);
                float _561 = fast::clamp(_474 / _555, 0.0, 1.0);
                float _563 = fast::clamp(_240 + _559, 0.0, 1.0);
                float _564 = _240 - _559;
                float _566 = fast::clamp(_255 + _561, 0.0, 1.0);
                float _567 = _255 - _561;
                float _568 = precise::min(_563, _566);
                float _569 = precise::max(_564, _567);
                float _590;
                if (_568 < _569)
                {
                    _590 = 0.0;
                }
                else
                {
                    _590 = fast::clamp(((_568 * _568) - ((float(int(sign(_569))) * _569) * _569)) / ((_563 * _563) - ((float(int(sign(_564))) * _564) * _564)), 0.0, 1.0);
                }
                float _592 = 1.0 - ((_555 / _265) * _590);
                _239 = (_472 * _592) + _470;
                float _594 = precise::max(_563, _566);
                float _595 = precise::min(_564, _567);
                _241 = 0.5 * (_594 + _595);
                _243 = uint(_557 * _592) + _480;
                _245 = float(_243) * (0.5 * (_594 - _595));
            }
            _2765 = _233;
            _2766 = _236;
            _2767 = _238;
            _2768 = _240;
            _2769 = _242;
            _2770 = _244;
        }
        else
        {
            float4 _2759;
            float4 _2760;
            float4 _2761;
            float _2762;
            uint _2763;
            float _2764;
            if (_190)
            {
                float4 _1269;
                float4 _1270;
                if (_189)
                {
                    float4 _609;
                    _609 = _226;
                    float4 _610;
                    uint _613;
                    for (uint _612 = 0u; _612 < _185; _609 = _610, _612 = _613)
                    {
                        uint _621 = min(min((1u << (_612 & 31u)), 2u), (_185 - _612));
                        float _623 = float(_621);
                        float _628 = float(_185);
                        float _629 = _628 - ((float(_612) + (0.5 * _623)) - 0.5);
                        uint _631 = uint(6.25 * _629);
                        float _634 = (_180 * (1.0 / _628)) * _629;
                        float _640 = (6.283185482025146484375 / float(_631)) * _623;
                        float _641 = sin(_640);
                        float _642 = cos(_640);
                        float2 _645 = float2(cbDOF.inputSizeHalf) * _100.yx;
                        float _647 = _641 * _645.x;
                        float _648 = -_641;
                        float _650 = _648 * _645.y;
                        float2 _659 = _100 * ((_179 - (float2(_642, _641) * _179.x)) - (float2(_648, _642) * _179.y));
                        uint _660 = _631 / _621;
                        uint _663 = 2u * uint(log2(_623));
                        float _666 = precise::max(0.0, (_634 - _181) - 0.5);
                        float2 _668;
                        float _671;
                        float3 _673;
                        uint _675;
                        _668 = _100 * (_179 + float2(_634, 0.0));
                        _671 = 0.0;
                        _673 = float3(0.0);
                        _675 = 0u;
                        uint _676;
                        for (;;)
                        {
                            _676 = _675 + 6u;
                            if (_676 <= _660)
                            {
                                float2 _688 = float2((_642 * _668.x) + (_650 * _668.y), (_647 * _668.x) + (_642 * _668.y)) + _659;
                                uint _689 = _182 + _663;
                                uint2 _691 = uint2(r_internal_bilat_color.get_width(_689), r_internal_bilat_color.get_height(_689));
                                float2 _698 = float2(max((cbDOF.inputSizeHalf >> (uint2(_689) & uint2(31u))), uint2(1u)));
                                float2 _699 = float2(0.5) / _698;
                                float2 _700 = float2(1.0) - _699;
                                float _709 = float(_689);
                                float4 _711 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_668, _699, _700) * _698) / float2(float(_691.x), float(_691.y))), level(_709));
                                float _715 = fast::clamp(_711.w - _666, 0.0, 1.0);
                                float _719 = _688.x;
                                float _721 = _688.y;
                                float2 _728 = float2((_642 * _719) + (_650 * _721), (_647 * _719) + (_642 * _721)) + _659;
                                uint2 _730 = uint2(r_internal_bilat_color.get_width(_689), r_internal_bilat_color.get_height(_689));
                                float4 _742 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_688, _699, _700) * _698) / float2(float(_730.x), float(_730.y))), level(_709));
                                float _746 = fast::clamp(_742.w - _666, 0.0, 1.0);
                                float _750 = _728.x;
                                float _752 = _728.y;
                                float2 _759 = float2((_642 * _750) + (_650 * _752), (_647 * _750) + (_642 * _752)) + _659;
                                uint2 _761 = uint2(r_internal_bilat_color.get_width(_689), r_internal_bilat_color.get_height(_689));
                                float4 _773 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_728, _699, _700) * _698) / float2(float(_761.x), float(_761.y))), level(_709));
                                float _777 = fast::clamp(_773.w - _666, 0.0, 1.0);
                                float _781 = _759.x;
                                float _783 = _759.y;
                                float2 _790 = float2((_642 * _781) + (_650 * _783), (_647 * _781) + (_642 * _783)) + _659;
                                uint2 _792 = uint2(r_internal_bilat_color.get_width(_689), r_internal_bilat_color.get_height(_689));
                                float4 _804 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_759, _699, _700) * _698) / float2(float(_792.x), float(_792.y))), level(_709));
                                float _808 = fast::clamp(_804.w - _666, 0.0, 1.0);
                                float _812 = _790.x;
                                float _814 = _790.y;
                                float2 _821 = float2((_642 * _812) + (_650 * _814), (_647 * _812) + (_642 * _814)) + _659;
                                uint2 _823 = uint2(r_internal_bilat_color.get_width(_689), r_internal_bilat_color.get_height(_689));
                                float4 _835 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_790, _699, _700) * _698) / float2(float(_823.x), float(_823.y))), level(_709));
                                float _839 = fast::clamp(_835.w - _666, 0.0, 1.0);
                                float _843 = _821.x;
                                float _845 = _821.y;
                                uint2 _853 = uint2(r_internal_bilat_color.get_width(_689), r_internal_bilat_color.get_height(_689));
                                float4 _865 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_821, _699, _700) * _698) / float2(float(_853.x), float(_853.y))), level(_709));
                                float _869 = fast::clamp(_865.w - _666, 0.0, 1.0);
                                _668 = float2((_642 * _843) + (_650 * _845), (_647 * _843) + (_642 * _845)) + _659;
                                _671 = (((((_671 + _715) + _746) + _777) + _808) + _839) + _869;
                                _673 = (((((_673 + (_711.xyz * _715)) + (_742.xyz * _746)) + (_773.xyz * _777)) + (_804.xyz * _808)) + (_835.xyz * _839)) + (_865.xyz * _869);
                                _675 = _676;
                                continue;
                            }
                            else
                            {
                                break;
                            }
                        }
                        float2 _872;
                        float _875;
                        float3 _877;
                        _872 = _668;
                        _875 = _671;
                        _877 = _673;
                        for (uint _879 = _675; _879 < _660; )
                        {
                            uint _892 = _182 + _663;
                            uint2 _894 = uint2(r_internal_bilat_color.get_width(_892), r_internal_bilat_color.get_height(_892));
                            float2 _901 = float2(max((cbDOF.inputSizeHalf >> (uint2(_892) & uint2(31u))), uint2(1u)));
                            float2 _902 = float2(0.5) / _901;
                            float2 _904 = fast::clamp(_872, _902, float2(1.0) - _902);
                            float4 _914 = r_internal_bilat_color.sample(PointSampler, ((_904 * _901) / float2(float(_894.x), float(_894.y))), level(float(_892)));
                            float _918 = fast::clamp(_914.w - _666, 0.0, 1.0);
                            _872 = float2((_642 * _872.x) + (_650 * _872.y), (_647 * _872.x) + (_642 * _872.y)) + _659;
                            _875 += _918;
                            _877 += (_914.xyz * _918);
                            _879++;
                            continue;
                        }
                        float _920 = float(_621 * _621);
                        float3 _923 = _609.xyz + (_877 * _920);
                        _610 = float4(_923.x, _923.y, _923.z, _609.w);
                        _610.w = _609.w + (_875 * _920);
                        _613 = _612 + _621;
                    }
                    _1269 = _609;
                    _1270 = _227;
                }
                else
                {
                    float4 _932;
                    float4 _934;
                    _932 = _226;
                    _934 = _227;
                    float4 _933;
                    float4 _935;
                    for (uint _929 = 0u; _929 < _185; _929++, _932 = _933, _934 = _935)
                    {
                        float _940 = float(_185);
                        float _941 = _940 - float(_929);
                        uint _943 = uint(6.25 * _941);
                        float _945 = _180 * (1.0 / _940);
                        float _951 = 6.283185482025146484375 / float(_943);
                        float _952 = sin(_951);
                        float _953 = cos(_951);
                        float2 _956 = float2(cbDOF.inputSizeHalf) * _100.yx;
                        float _958 = _952 * _956.x;
                        float _959 = -_952;
                        float _961 = _959 * _956.y;
                        float2 _970 = _100 * ((_179 - (float2(_953, _952) * _179.x)) - (float2(_959, _953) * _179.y));
                        float _973 = _945 * float(_185 - _929);
                        float _976 = precise::max(0.0, (_973 - _181) - 0.5);
                        float _977 = _188 - _973;
                        float _979 = 1.0 / (_973 * _973);
                        float4 _981;
                        float4 _984;
                        float2 _986;
                        uint _988;
                        _981 = _932;
                        _984 = _934;
                        _986 = _100 * (_179 + float2(_945 * _941, 0.0));
                        _988 = 0u;
                        float4 _982;
                        float2 _987;
                        float4 _985;
                        uint _989;
                        for (;;)
                        {
                            _989 = _988 + 4u;
                            if (_989 <= _943)
                            {
                                float2 _1002 = float2((_953 * _986.x) + (_961 * _986.y), (_958 * _986.x) + (_953 * _986.y)) + _970;
                                uint2 _1004 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                float2 _1011 = float2(max((cbDOF.inputSizeHalf >> (uint2(_182) & uint2(31u))), uint2(1u)));
                                float2 _1012 = float2(0.5) / _1011;
                                float2 _1013 = float2(1.0) - _1012;
                                float _1022 = float(_182);
                                float4 _1024 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_986, _1012, _1013) * _1011) / float2(float(_1004.x), float(_1004.y))), level(_1022));
                                float _1025 = _1024.w;
                                float _1028 = abs(_1025);
                                float _1031 = fast::clamp(0.25 / (_1028 * _1028), 0.0, 1.0);
                                float4 _1044;
                                if (_183)
                                {
                                    _1044 = _984 + (((float4(_1024.xyz, 1.0) * _1031) * _979) * ((_1025 < _977) ? 1.0 : 0.00048828125));
                                }
                                else
                                {
                                    _1044 = _984;
                                }
                                float _1052 = _1002.x;
                                float _1054 = _1002.y;
                                float2 _1061 = float2((_953 * _1052) + (_961 * _1054), (_958 * _1052) + (_953 * _1054)) + _970;
                                uint2 _1063 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                float4 _1075 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1002, _1012, _1013) * _1011) / float2(float(_1063.x), float(_1063.y))), level(_1022));
                                float _1076 = _1075.w;
                                float _1079 = abs(_1076);
                                float _1082 = fast::clamp(0.25 / (_1079 * _1079), 0.0, 1.0);
                                float4 _1095;
                                if (_183)
                                {
                                    _1095 = _1044 + (((float4(_1075.xyz, 1.0) * _1082) * _979) * ((_1076 < _977) ? 1.0 : 0.00048828125));
                                }
                                else
                                {
                                    _1095 = _1044;
                                }
                                float _1103 = _1061.x;
                                float _1105 = _1061.y;
                                float2 _1112 = float2((_953 * _1103) + (_961 * _1105), (_958 * _1103) + (_953 * _1105)) + _970;
                                uint2 _1114 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                float4 _1126 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1061, _1012, _1013) * _1011) / float2(float(_1114.x), float(_1114.y))), level(_1022));
                                float _1127 = _1126.w;
                                float _1130 = abs(_1127);
                                float _1133 = fast::clamp(0.25 / (_1130 * _1130), 0.0, 1.0);
                                float4 _1146;
                                if (_183)
                                {
                                    _1146 = _1095 + (((float4(_1126.xyz, 1.0) * _1133) * _979) * ((_1127 < _977) ? 1.0 : 0.00048828125));
                                }
                                else
                                {
                                    _1146 = _1095;
                                }
                                float _1154 = _1112.x;
                                float _1156 = _1112.y;
                                _987 = float2((_953 * _1154) + (_961 * _1156), (_958 * _1154) + (_953 * _1156)) + _970;
                                uint2 _1164 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                float4 _1176 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1112, _1012, _1013) * _1011) / float2(float(_1164.x), float(_1164.y))), level(_1022));
                                float _1177 = _1176.w;
                                float _1180 = abs(_1177);
                                float _1183 = fast::clamp(0.25 / (_1180 * _1180), 0.0, 1.0);
                                if (_183)
                                {
                                    _985 = _1146 + (((float4(_1176.xyz, 1.0) * _1183) * _979) * ((_1177 < _977) ? 1.0 : 0.00048828125));
                                }
                                else
                                {
                                    _985 = _1146;
                                }
                                _982 = (((_981 + ((float4(_1024.xyz, 1.0) * _1031) * fast::clamp(_1025 - _976, 0.0, 1.0))) + ((float4(_1075.xyz, 1.0) * _1082) * fast::clamp(_1076 - _976, 0.0, 1.0))) + ((float4(_1126.xyz, 1.0) * _1133) * fast::clamp(_1127 - _976, 0.0, 1.0))) + ((float4(_1176.xyz, 1.0) * _1183) * fast::clamp(_1177 - _976, 0.0, 1.0));
                                _981 = _982;
                                _984 = _985;
                                _986 = _987;
                                _988 = _989;
                                continue;
                            }
                            else
                            {
                                break;
                            }
                        }
                        float2 _1206;
                        _933 = _981;
                        _935 = _984;
                        _1206 = _986;
                        float4 _1203;
                        float2 _1207;
                        float4 _1205;
                        for (uint _1208 = _988; _1208 < _943; _933 = _1203, _935 = _1205, _1206 = _1207, _1208++)
                        {
                            _1207 = float2((_953 * _1206.x) + (_961 * _1206.y), (_958 * _1206.x) + (_953 * _1206.y)) + _970;
                            uint2 _1223 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                            float2 _1230 = float2(max((cbDOF.inputSizeHalf >> (uint2(_182) & uint2(31u))), uint2(1u)));
                            float2 _1231 = float2(0.5) / _1230;
                            float4 _1243 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1206, _1231, float2(1.0) - _1231) * _1230) / float2(float(_1223.x), float(_1223.y))), level(float(_182)));
                            float _1244 = _1243.w;
                            float _1247 = abs(_1244);
                            float _1250 = fast::clamp(0.25 / (_1247 * _1247), 0.0, 1.0);
                            if (_183)
                            {
                                _1205 = _935 + (((float4(_1243.xyz, 1.0) * _1250) * _979) * ((_1244 < _977) ? 1.0 : 0.00048828125));
                            }
                            else
                            {
                                _1205 = _935;
                            }
                            _1203 = _933 + ((float4(_1243.xyz, 1.0) * _1250) * fast::clamp(_1244 - _976, 0.0, 1.0));
                        }
                    }
                    _1269 = _932;
                    _1270 = _934;
                }
                _2759 = _1269;
                _2760 = _1270;
                _2761 = float4(0.0);
                _2762 = 0.0;
                _2763 = 0u;
                _2764 = 0.0;
            }
            else
            {
                float4 _2739;
                float _2740;
                uint _2741;
                float _2742;
                if (_191)
                {
                    if (_189)
                    {
                        float4 _1797;
                        float _1798;
                        uint _1799;
                        if (0u < _185)
                        {
                            uint _1280 = min(1u, _185);
                            float _1281 = float(_1280);
                            float _1285 = float(_185);
                            float _1286 = _1285 - ((0.5 * _1281) - 0.5);
                            uint _1288 = uint(6.25 * _1286);
                            float _1291 = (_180 * (1.0 / _1285)) * _1286;
                            float _1297 = (6.283185482025146484375 / float(_1288)) * _1281;
                            float _1298 = sin(_1297);
                            float _1299 = cos(_1297);
                            float2 _1302 = float2(cbDOF.inputSizeHalf) * _100.yx;
                            float _1304 = _1298 * _1302.x;
                            float _1305 = -_1298;
                            float _1307 = _1305 * _1302.y;
                            float2 _1316 = _100 * ((_179 - (float2(_1299, _1298) * _179.x)) - (float2(_1305, _1299) * _179.y));
                            uint _1317 = _1288 / _1280;
                            uint _1320 = 2u * uint(log2(_1281));
                            float _1322 = precise::max(0.0, _1291 - _181);
                            float2 _1324;
                            float _1327;
                            float3 _1329;
                            uint _1331;
                            _1324 = _100 * (_179 + float2(_1291, 0.0));
                            _1327 = 0.0;
                            _1329 = float3(0.0);
                            _1331 = 0u;
                            uint _1332;
                            for (;;)
                            {
                                _1332 = _1331 + 8u;
                                if (_1332 <= _1317)
                                {
                                    float2 _1344 = float2((_1299 * _1324.x) + (_1307 * _1324.y), (_1304 * _1324.x) + (_1299 * _1324.y)) + _1316;
                                    uint _1345 = _182 + _1320;
                                    uint2 _1347 = uint2(r_internal_bilat_color.get_width(_1345), r_internal_bilat_color.get_height(_1345));
                                    float2 _1354 = float2(max((cbDOF.inputSizeHalf >> (uint2(_1345) & uint2(31u))), uint2(1u)));
                                    float2 _1355 = float2(0.5) / _1354;
                                    float2 _1356 = float2(1.0) - _1355;
                                    float _1365 = float(_1345);
                                    float4 _1367 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1324, _1355, _1356) * _1354) / float2(float(_1347.x), float(_1347.y))), level(_1365));
                                    float _1372 = fast::clamp((-_1367.w) - _1322, 0.0, 1.0);
                                    float _1376 = _1344.x;
                                    float _1378 = _1344.y;
                                    float2 _1385 = float2((_1299 * _1376) + (_1307 * _1378), (_1304 * _1376) + (_1299 * _1378)) + _1316;
                                    uint2 _1387 = uint2(r_internal_bilat_color.get_width(_1345), r_internal_bilat_color.get_height(_1345));
                                    float4 _1399 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1344, _1355, _1356) * _1354) / float2(float(_1387.x), float(_1387.y))), level(_1365));
                                    float _1404 = fast::clamp((-_1399.w) - _1322, 0.0, 1.0);
                                    float _1408 = _1385.x;
                                    float _1410 = _1385.y;
                                    float2 _1417 = float2((_1299 * _1408) + (_1307 * _1410), (_1304 * _1408) + (_1299 * _1410)) + _1316;
                                    uint2 _1419 = uint2(r_internal_bilat_color.get_width(_1345), r_internal_bilat_color.get_height(_1345));
                                    float4 _1431 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1385, _1355, _1356) * _1354) / float2(float(_1419.x), float(_1419.y))), level(_1365));
                                    float _1436 = fast::clamp((-_1431.w) - _1322, 0.0, 1.0);
                                    float _1440 = _1417.x;
                                    float _1442 = _1417.y;
                                    float2 _1449 = float2((_1299 * _1440) + (_1307 * _1442), (_1304 * _1440) + (_1299 * _1442)) + _1316;
                                    uint2 _1451 = uint2(r_internal_bilat_color.get_width(_1345), r_internal_bilat_color.get_height(_1345));
                                    float4 _1463 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1417, _1355, _1356) * _1354) / float2(float(_1451.x), float(_1451.y))), level(_1365));
                                    float _1468 = fast::clamp((-_1463.w) - _1322, 0.0, 1.0);
                                    float _1472 = _1449.x;
                                    float _1474 = _1449.y;
                                    float2 _1481 = float2((_1299 * _1472) + (_1307 * _1474), (_1304 * _1472) + (_1299 * _1474)) + _1316;
                                    uint2 _1483 = uint2(r_internal_bilat_color.get_width(_1345), r_internal_bilat_color.get_height(_1345));
                                    float4 _1495 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1449, _1355, _1356) * _1354) / float2(float(_1483.x), float(_1483.y))), level(_1365));
                                    float _1500 = fast::clamp((-_1495.w) - _1322, 0.0, 1.0);
                                    float _1504 = _1481.x;
                                    float _1506 = _1481.y;
                                    float2 _1513 = float2((_1299 * _1504) + (_1307 * _1506), (_1304 * _1504) + (_1299 * _1506)) + _1316;
                                    uint2 _1515 = uint2(r_internal_bilat_color.get_width(_1345), r_internal_bilat_color.get_height(_1345));
                                    float4 _1527 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1481, _1355, _1356) * _1354) / float2(float(_1515.x), float(_1515.y))), level(_1365));
                                    float _1532 = fast::clamp((-_1527.w) - _1322, 0.0, 1.0);
                                    float _1536 = _1513.x;
                                    float _1538 = _1513.y;
                                    float2 _1545 = float2((_1299 * _1536) + (_1307 * _1538), (_1304 * _1536) + (_1299 * _1538)) + _1316;
                                    uint2 _1547 = uint2(r_internal_bilat_color.get_width(_1345), r_internal_bilat_color.get_height(_1345));
                                    float4 _1559 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1513, _1355, _1356) * _1354) / float2(float(_1547.x), float(_1547.y))), level(_1365));
                                    float _1564 = fast::clamp((-_1559.w) - _1322, 0.0, 1.0);
                                    float _1568 = _1545.x;
                                    float _1570 = _1545.y;
                                    uint2 _1578 = uint2(r_internal_bilat_color.get_width(_1345), r_internal_bilat_color.get_height(_1345));
                                    float4 _1590 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1545, _1355, _1356) * _1354) / float2(float(_1578.x), float(_1578.y))), level(_1365));
                                    float _1595 = fast::clamp((-_1590.w) - _1322, 0.0, 1.0);
                                    _1324 = float2((_1299 * _1568) + (_1307 * _1570), (_1304 * _1568) + (_1299 * _1570)) + _1316;
                                    _1327 = (((((((_1327 + _1372) + _1404) + _1436) + _1468) + _1500) + _1532) + _1564) + _1595;
                                    _1329 = (((((((_1329 + (_1367.xyz * _1372)) + (_1399.xyz * _1404)) + (_1431.xyz * _1436)) + (_1463.xyz * _1468)) + (_1495.xyz * _1500)) + (_1527.xyz * _1532)) + (_1559.xyz * _1564)) + (_1590.xyz * _1595);
                                    _1331 = _1332;
                                    continue;
                                }
                                else
                                {
                                    break;
                                }
                            }
                            float2 _1598;
                            float _1601;
                            float3 _1603;
                            uint _1605;
                            _1598 = _1324;
                            _1601 = _1327;
                            _1603 = _1329;
                            _1605 = _1331;
                            uint _1606;
                            for (;;)
                            {
                                _1606 = _1605 + 4u;
                                if (_1606 <= _1317)
                                {
                                    float2 _1618 = float2((_1299 * _1598.x) + (_1307 * _1598.y), (_1304 * _1598.x) + (_1299 * _1598.y)) + _1316;
                                    uint _1619 = _182 + _1320;
                                    uint2 _1621 = uint2(r_internal_bilat_color.get_width(_1619), r_internal_bilat_color.get_height(_1619));
                                    float2 _1628 = float2(max((cbDOF.inputSizeHalf >> (uint2(_1619) & uint2(31u))), uint2(1u)));
                                    float2 _1629 = float2(0.5) / _1628;
                                    float2 _1630 = float2(1.0) - _1629;
                                    float2 _1631 = fast::clamp(_1598, _1629, _1630);
                                    float _1639 = float(_1619);
                                    float4 _1641 = r_internal_bilat_color.sample(PointSampler, ((_1631 * _1628) / float2(float(_1621.x), float(_1621.y))), level(_1639));
                                    float _1646 = fast::clamp((-_1641.w) - _1322, 0.0, 1.0);
                                    float _1650 = _1618.x;
                                    float _1652 = _1618.y;
                                    float2 _1659 = float2((_1299 * _1650) + (_1307 * _1652), (_1304 * _1650) + (_1299 * _1652)) + _1316;
                                    uint2 _1661 = uint2(r_internal_bilat_color.get_width(_1619), r_internal_bilat_color.get_height(_1619));
                                    float4 _1673 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1618, _1629, _1630) * _1628) / float2(float(_1661.x), float(_1661.y))), level(_1639));
                                    float _1678 = fast::clamp((-_1673.w) - _1322, 0.0, 1.0);
                                    float _1682 = _1659.x;
                                    float _1684 = _1659.y;
                                    float2 _1691 = float2((_1299 * _1682) + (_1307 * _1684), (_1304 * _1682) + (_1299 * _1684)) + _1316;
                                    uint2 _1693 = uint2(r_internal_bilat_color.get_width(_1619), r_internal_bilat_color.get_height(_1619));
                                    float4 _1705 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1659, _1629, _1630) * _1628) / float2(float(_1693.x), float(_1693.y))), level(_1639));
                                    float _1710 = fast::clamp((-_1705.w) - _1322, 0.0, 1.0);
                                    float _1714 = _1691.x;
                                    float _1716 = _1691.y;
                                    uint2 _1724 = uint2(r_internal_bilat_color.get_width(_1619), r_internal_bilat_color.get_height(_1619));
                                    float4 _1736 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1691, _1629, _1630) * _1628) / float2(float(_1724.x), float(_1724.y))), level(_1639));
                                    float _1741 = fast::clamp((-_1736.w) - _1322, 0.0, 1.0);
                                    _1598 = float2((_1299 * _1714) + (_1307 * _1716), (_1304 * _1714) + (_1299 * _1716)) + _1316;
                                    _1601 = (((_1601 + _1646) + _1678) + _1710) + _1741;
                                    _1603 = (((_1603 + (_1641.xyz * _1646)) + (_1673.xyz * _1678)) + (_1705.xyz * _1710)) + (_1736.xyz * _1741);
                                    _1605 = _1606;
                                    continue;
                                }
                                else
                                {
                                    break;
                                }
                            }
                            float2 _1744;
                            float _1747;
                            float3 _1749;
                            _1744 = _1598;
                            _1747 = _1601;
                            _1749 = _1603;
                            for (uint _1751 = _1605; _1751 < _1317; )
                            {
                                uint _1764 = _182 + _1320;
                                uint2 _1766 = uint2(r_internal_bilat_color.get_width(_1764), r_internal_bilat_color.get_height(_1764));
                                float2 _1773 = float2(max((cbDOF.inputSizeHalf >> (uint2(_1764) & uint2(31u))), uint2(1u)));
                                float2 _1774 = float2(0.5) / _1773;
                                float2 _1776 = fast::clamp(_1744, _1774, float2(1.0) - _1774);
                                float4 _1786 = r_internal_bilat_color.sample(PointSampler, ((_1776 * _1773) / float2(float(_1766.x), float(_1766.y))), level(float(_1764)));
                                float _1791 = fast::clamp((-_1786.w) - _1322, 0.0, 1.0);
                                _1744 = float2((_1299 * _1744.x) + (_1307 * _1744.y), (_1304 * _1744.x) + (_1299 * _1744.y)) + _1316;
                                _1747 += _1791;
                                _1749 += (_1786.xyz * _1791);
                                _1751++;
                                continue;
                            }
                            float _1793 = float(_1280 * _1280);
                            float3 _1794 = _1749 * _1793;
                            _1797 = float4(_1794.x, _1794.y, _1794.z, float4(0.0).w);
                            _1798 = _1747 * _1793;
                            _1799 = _1280;
                        }
                        else
                        {
                            _1797 = float4(0.0);
                            _1798 = 0.0;
                            _1799 = 0u;
                        }
                        float4 _1801;
                        float _1804;
                        _1801 = _1797;
                        _1804 = _1798;
                        float4 _1802;
                        float _1805;
                        uint _1807;
                        for (uint _1806 = _1799; _1806 < _185; _1801 = _1802, _1804 = _1805, _1806 = _1807)
                        {
                            uint _1815 = min(min((1u << (_1806 & 31u)), 2u), (_185 - _1806));
                            float _1817 = float(_1815);
                            uint _1821 = _1815 * _1815;
                            float _1822 = float(_185);
                            float _1823 = _1822 - ((float(_1806) + (0.5 * _1817)) - 0.5);
                            uint _1825 = uint(6.25 * _1823);
                            float _1834 = (6.283185482025146484375 / float(_1825)) * _1817;
                            float _1835 = sin(_1834);
                            float _1836 = cos(_1834);
                            float2 _1839 = float2(cbDOF.inputSizeHalf) * _100.yx;
                            float _1841 = _1835 * _1839.x;
                            float _1842 = -_1835;
                            float _1844 = _1842 * _1839.y;
                            float2 _1853 = _100 * ((_179 - (float2(_1836, _1835) * _179.x)) - (float2(_1842, _1836) * _179.y));
                            uint _1854 = _1825 / _1815;
                            uint _1857 = 2u * uint(log2(_1817));
                            float2 _1859;
                            float3 _1862;
                            uint _1864;
                            _1859 = _100 * (_179 + float2((_180 * (1.0 / _1822)) * _1823, 0.0));
                            _1862 = float3(0.0);
                            _1864 = 0u;
                            uint _1865;
                            for (;;)
                            {
                                _1865 = _1864 + 12u;
                                if (_1865 <= _1854)
                                {
                                    float2 _1877 = float2((_1836 * _1859.x) + (_1844 * _1859.y), (_1841 * _1859.x) + (_1836 * _1859.y)) + _1853;
                                    uint _1878 = _182 + _1857;
                                    uint2 _1880 = uint2(r_internal_bilat_color.get_width(_1878), r_internal_bilat_color.get_height(_1878));
                                    float2 _1887 = float2(max((cbDOF.inputSizeHalf >> (uint2(_1878) & uint2(31u))), uint2(1u)));
                                    float2 _1888 = float2(0.5) / _1887;
                                    float2 _1889 = float2(1.0) - _1888;
                                    float _1898 = float(_1878);
                                    float _1903 = _1877.x;
                                    float _1905 = _1877.y;
                                    float2 _1912 = float2((_1836 * _1903) + (_1844 * _1905), (_1841 * _1903) + (_1836 * _1905)) + _1853;
                                    uint2 _1914 = uint2(r_internal_bilat_color.get_width(_1878), r_internal_bilat_color.get_height(_1878));
                                    float _1929 = _1912.x;
                                    float _1931 = _1912.y;
                                    float2 _1938 = float2((_1836 * _1929) + (_1844 * _1931), (_1841 * _1929) + (_1836 * _1931)) + _1853;
                                    uint2 _1940 = uint2(r_internal_bilat_color.get_width(_1878), r_internal_bilat_color.get_height(_1878));
                                    float _1955 = _1938.x;
                                    float _1957 = _1938.y;
                                    float2 _1964 = float2((_1836 * _1955) + (_1844 * _1957), (_1841 * _1955) + (_1836 * _1957)) + _1853;
                                    uint2 _1966 = uint2(r_internal_bilat_color.get_width(_1878), r_internal_bilat_color.get_height(_1878));
                                    float _1981 = _1964.x;
                                    float _1983 = _1964.y;
                                    float2 _1990 = float2((_1836 * _1981) + (_1844 * _1983), (_1841 * _1981) + (_1836 * _1983)) + _1853;
                                    uint2 _1992 = uint2(r_internal_bilat_color.get_width(_1878), r_internal_bilat_color.get_height(_1878));
                                    float _2007 = _1990.x;
                                    float _2009 = _1990.y;
                                    float2 _2016 = float2((_1836 * _2007) + (_1844 * _2009), (_1841 * _2007) + (_1836 * _2009)) + _1853;
                                    uint2 _2018 = uint2(r_internal_bilat_color.get_width(_1878), r_internal_bilat_color.get_height(_1878));
                                    float3 _2032 = (((((_1862 + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1859, _1888, _1889) * _1887) / float2(float(_1880.x), float(_1880.y))), level(_1898)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1877, _1888, _1889) * _1887) / float2(float(_1914.x), float(_1914.y))), level(_1898)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1912, _1888, _1889) * _1887) / float2(float(_1940.x), float(_1940.y))), level(_1898)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1938, _1888, _1889) * _1887) / float2(float(_1966.x), float(_1966.y))), level(_1898)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1964, _1888, _1889) * _1887) / float2(float(_1992.x), float(_1992.y))), level(_1898)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1990, _1888, _1889) * _1887) / float2(float(_2018.x), float(_2018.y))), level(_1898)).xyz;
                                    float _2033 = _2016.x;
                                    float _2035 = _2016.y;
                                    float2 _2042 = float2((_1836 * _2033) + (_1844 * _2035), (_1841 * _2033) + (_1836 * _2035)) + _1853;
                                    uint2 _2044 = uint2(r_internal_bilat_color.get_width(_1878), r_internal_bilat_color.get_height(_1878));
                                    float _2059 = _2042.x;
                                    float _2061 = _2042.y;
                                    float2 _2068 = float2((_1836 * _2059) + (_1844 * _2061), (_1841 * _2059) + (_1836 * _2061)) + _1853;
                                    uint2 _2070 = uint2(r_internal_bilat_color.get_width(_1878), r_internal_bilat_color.get_height(_1878));
                                    float _2085 = _2068.x;
                                    float _2087 = _2068.y;
                                    float2 _2094 = float2((_1836 * _2085) + (_1844 * _2087), (_1841 * _2085) + (_1836 * _2087)) + _1853;
                                    uint2 _2096 = uint2(r_internal_bilat_color.get_width(_1878), r_internal_bilat_color.get_height(_1878));
                                    float _2111 = _2094.x;
                                    float _2113 = _2094.y;
                                    float2 _2120 = float2((_1836 * _2111) + (_1844 * _2113), (_1841 * _2111) + (_1836 * _2113)) + _1853;
                                    uint2 _2122 = uint2(r_internal_bilat_color.get_width(_1878), r_internal_bilat_color.get_height(_1878));
                                    float _2137 = _2120.x;
                                    float _2139 = _2120.y;
                                    float2 _2146 = float2((_1836 * _2137) + (_1844 * _2139), (_1841 * _2137) + (_1836 * _2139)) + _1853;
                                    uint2 _2148 = uint2(r_internal_bilat_color.get_width(_1878), r_internal_bilat_color.get_height(_1878));
                                    float _2163 = _2146.x;
                                    float _2165 = _2146.y;
                                    uint2 _2173 = uint2(r_internal_bilat_color.get_width(_1878), r_internal_bilat_color.get_height(_1878));
                                    float3 _1863 = (((((_2032 + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2016, _1888, _1889) * _1887) / float2(float(_2044.x), float(_2044.y))), level(_1898)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2042, _1888, _1889) * _1887) / float2(float(_2070.x), float(_2070.y))), level(_1898)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2068, _1888, _1889) * _1887) / float2(float(_2096.x), float(_2096.y))), level(_1898)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2094, _1888, _1889) * _1887) / float2(float(_2122.x), float(_2122.y))), level(_1898)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2120, _1888, _1889) * _1887) / float2(float(_2148.x), float(_2148.y))), level(_1898)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2146, _1888, _1889) * _1887) / float2(float(_2173.x), float(_2173.y))), level(_1898)).xyz;
                                    _1859 = float2((_1836 * _2163) + (_1844 * _2165), (_1841 * _2163) + (_1836 * _2165)) + _1853;
                                    _1862 = _1863;
                                    _1864 = _1865;
                                    continue;
                                }
                                else
                                {
                                    break;
                                }
                            }
                            float2 _2188;
                            float3 _2191;
                            uint _2193;
                            _2188 = _1859;
                            _2191 = _1862;
                            _2193 = _1864;
                            uint _2194;
                            for (;;)
                            {
                                _2194 = _2193 + 4u;
                                if (_2194 <= _1854)
                                {
                                    float2 _2206 = float2((_1836 * _2188.x) + (_1844 * _2188.y), (_1841 * _2188.x) + (_1836 * _2188.y)) + _1853;
                                    uint _2207 = _182 + _1857;
                                    uint2 _2209 = uint2(r_internal_bilat_color.get_width(_2207), r_internal_bilat_color.get_height(_2207));
                                    float2 _2216 = float2(max((cbDOF.inputSizeHalf >> (uint2(_2207) & uint2(31u))), uint2(1u)));
                                    float2 _2217 = float2(0.5) / _2216;
                                    float2 _2218 = float2(1.0) - _2217;
                                    float2 _2219 = fast::clamp(_2188, _2217, _2218);
                                    float _2227 = float(_2207);
                                    float _2232 = _2206.x;
                                    float _2234 = _2206.y;
                                    float2 _2241 = float2((_1836 * _2232) + (_1844 * _2234), (_1841 * _2232) + (_1836 * _2234)) + _1853;
                                    uint2 _2243 = uint2(r_internal_bilat_color.get_width(_2207), r_internal_bilat_color.get_height(_2207));
                                    float _2258 = _2241.x;
                                    float _2260 = _2241.y;
                                    float2 _2267 = float2((_1836 * _2258) + (_1844 * _2260), (_1841 * _2258) + (_1836 * _2260)) + _1853;
                                    uint2 _2269 = uint2(r_internal_bilat_color.get_width(_2207), r_internal_bilat_color.get_height(_2207));
                                    float _2284 = _2267.x;
                                    float _2286 = _2267.y;
                                    uint2 _2294 = uint2(r_internal_bilat_color.get_width(_2207), r_internal_bilat_color.get_height(_2207));
                                    _2188 = float2((_1836 * _2284) + (_1844 * _2286), (_1841 * _2284) + (_1836 * _2286)) + _1853;
                                    _2191 = (((_2191 + r_internal_bilat_color.sample(PointSampler, ((_2219 * _2216) / float2(float(_2209.x), float(_2209.y))), level(_2227)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2206, _2217, _2218) * _2216) / float2(float(_2243.x), float(_2243.y))), level(_2227)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2241, _2217, _2218) * _2216) / float2(float(_2269.x), float(_2269.y))), level(_2227)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2267, _2217, _2218) * _2216) / float2(float(_2294.x), float(_2294.y))), level(_2227)).xyz;
                                    _2193 = _2194;
                                    continue;
                                }
                                else
                                {
                                    break;
                                }
                            }
                            float2 _2309;
                            float3 _2312;
                            _2309 = _2188;
                            _2312 = _2191;
                            for (uint _2314 = _2193; _2314 < _1854; )
                            {
                                uint _2327 = _182 + _1857;
                                uint2 _2329 = uint2(r_internal_bilat_color.get_width(_2327), r_internal_bilat_color.get_height(_2327));
                                float2 _2336 = float2(max((cbDOF.inputSizeHalf >> (uint2(_2327) & uint2(31u))), uint2(1u)));
                                float2 _2337 = float2(0.5) / _2336;
                                float2 _2339 = fast::clamp(_2309, _2337, float2(1.0) - _2337);
                                _2309 = float2((_1836 * _2309.x) + (_1844 * _2309.y), (_1841 * _2309.x) + (_1836 * _2309.y)) + _1853;
                                _2312 += r_internal_bilat_color.sample(PointSampler, ((_2339 * _2336) / float2(float(_2329.x), float(_2329.y))), level(float(_2327))).xyz;
                                _2314++;
                                continue;
                            }
                            float3 _2354 = _1801.xyz + (_2312 * float(_1821));
                            _1802 = float4(_2354.x, _2354.y, _2354.z, _1801.w);
                            _1805 = _1804 + float(_1854 * _1821);
                            _1807 = _1806 + _1815;
                        }
                        float4 _2357 = _1801;
                        _2357.w = _1804;
                        _2739 = _2357;
                        _2740 = 0.0;
                        _2741 = uint(_1804);
                        _2742 = _1804;
                    }
                    else
                    {
                        float4 _2360;
                        float _2363;
                        uint _2365;
                        float _2367;
                        _2360 = float4(0.0);
                        _2363 = 0.0;
                        _2365 = 0u;
                        _2367 = 0.0;
                        float4 _2361;
                        float _2364;
                        uint _2366;
                        float _2368;
                        for (uint _2369 = 0u; _2369 < _185; _2360 = _2361, _2363 = _2364, _2365 = _2366, _2367 = _2368, _2369++)
                        {
                            float _2374 = float(_185);
                            float _2375 = 1.0 / _2374;
                            float _2377 = float(_185 - _2369);
                            float _2378 = _2375 * _2377;
                            float _2380 = _2374 - float(_2369);
                            uint _2382 = uint(6.25 * _2380);
                            float _2383 = _180 * _2375;
                            float _2388 = float(_2382);
                            float _2389 = 6.283185482025146484375 / _2388;
                            float _2390 = sin(_2389);
                            float _2391 = cos(_2389);
                            float2 _2394 = float2(cbDOF.inputSizeHalf) * _100.yx;
                            float _2396 = _2390 * _2394.x;
                            float _2397 = -_2390;
                            float _2399 = _2397 * _2394.y;
                            float2 _2408 = _100 * ((_179 - (float2(_2391, _2390) * _179.x)) - (float2(_2397, _2391) * _179.y));
                            float _2417 = ((float((_185 - 1u) - _2369) + 2.5) * _180) * (1.0 / (0.5 + _2374));
                            float _2419 = precise::max(0.0, (_2383 * _2377) - _181);
                            float2 _2421;
                            float4 _2424;
                            float4 _2426;
                            float _2428;
                            uint _2430;
                            float _2432;
                            uint _2434;
                            uint _2436;
                            _2421 = _100 * (_179 + float2(_2383 * _2380, 0.0));
                            _2424 = float4(0.0);
                            _2426 = _2360;
                            _2428 = 0.0;
                            _2430 = _2365;
                            _2432 = _2367;
                            _2434 = 0u;
                            _2436 = 0u;
                            float2 _2422;
                            float4 _2425;
                            float4 _2427;
                            float _2429;
                            uint _2431;
                            float _2433;
                            uint _2435;
                            uint _2437;
                            for (;;)
                            {
                                _2437 = _2436 + 3u;
                                if (_2437 <= _2382)
                                {
                                    float2 _2450 = float2((_2391 * _2421.x) + (_2399 * _2421.y), (_2396 * _2421.x) + (_2391 * _2421.y)) + _2408;
                                    uint2 _2452 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                    float2 _2459 = float2(max((cbDOF.inputSizeHalf >> (uint2(_182) & uint2(31u))), uint2(1u)));
                                    float2 _2460 = float2(0.5) / _2459;
                                    float2 _2461 = float2(1.0) - _2460;
                                    float _2470 = float(_182);
                                    float4 _2472 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2421, _2460, _2461) * _2459) / float2(float(_2452.x), float(_2452.y))), level(_2470));
                                    float _2473 = _2472.w;
                                    float _2474 = -_2473;
                                    float _2477 = abs(_2473);
                                    float _2480 = fast::clamp((_186 / _2477) + _187, 0.0, 1.0);
                                    float4 _2489 = (float4(_2472.xyz, 1.0) * fast::clamp(0.25 / (_2477 * _2477), 0.0, 1.0)) * fast::clamp(_2474 - _2419, 0.0, 1.0);
                                    uint _2500;
                                    float4 _2501;
                                    float _2502;
                                    uint _2503;
                                    float4 _2504;
                                    float _2505;
                                    if (_2474 >= _2417)
                                    {
                                        _2500 = _2430 + 1u;
                                        _2501 = _2426 + _2489;
                                        _2502 = _2432 + _2480;
                                        _2503 = _2434;
                                        _2504 = _2424;
                                        _2505 = _2428;
                                    }
                                    else
                                    {
                                        _2500 = _2430;
                                        _2501 = _2426;
                                        _2502 = _2432;
                                        _2503 = _2434 + 1u;
                                        _2504 = _2424 + _2489;
                                        _2505 = _2428 + _2480;
                                    }
                                    float _2506 = _2450.x;
                                    float _2508 = _2450.y;
                                    float2 _2515 = float2((_2391 * _2506) + (_2399 * _2508), (_2396 * _2506) + (_2391 * _2508)) + _2408;
                                    uint2 _2517 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                    float4 _2529 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2450, _2460, _2461) * _2459) / float2(float(_2517.x), float(_2517.y))), level(_2470));
                                    float _2530 = _2529.w;
                                    float _2531 = -_2530;
                                    float _2534 = abs(_2530);
                                    float _2537 = fast::clamp((_186 / _2534) + _187, 0.0, 1.0);
                                    float4 _2546 = (float4(_2529.xyz, 1.0) * fast::clamp(0.25 / (_2534 * _2534), 0.0, 1.0)) * fast::clamp(_2531 - _2419, 0.0, 1.0);
                                    uint _2557;
                                    float4 _2558;
                                    float _2559;
                                    uint _2560;
                                    float4 _2561;
                                    float _2562;
                                    if (_2531 >= _2417)
                                    {
                                        _2557 = _2500 + 1u;
                                        _2558 = _2501 + _2546;
                                        _2559 = _2502 + _2537;
                                        _2560 = _2503;
                                        _2561 = _2504;
                                        _2562 = _2505;
                                    }
                                    else
                                    {
                                        _2557 = _2500;
                                        _2558 = _2501;
                                        _2559 = _2502;
                                        _2560 = _2503 + 1u;
                                        _2561 = _2504 + _2546;
                                        _2562 = _2505 + _2537;
                                    }
                                    float _2563 = _2515.x;
                                    float _2565 = _2515.y;
                                    _2422 = float2((_2391 * _2563) + (_2399 * _2565), (_2396 * _2563) + (_2391 * _2565)) + _2408;
                                    uint2 _2573 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                    float4 _2585 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2515, _2460, _2461) * _2459) / float2(float(_2573.x), float(_2573.y))), level(_2470));
                                    float _2586 = _2585.w;
                                    float _2587 = -_2586;
                                    float _2590 = abs(_2586);
                                    float _2593 = fast::clamp((_186 / _2590) + _187, 0.0, 1.0);
                                    float4 _2602 = (float4(_2585.xyz, 1.0) * fast::clamp(0.25 / (_2590 * _2590), 0.0, 1.0)) * fast::clamp(_2587 - _2419, 0.0, 1.0);
                                    if (_2587 >= _2417)
                                    {
                                        _2431 = _2557 + 1u;
                                        _2427 = _2558 + _2602;
                                        _2433 = _2559 + _2593;
                                        _2435 = _2560;
                                        _2425 = _2561;
                                        _2429 = _2562;
                                    }
                                    else
                                    {
                                        _2431 = _2557;
                                        _2427 = _2558;
                                        _2433 = _2559;
                                        _2435 = _2560 + 1u;
                                        _2425 = _2561 + _2602;
                                        _2429 = _2562 + _2593;
                                    }
                                    _2421 = _2422;
                                    _2424 = _2425;
                                    _2426 = _2427;
                                    _2428 = _2429;
                                    _2430 = _2431;
                                    _2432 = _2433;
                                    _2434 = _2435;
                                    _2436 = _2437;
                                    continue;
                                }
                                else
                                {
                                    break;
                                }
                            }
                            float2 _2614;
                            float4 _2617;
                            float4 _2619;
                            float _2621;
                            uint _2623;
                            float _2625;
                            uint _2627;
                            _2614 = _2421;
                            _2617 = _2424;
                            _2619 = _2426;
                            _2621 = _2428;
                            _2623 = _2430;
                            _2625 = _2432;
                            _2627 = _2434;
                            float2 _2615;
                            float4 _2618;
                            float4 _2620;
                            float _2622;
                            uint _2624;
                            float _2626;
                            uint _2628;
                            for (uint _2629 = _2436; _2629 < _2382; _2614 = _2615, _2617 = _2618, _2619 = _2620, _2621 = _2622, _2623 = _2624, _2625 = _2626, _2627 = _2628, _2629++)
                            {
                                _2615 = float2((_2391 * _2614.x) + (_2399 * _2614.y), (_2396 * _2614.x) + (_2391 * _2614.y)) + _2408;
                                uint2 _2644 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                float2 _2651 = float2(max((cbDOF.inputSizeHalf >> (uint2(_182) & uint2(31u))), uint2(1u)));
                                float2 _2652 = float2(0.5) / _2651;
                                float4 _2664 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2614, _2652, float2(1.0) - _2652) * _2651) / float2(float(_2644.x), float(_2644.y))), level(float(_182)));
                                float _2665 = _2664.w;
                                float _2666 = -_2665;
                                float _2669 = abs(_2665);
                                float _2672 = fast::clamp((_186 / _2669) + _187, 0.0, 1.0);
                                float4 _2681 = (float4(_2664.xyz, 1.0) * fast::clamp(0.25 / (_2669 * _2669), 0.0, 1.0)) * fast::clamp(_2666 - _2419, 0.0, 1.0);
                                if (_2666 >= _2417)
                                {
                                    _2618 = _2617;
                                    _2620 = _2619 + _2681;
                                    _2622 = _2621;
                                    _2624 = _2623 + 1u;
                                    _2626 = _2625 + _2672;
                                    _2628 = _2627;
                                }
                                else
                                {
                                    _2618 = _2617 + _2681;
                                    _2620 = _2619;
                                    _2622 = _2621 + _2672;
                                    _2624 = _2623;
                                    _2626 = _2625;
                                    _2628 = _2627 + 1u;
                                }
                            }
                            float _2692 = float(_2627);
                            float _2694 = float(_2623);
                            float _2696 = fast::clamp(_2625 / _2694, 0.0, 1.0);
                            float _2698 = fast::clamp(_2621 / _2692, 0.0, 1.0);
                            float _2700 = fast::clamp(_2363 + _2696, 0.0, 1.0);
                            float _2701 = _2363 - _2696;
                            float _2703 = fast::clamp(_2378 + _2698, 0.0, 1.0);
                            float _2704 = _2378 - _2698;
                            float _2705 = precise::min(_2700, _2703);
                            float _2706 = precise::max(_2701, _2704);
                            float _2727;
                            if (_2705 < _2706)
                            {
                                _2727 = 0.0;
                            }
                            else
                            {
                                _2727 = fast::clamp(((_2705 * _2705) - ((float(int(sign(_2706))) * _2706) * _2706)) / ((_2700 * _2700) - ((float(int(sign(_2701))) * _2701) * _2701)), 0.0, 1.0);
                            }
                            float _2729 = 1.0 - ((_2692 / _2388) * _2727);
                            _2361 = (_2619 * _2729) + _2617;
                            float _2731 = precise::max(_2700, _2703);
                            float _2732 = precise::min(_2701, _2704);
                            _2364 = 0.5 * (_2731 + _2732);
                            _2366 = uint(_2694 * _2729) + _2627;
                            _2368 = float(_2366) * (0.5 * (_2731 - _2732));
                        }
                        _2739 = _2360;
                        _2740 = _2363;
                        _2741 = _2365;
                        _2742 = _2367;
                    }
                }
                else
                {
                    float4 _2748;
                    if (_199)
                    {
                        _2748 = r_internal_bilat_color.read(uint2(gl_GlobalInvocationID.xy), 0u);
                    }
                    else
                    {
                        _2748 = float4(0.0);
                    }
                    if (_199)
                    {
                        rw_internal_far.write(float4(_2748.xyz, 1.0), uint2(gl_GlobalInvocationID.xy));
                    }
                    if (_199)
                    {
                        rw_internal_near.write(float4(0.0), uint2(gl_GlobalInvocationID.xy));
                    }
                    break;
                }
                _2759 = _226;
                _2760 = _227;
                _2761 = _2739;
                _2762 = _2740;
                _2763 = _2741;
                _2764 = _2742;
            }
            _2765 = _2759;
            _2766 = _2760;
            _2767 = _2761;
            _2768 = _2762;
            _2769 = _2763;
            _2770 = _2764;
        }
        float4 _2776;
        if (_183)
        {
            _2776 = float4(0.0);
        }
        else
        {
            _2776 = _209 * _194;
        }
        float _2779 = fast::clamp(_2770 / float(_2769), 0.0, 1.0);
        float _2780 = fast::clamp(_183 ? 0.0 : fast::clamp((_186 / _188) + _187, 0.0, 1.0), 0.0, 1.0);
        float _2782 = fast::clamp(_2768 + _2779, 0.0, 1.0);
        float _2783 = _2768 - _2779;
        float _2786 = precise::min(_2782, fast::clamp(_2780, 0.0, 1.0));
        float _2787 = precise::max(_2783, -_2780);
        float _2808;
        if (_2786 < _2787)
        {
            _2808 = 0.0;
        }
        else
        {
            _2808 = fast::clamp(((_2786 * _2786) - ((float(int(sign(_2787))) * _2787) * _2787)) / ((_2782 * _2782) - ((float(int(sign(_2783))) * _2783) * _2783)), 0.0, 1.0);
        }
        float4 _2811 = (_2767 * (1.0 - _2808)) + _2776;
        float4 _2815;
        if (_183)
        {
            _2815 = _2811 + _2766;
        }
        else
        {
            _2815 = _2811;
        }
        float _2829;
        if ((!_191) ? _189 : false)
        {
            _2829 = 1.0;
        }
        else
        {
            _2829 = fast::clamp(_2765.w / (fast::clamp(0.25 / (_180 * _180), 0.0, 1.0) * float(_184)), 0.0, 1.0);
        }
        float4 _2832 = _2815 / float4(_2815.w);
        float3 _2841 = _2765.xyz / float3(_2765.w);
        if (_199)
        {
            rw_internal_far.write(select(float4(0.0), _2832, bool4(!any(isnan(_2832)))), uint2(gl_GlobalInvocationID.xy));
        }
        if (_199)
        {
            rw_internal_near.write(float4(select(float3(0.0), _2841, bool3(!any(isnan(_2841)))), _2829), uint2(gl_GlobalInvocationID.xy));
        }
        break;
    } while(false);
}

)DOF_GPU";
inline constexpr Binding bindings4[]={{"cbDOF","buffer",0},{"r_input_depth","texture",0},{"r_input_color","texture",1},{"r_internal_dilated_radius","texture",2},{"rw_internal_near","texture",3},{"rw_internal_far","texture",4},{"rw_output_color","texture",5}};
inline constexpr const char*source4=R"DOF_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

template<typename T>
inline T spvSubgroupShuffle(T value, ushort lane)
{
    return simd_shuffle(value, lane);
}

template<>
inline bool spvSubgroupShuffle(bool value, ushort lane)
{
    return !!simd_shuffle((ushort)value, lane);
}

template<uint N>
inline vec<bool, N> spvSubgroupShuffle(vec<bool, N> value, ushort lane)
{
    return (vec<bool, N>)simd_shuffle((vec<ushort, N>)value, lane);
}

template<>
inline ulong spvSubgroupShuffle(ulong value, ushort lane)
{
    return as_type<ulong>(spvSubgroupShuffle(as_type<uint2>(value), lane));
}

template<>
inline ulong2 spvSubgroupShuffle(ulong2 value, ushort lane)
{
    return ulong2(spvSubgroupShuffle(value.x, lane), spvSubgroupShuffle(value.y, lane));
}

inline ulong3 spvSubgroupShuffle(ulong3 value, ushort lane)
{
    return ulong3(spvSubgroupShuffle(value.xy, lane), spvSubgroupShuffle(value.z, lane));
}

inline ulong4 spvSubgroupShuffle(ulong4 value, ushort lane)
{
    return ulong4(spvSubgroupShuffle(value.xy, lane), spvSubgroupShuffle(value.zw, lane));
}

template<uint N>
inline vec<long, N> spvSubgroupShuffle(vec<long, N> value, ushort lane)
{
    return vec<long, N>(spvSubgroupShuffle(vec<ulong, N>(value), lane));
}

struct type_cbDOF
{
    float cocScale;
    float cocBias;
    uint2 inputSizeHalf;
    uint2 inputSize;
    float2 inputSizeHalfRcp;
    float cocLimit;
    uint maxRings;
};

constant float _122 = {};

kernel void CS(constant type_cbDOF& cbDOF [[buffer(0)]], texture2d<float> r_input_depth [[texture(0)]], texture2d<float> r_input_color [[texture(1)]], texture2d<float> r_internal_dilated_radius [[texture(2)]], texture2d<float> rw_internal_near [[texture(3)]], texture2d<float> rw_internal_far [[texture(4)]], texture2d<float, access::write> rw_output_color [[texture(5)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]], uint gl_LocalInvocationIndex [[thread_index_in_threadgroup]], uint gl_SubgroupSize [[thread_execution_width]], uint gl_SubgroupInvocationID [[thread_index_in_simdgroup]])
{
    threadgroup spvUnsafeArray<float, 121> FfxDofLDSNearLuma;
    threadgroup spvUnsafeArray<float, 121> FfxDofLDSFarLuma;
    threadgroup spvUnsafeArray<float, 121> FfxDofLDSNearR;
    threadgroup spvUnsafeArray<float, 121> FfxDofLDSNearG;
    threadgroup spvUnsafeArray<float, 121> FfxDofLDSNearB;
    threadgroup spvUnsafeArray<float, 121> FfxDofLDSNearA;
    threadgroup spvUnsafeArray<float, 121> FfxDofLDSFarR;
    threadgroup spvUnsafeArray<float, 121> FfxDofLDSFarG;
    threadgroup spvUnsafeArray<float, 121> FfxDofLDSFarB;
    threadgroup spvUnsafeArray<float, 121> FfxDofLDSFarA;
    threadgroup spvUnsafeArray<float, 324> FfxDofLDSFullColorR;
    threadgroup spvUnsafeArray<float, 324> FfxDofLDSFullColorG;
    threadgroup spvUnsafeArray<float, 324> FfxDofLDSFullColorB;
    uint2 _135 = gl_WorkGroupID.xy * uint2(2u);
    float2 _146;
    if (all(_135 < uint2(r_internal_dilated_radius.get_width(), r_internal_dilated_radius.get_height())))
    {
        _146 = r_internal_dilated_radius.read(uint2(_135), 0u).xy;
    }
    else
    {
        _146 = float2(0.0);
    }
    uint2 _147 = _135 + uint2(0u, 1u);
    float2 _158;
    if (all(_147 < uint2(r_internal_dilated_radius.get_width(), r_internal_dilated_radius.get_height())))
    {
        _158 = r_internal_dilated_radius.read(uint2(_147), 0u).xy;
    }
    else
    {
        _158 = float2(0.0);
    }
    uint2 _159 = _135 + uint2(1u, 0u);
    float2 _170;
    if (all(_159 < uint2(r_internal_dilated_radius.get_width(), r_internal_dilated_radius.get_height())))
    {
        _170 = r_internal_dilated_radius.read(uint2(_159), 0u).xy;
    }
    else
    {
        _170 = float2(0.0);
    }
    uint2 _171 = _135 + uint2(1u);
    float2 _182;
    if (all(_171 < uint2(r_internal_dilated_radius.get_width(), r_internal_dilated_radius.get_height())))
    {
        _182 = r_internal_dilated_radius.read(uint2(_171), 0u).xy;
    }
    else
    {
        _182 = float2(0.0);
    }
    float _189 = precise::max(_146.x, precise::max(_158.x, precise::max(_170.x, _182.x)));
    if (precise::max(abs(_189), abs(precise::min(_146.y, precise::min(_158.y, precise::min(_170.y, _182.y))))) < 0.25)
    {
        uint2 _2976 = (uint2(16u) * gl_WorkGroupID.xy) + gl_LocalInvocationID.xy;
        bool _2978 = all(_2976 < cbDOF.inputSize);
        float4 _2984;
        if (_2978)
        {
            _2984 = r_input_color.read(uint2(_2976), 0u);
        }
        else
        {
            _2984 = float4(0.0);
        }
        if (_2978)
        {
            rw_output_color.write(_2984, uint2(_2976));
        }
        uint2 _2988 = _2976 + uint2(8u, 0u);
        bool _2990 = all(_2988 < cbDOF.inputSize);
        float4 _2996;
        if (_2990)
        {
            _2996 = r_input_color.read(uint2(_2988), 0u);
        }
        else
        {
            _2996 = float4(0.0);
        }
        if (_2990)
        {
            rw_output_color.write(_2996, uint2(_2988));
        }
        uint2 _3000 = _2976 + uint2(0u, 8u);
        bool _3002 = all(_3000 < cbDOF.inputSize);
        float4 _3008;
        if (_3002)
        {
            _3008 = r_input_color.read(uint2(_3000), 0u);
        }
        else
        {
            _3008 = float4(0.0);
        }
        if (_3002)
        {
            rw_output_color.write(_3008, uint2(_3000));
        }
        uint2 _3012 = _2976 + uint2(8u);
        bool _3014 = all(_3012 < cbDOF.inputSize);
        float4 _3020;
        if (_3014)
        {
            _3020 = r_input_color.read(uint2(_3012), 0u);
        }
        else
        {
            _3020 = float4(0.0);
        }
        if (_3014)
        {
            rw_output_color.write(_3020, uint2(_3012));
        }
    }
    else
    {
        if ((isunordered(_189, (-1.02499997615814208984375)) || _189 <= (-1.02499997615814208984375)))
        {
            uint _1792 = gl_LocalInvocationIndex % 324u;
            int2 _1794 = int2(gl_WorkGroupID.xy * uint2(16u));
            int2 _1804 = int2(cbDOF.inputSize) - int2(1);
            uint2 _1806 = uint2(clamp(_1794 + int2(int((_1792 % 18u) - 1u), int((_1792 / 18u) - 1u)), int2(0), _1804));
            float4 _1814;
            if (all(_1806 < cbDOF.inputSize))
            {
                _1814 = r_input_color.read(uint2(_1806), 0u);
            }
            else
            {
                _1814 = float4(0.0);
            }
            FfxDofLDSFullColorR[_1792] = _1814.x;
            FfxDofLDSFullColorG[_1792] = _1814.y;
            FfxDofLDSFullColorB[_1792] = _1814.z;
            uint _1821 = gl_LocalInvocationIndex + 64u;
            uint _1822 = _1821 % 324u;
            uint2 _1832 = uint2(clamp(_1794 + int2(int((_1822 % 18u) - 1u), int((_1822 / 18u) - 1u)), int2(0), _1804));
            float4 _1840;
            if (all(_1832 < cbDOF.inputSize))
            {
                _1840 = r_input_color.read(uint2(_1832), 0u);
            }
            else
            {
                _1840 = float4(0.0);
            }
            FfxDofLDSFullColorR[_1822] = _1840.x;
            FfxDofLDSFullColorG[_1822] = _1840.y;
            FfxDofLDSFullColorB[_1822] = _1840.z;
            uint _1848 = (gl_LocalInvocationIndex + 128u) % 324u;
            uint2 _1858 = uint2(clamp(_1794 + int2(int((_1848 % 18u) - 1u), int((_1848 / 18u) - 1u)), int2(0), _1804));
            float4 _1866;
            if (all(_1858 < cbDOF.inputSize))
            {
                _1866 = r_input_color.read(uint2(_1858), 0u);
            }
            else
            {
                _1866 = float4(0.0);
            }
            FfxDofLDSFullColorR[_1848] = _1866.x;
            FfxDofLDSFullColorG[_1848] = _1866.y;
            FfxDofLDSFullColorB[_1848] = _1866.z;
            uint _1874 = (gl_LocalInvocationIndex + 192u) % 324u;
            uint2 _1884 = uint2(clamp(_1794 + int2(int((_1874 % 18u) - 1u), int((_1874 / 18u) - 1u)), int2(0), _1804));
            float4 _1892;
            if (all(_1884 < cbDOF.inputSize))
            {
                _1892 = r_input_color.read(uint2(_1884), 0u);
            }
            else
            {
                _1892 = float4(0.0);
            }
            FfxDofLDSFullColorR[_1874] = _1892.x;
            FfxDofLDSFullColorG[_1874] = _1892.y;
            FfxDofLDSFullColorB[_1874] = _1892.z;
            uint _1900 = (gl_LocalInvocationIndex + 256u) % 324u;
            uint2 _1910 = uint2(clamp(_1794 + int2(int((_1900 % 18u) - 1u), int((_1900 / 18u) - 1u)), int2(0), _1804));
            float4 _1918;
            if (all(_1910 < cbDOF.inputSize))
            {
                _1918 = r_input_color.read(uint2(_1910), 0u);
            }
            else
            {
                _1918 = float4(0.0);
            }
            FfxDofLDSFullColorR[_1900] = _1918.x;
            FfxDofLDSFullColorG[_1900] = _1918.y;
            FfxDofLDSFullColorB[_1900] = _1918.z;
            uint _1926 = (gl_LocalInvocationIndex + 320u) % 324u;
            uint2 _1936 = uint2(clamp(_1794 + int2(int((_1926 % 18u) - 1u), int((_1926 / 18u) - 1u)), int2(0), _1804));
            float4 _1944;
            if (all(_1936 < cbDOF.inputSize))
            {
                _1944 = r_input_color.read(uint2(_1936), 0u);
            }
            else
            {
                _1944 = float4(0.0);
            }
            FfxDofLDSFullColorR[_1926] = _1944.x;
            FfxDofLDSFullColorG[_1926] = _1944.y;
            FfxDofLDSFullColorB[_1926] = _1944.z;
            uint _1951 = gl_LocalInvocationIndex % 121u;
            int2 _1953 = int2(gl_WorkGroupID.xy * uint2(8u));
            int2 _1963 = int2(cbDOF.inputSizeHalf - uint2(1u));
            uint2 _1965 = uint2(clamp(_1953 + int2(int((_1951 % 11u) - 1u), int((_1951 / 11u) - 1u)), int2(0), _1963));
            float4 _1973;
            if (all(_1965 < cbDOF.inputSizeHalf))
            {
                _1973 = rw_internal_far.read(uint2(_1965));
            }
            else
            {
                _1973 = float4(0.0);
            }
            FfxDofLDSFarLuma[_1951] = ((0.2125999927520751953125 * _1973.x) + (0.715200006961822509765625 * _1973.y)) + (0.072200000286102294921875 * _1973.z);
            FfxDofLDSFarR[_1951] = _1973.x;
            FfxDofLDSFarG[_1951] = _1973.y;
            FfxDofLDSFarB[_1951] = _1973.z;
            FfxDofLDSFarA[_1951] = _1973.w;
            uint _1988 = _1821 % 121u;
            uint2 _1998 = uint2(clamp(_1953 + int2(int((_1988 % 11u) - 1u), int((_1988 / 11u) - 1u)), int2(0), _1963));
            float4 _2006;
            if (all(_1998 < cbDOF.inputSizeHalf))
            {
                _2006 = rw_internal_far.read(uint2(_1998));
            }
            else
            {
                _2006 = float4(0.0);
            }
            FfxDofLDSFarLuma[_1988] = ((0.2125999927520751953125 * _2006.x) + (0.715200006961822509765625 * _2006.y)) + (0.072200000286102294921875 * _2006.z);
            FfxDofLDSFarR[_1988] = _2006.x;
            FfxDofLDSFarG[_1988] = _2006.y;
            FfxDofLDSFarB[_1988] = _2006.z;
            FfxDofLDSFarA[_1988] = _2006.w;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            uint _2024 = gl_LocalInvocationID.x + (gl_LocalInvocationID.y * 11u);
            uint _2033 = ((8u + (11u * gl_LocalInvocationIndex)) + ((gl_LocalInvocationIndex / 9u) * (((gl_LocalInvocationIndex - 8u) * 4294967286u) - 9u))) % 121u;
            uint _2036 = _2024 + 1u;
            uint _2039 = _2024 + 2u;
            uint _2042 = _2024 + 11u;
            uint _2045 = _2024 + 12u;
            uint _2048 = _2024 + 13u;
            uint _2051 = _2024 + 22u;
            uint _2054 = _2024 + 23u;
            uint _2057 = _2024 + 24u;
            float _2067 = precise::max(precise::min(FfxDofLDSFarLuma[_2024], precise::min(FfxDofLDSFarLuma[_2036], FfxDofLDSFarLuma[_2039])), precise::max(precise::min(FfxDofLDSFarLuma[_2042], precise::min(FfxDofLDSFarLuma[_2045], FfxDofLDSFarLuma[_2048])), precise::min(FfxDofLDSFarLuma[_2051], precise::min(FfxDofLDSFarLuma[_2054], FfxDofLDSFarLuma[_2057]))));
            float _2071 = precise::max(precise::min(FfxDofLDSFarLuma[_2024], FfxDofLDSFarLuma[_2036]), precise::min(precise::max(FfxDofLDSFarLuma[_2024], FfxDofLDSFarLuma[_2036]), FfxDofLDSFarLuma[_2039]));
            float _2075 = precise::max(precise::min(FfxDofLDSFarLuma[_2042], FfxDofLDSFarLuma[_2045]), precise::min(precise::max(FfxDofLDSFarLuma[_2042], FfxDofLDSFarLuma[_2045]), FfxDofLDSFarLuma[_2048]));
            float _2083 = precise::max(precise::min(_2071, _2075), precise::min(precise::max(_2071, _2075), precise::max(precise::min(FfxDofLDSFarLuma[_2051], FfxDofLDSFarLuma[_2054]), precise::min(precise::max(FfxDofLDSFarLuma[_2051], FfxDofLDSFarLuma[_2054]), FfxDofLDSFarLuma[_2057]))));
            float _2095 = precise::max(precise::min(_2067, _2083), precise::min(precise::max(_2067, _2083), precise::min(precise::max(FfxDofLDSFarLuma[_2024], precise::max(FfxDofLDSFarLuma[_2036], FfxDofLDSFarLuma[_2039])), precise::min(precise::max(FfxDofLDSFarLuma[_2042], precise::max(FfxDofLDSFarLuma[_2045], FfxDofLDSFarLuma[_2048])), precise::max(FfxDofLDSFarLuma[_2051], precise::max(FfxDofLDSFarLuma[_2054], FfxDofLDSFarLuma[_2057]))))));
            float _2097 = FfxDofLDSFarR[_2045];
            float _2099 = FfxDofLDSFarG[_2045];
            float _2101 = FfxDofLDSFarB[_2045];
            float _2104 = FfxDofLDSFarLuma[_2045];
            float3 _2109 = float4(_2097, _2099, _2101, _122).xyz * ((_2095 == 0.0) ? 1.0 : fast::clamp(_2095 / _2104, 0.0, 2.0));
            float _2111 = FfxDofLDSFarA[_2045];
            float _2112 = _2109.x;
            float4 _2115 = float4(_2112, _2109.yz, _2111);
            bool _2116 = gl_LocalInvocationIndex < 17u;
            float4 _2202;
            if (_2116)
            {
                uint _2122 = _2033 + 1u;
                uint _2125 = _2033 + 2u;
                uint _2128 = _2033 + 11u;
                uint _2131 = _2033 + 12u;
                uint _2134 = _2033 + 13u;
                uint _2137 = _2033 + 22u;
                uint _2140 = _2033 + 23u;
                uint _2143 = _2033 + 24u;
                float _2153 = precise::max(precise::min(FfxDofLDSFarLuma[_2033], precise::min(FfxDofLDSFarLuma[_2122], FfxDofLDSFarLuma[_2125])), precise::max(precise::min(FfxDofLDSFarLuma[_2128], precise::min(FfxDofLDSFarLuma[_2131], FfxDofLDSFarLuma[_2134])), precise::min(FfxDofLDSFarLuma[_2137], precise::min(FfxDofLDSFarLuma[_2140], FfxDofLDSFarLuma[_2143]))));
                float _2157 = precise::max(precise::min(FfxDofLDSFarLuma[_2033], FfxDofLDSFarLuma[_2122]), precise::min(precise::max(FfxDofLDSFarLuma[_2033], FfxDofLDSFarLuma[_2122]), FfxDofLDSFarLuma[_2125]));
                float _2161 = precise::max(precise::min(FfxDofLDSFarLuma[_2128], FfxDofLDSFarLuma[_2131]), precise::min(precise::max(FfxDofLDSFarLuma[_2128], FfxDofLDSFarLuma[_2131]), FfxDofLDSFarLuma[_2134]));
                float _2169 = precise::max(precise::min(_2157, _2161), precise::min(precise::max(_2157, _2161), precise::max(precise::min(FfxDofLDSFarLuma[_2137], FfxDofLDSFarLuma[_2140]), precise::min(precise::max(FfxDofLDSFarLuma[_2137], FfxDofLDSFarLuma[_2140]), FfxDofLDSFarLuma[_2143]))));
                float _2181 = precise::max(precise::min(_2153, _2169), precise::min(precise::max(_2153, _2169), precise::min(precise::max(FfxDofLDSFarLuma[_2033], precise::max(FfxDofLDSFarLuma[_2122], FfxDofLDSFarLuma[_2125])), precise::min(precise::max(FfxDofLDSFarLuma[_2128], precise::max(FfxDofLDSFarLuma[_2131], FfxDofLDSFarLuma[_2134])), precise::max(FfxDofLDSFarLuma[_2137], precise::max(FfxDofLDSFarLuma[_2140], FfxDofLDSFarLuma[_2143]))))));
                _2202 = float4(float4(FfxDofLDSFarR[_2131], FfxDofLDSFarG[_2131], FfxDofLDSFarB[_2131], _122).xyz * ((_2181 == 0.0) ? 1.0 : fast::clamp(_2181 / FfxDofLDSFarLuma[_2131], 0.0, 2.0)), FfxDofLDSFarA[_2131]);
            }
            else
            {
                _2202 = float4(0.0);
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            FfxDofLDSFarR[_2024] = _2112;
            FfxDofLDSFarG[_2024] = _2109.y;
            FfxDofLDSFarB[_2024] = _2109.z;
            FfxDofLDSFarA[_2024] = _2111;
            if (_2116)
            {
                FfxDofLDSFarR[_2033] = _2202.x;
                FfxDofLDSFarG[_2033] = _2202.y;
                FfxDofLDSFarB[_2033] = _2202.z;
                FfxDofLDSFarA[_2033] = _2202.w;
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            float4 _2217 = _2115 * 0.5;
            float4 _2228 = _2217 + (float4(FfxDofLDSFarR[_2036], FfxDofLDSFarG[_2036], FfxDofLDSFarB[_2036], FfxDofLDSFarA[_2036]) * 0.5);
            float4 _2239 = _2217 + (float4(FfxDofLDSFarR[_2042], FfxDofLDSFarG[_2042], FfxDofLDSFarB[_2042], FfxDofLDSFarA[_2042]) * 0.5);
            float4 _2254 = ((_2228 * 0.5) + (float4(FfxDofLDSFarR[_2042], FfxDofLDSFarG[_2042], FfxDofLDSFarB[_2042], FfxDofLDSFarA[_2042]) * 0.25)) + (float4(FfxDofLDSFarR[_2045], FfxDofLDSFarG[_2045], FfxDofLDSFarB[_2045], FfxDofLDSFarA[_2045]) * 0.25);
            uint2 _2255 = uint2(2u) * gl_GlobalInvocationID.xy;
            uint2 _2256 = uint2(2u) * gl_LocalInvocationID.xy;
            float _2265;
            if (all(_2255 < cbDOF.inputSize))
            {
                _2265 = r_input_depth.read(uint2(_2255), 0u).x;
            }
            else
            {
                _2265 = 0.0;
            }
            uint _2266 = _2256.x;
            uint _2267 = _2256.y;
            uint _2268 = 18u * _2267;
            uint _2269 = _2266 + _2268;
            uint _2270 = _2269 + 19u;
            uint _2289 = _2269 + 2u;
            uint _2298 = _2269 + 36u;
            uint _2307 = _2269 + 38u;
            uint _2318 = _2269 + 1u;
            uint _2326 = _2269 + 18u;
            uint _2335 = _2269 + 20u;
            uint _2344 = _2269 + 37u;
            float3 _2355 = ((float3(FfxDofLDSFullColorR[_2270], FfxDofLDSFullColorG[_2270], FfxDofLDSFullColorB[_2270]) + ((((float3(FfxDofLDSFullColorR[_2269], FfxDofLDSFullColorG[_2269], FfxDofLDSFullColorB[_2269]) + float3(FfxDofLDSFullColorR[_2289], FfxDofLDSFullColorG[_2289], FfxDofLDSFullColorB[_2289])) + float3(FfxDofLDSFullColorR[_2298], FfxDofLDSFullColorG[_2298], FfxDofLDSFullColorB[_2298])) + float3(FfxDofLDSFullColorR[_2307], FfxDofLDSFullColorG[_2307], FfxDofLDSFullColorB[_2307])) * 0.545300006866455078125)) + ((((float3(FfxDofLDSFullColorR[_2318], FfxDofLDSFullColorG[_2318], FfxDofLDSFullColorB[_2318]) + float3(FfxDofLDSFullColorR[_2326], FfxDofLDSFullColorG[_2326], FfxDofLDSFullColorB[_2326])) + float3(FfxDofLDSFullColorR[_2335], FfxDofLDSFullColorG[_2335], FfxDofLDSFullColorB[_2335])) + float3(FfxDofLDSFullColorR[_2344], FfxDofLDSFullColorG[_2344], FfxDofLDSFullColorB[_2344])) * 0.971700012683868408203125)) * float3(0.1414827406406402587890625);
            float4 _2363;
            if (_2111 > 0.0)
            {
                float3 _2361 = _2115.xyz / float3(_2111);
                _2363 = float4(_2361.x, _2361.y, _2361.z, _2115.w);
            }
            else
            {
                _2363 = _2115;
            }
            float _2372 = -cbDOF.cocLimit;
            float _2375 = 2.0 * abs(fast::clamp((cbDOF.cocScale * _2265) + cbDOF.cocBias, _2372, cbDOF.cocLimit));
            float4 _2391 = float4(mix(mix(float3(FfxDofLDSFullColorR[_2270], FfxDofLDSFullColorG[_2270], FfxDofLDSFullColorB[_2270]), _2355, float3(fast::clamp(_2375 - 0.5, 0.0, 1.0))), _2363.xyz, float3((_2363.w == 0.0) ? 0.0 : fast::clamp(_2375 - 1.5, 0.0, 1.0))), 1.0);
            uint _2392 = _2255.x;
            uint _2393 = _2392 + 1u;
            uint2 _2394 = _2255;
            _2394.x = _2393;
            uint _2395 = _2266 + 1u;
            float _2404;
            if (all(_2394 < cbDOF.inputSize))
            {
                _2404 = r_input_depth.read(uint2(_2394), 0u).x;
            }
            else
            {
                _2404 = 0.0;
            }
            uint _2405 = _2395 + _2268;
            uint _2406 = _2405 + 19u;
            uint _2425 = _2405 + 2u;
            uint _2434 = _2405 + 36u;
            uint _2443 = _2405 + 38u;
            uint _2454 = _2405 + 1u;
            uint _2462 = _2405 + 18u;
            uint _2471 = _2405 + 20u;
            uint _2480 = _2405 + 37u;
            float3 _2491 = ((float3(FfxDofLDSFullColorR[_2406], FfxDofLDSFullColorG[_2406], FfxDofLDSFullColorB[_2406]) + ((((float3(FfxDofLDSFullColorR[_2405], FfxDofLDSFullColorG[_2405], FfxDofLDSFullColorB[_2405]) + float3(FfxDofLDSFullColorR[_2425], FfxDofLDSFullColorG[_2425], FfxDofLDSFullColorB[_2425])) + float3(FfxDofLDSFullColorR[_2434], FfxDofLDSFullColorG[_2434], FfxDofLDSFullColorB[_2434])) + float3(FfxDofLDSFullColorR[_2443], FfxDofLDSFullColorG[_2443], FfxDofLDSFullColorB[_2443])) * 0.545300006866455078125)) + ((((float3(FfxDofLDSFullColorR[_2454], FfxDofLDSFullColorG[_2454], FfxDofLDSFullColorB[_2454]) + float3(FfxDofLDSFullColorR[_2462], FfxDofLDSFullColorG[_2462], FfxDofLDSFullColorB[_2462])) + float3(FfxDofLDSFullColorR[_2471], FfxDofLDSFullColorG[_2471], FfxDofLDSFullColorB[_2471])) + float3(FfxDofLDSFullColorR[_2480], FfxDofLDSFullColorG[_2480], FfxDofLDSFullColorB[_2480])) * 0.971700012683868408203125)) * float3(0.1414827406406402587890625);
            float _2492 = _2228.w;
            float4 _2500;
            if (_2492 > 0.0)
            {
                float3 _2498 = _2228.xyz / float3(_2492);
                _2500 = float4(_2498.x, _2498.y, _2498.z, _2228.w);
            }
            else
            {
                _2500 = _2228;
            }
            float _2505 = 2.0 * abs(fast::clamp((cbDOF.cocScale * _2404) + cbDOF.cocBias, _2372, cbDOF.cocLimit));
            float4 _2521 = float4(mix(mix(float3(FfxDofLDSFullColorR[_2406], FfxDofLDSFullColorG[_2406], FfxDofLDSFullColorB[_2406]), _2491, float3(fast::clamp(_2505 - 0.5, 0.0, 1.0))), _2500.xyz, float3((_2500.w == 0.0) ? 0.0 : fast::clamp(_2505 - 1.5, 0.0, 1.0))), 1.0);
            uint2 _2524 = uint2(_2393, _2255.y + 1u);
            float _2534;
            if (all(_2524 < cbDOF.inputSize))
            {
                _2534 = r_input_depth.read(uint2(_2524), 0u).x;
            }
            else
            {
                _2534 = 0.0;
            }
            uint _2535 = 18u * (_2267 + 1u);
            uint _2536 = _2395 + _2535;
            uint _2537 = _2536 + 19u;
            uint _2556 = _2536 + 2u;
            uint _2565 = _2536 + 36u;
            uint _2574 = _2536 + 38u;
            uint _2585 = _2536 + 1u;
            uint _2593 = _2536 + 18u;
            uint _2602 = _2536 + 20u;
            uint _2611 = _2536 + 37u;
            float3 _2622 = ((float3(FfxDofLDSFullColorR[_2537], FfxDofLDSFullColorG[_2537], FfxDofLDSFullColorB[_2537]) + ((((float3(FfxDofLDSFullColorR[_2536], FfxDofLDSFullColorG[_2536], FfxDofLDSFullColorB[_2536]) + float3(FfxDofLDSFullColorR[_2556], FfxDofLDSFullColorG[_2556], FfxDofLDSFullColorB[_2556])) + float3(FfxDofLDSFullColorR[_2565], FfxDofLDSFullColorG[_2565], FfxDofLDSFullColorB[_2565])) + float3(FfxDofLDSFullColorR[_2574], FfxDofLDSFullColorG[_2574], FfxDofLDSFullColorB[_2574])) * 0.545300006866455078125)) + ((((float3(FfxDofLDSFullColorR[_2585], FfxDofLDSFullColorG[_2585], FfxDofLDSFullColorB[_2585]) + float3(FfxDofLDSFullColorR[_2593], FfxDofLDSFullColorG[_2593], FfxDofLDSFullColorB[_2593])) + float3(FfxDofLDSFullColorR[_2602], FfxDofLDSFullColorG[_2602], FfxDofLDSFullColorB[_2602])) + float3(FfxDofLDSFullColorR[_2611], FfxDofLDSFullColorG[_2611], FfxDofLDSFullColorB[_2611])) * 0.971700012683868408203125)) * float3(0.1414827406406402587890625);
            float _2623 = _2254.w;
            float4 _2631;
            if (_2623 > 0.0)
            {
                float3 _2629 = _2254.xyz / float3(_2623);
                _2631 = float4(_2629.x, _2629.y, _2629.z, _2254.w);
            }
            else
            {
                _2631 = _2254;
            }
            float _2636 = 2.0 * abs(fast::clamp((cbDOF.cocScale * _2534) + cbDOF.cocBias, _2372, cbDOF.cocLimit));
            float4 _2652 = float4(mix(mix(float3(FfxDofLDSFullColorR[_2537], FfxDofLDSFullColorG[_2537], FfxDofLDSFullColorB[_2537]), _2622, float3(fast::clamp(_2636 - 0.5, 0.0, 1.0))), _2631.xyz, float3((_2631.w == 0.0) ? 0.0 : fast::clamp(_2636 - 1.5, 0.0, 1.0))), 1.0);
            uint2 _2653 = _2524;
            _2653.x = _2392;
            float _2662;
            if (all(_2653 < cbDOF.inputSize))
            {
                _2662 = r_input_depth.read(uint2(_2653), 0u).x;
            }
            else
            {
                _2662 = 0.0;
            }
            uint _2663 = _2266 + _2535;
            uint _2664 = _2663 + 19u;
            uint _2683 = _2663 + 2u;
            uint _2692 = _2663 + 36u;
            uint _2701 = _2663 + 38u;
            uint _2712 = _2663 + 1u;
            uint _2720 = _2663 + 18u;
            uint _2729 = _2663 + 20u;
            uint _2738 = _2663 + 37u;
            float3 _2749 = ((float3(FfxDofLDSFullColorR[_2664], FfxDofLDSFullColorG[_2664], FfxDofLDSFullColorB[_2664]) + ((((float3(FfxDofLDSFullColorR[_2663], FfxDofLDSFullColorG[_2663], FfxDofLDSFullColorB[_2663]) + float3(FfxDofLDSFullColorR[_2683], FfxDofLDSFullColorG[_2683], FfxDofLDSFullColorB[_2683])) + float3(FfxDofLDSFullColorR[_2692], FfxDofLDSFullColorG[_2692], FfxDofLDSFullColorB[_2692])) + float3(FfxDofLDSFullColorR[_2701], FfxDofLDSFullColorG[_2701], FfxDofLDSFullColorB[_2701])) * 0.545300006866455078125)) + ((((float3(FfxDofLDSFullColorR[_2712], FfxDofLDSFullColorG[_2712], FfxDofLDSFullColorB[_2712]) + float3(FfxDofLDSFullColorR[_2720], FfxDofLDSFullColorG[_2720], FfxDofLDSFullColorB[_2720])) + float3(FfxDofLDSFullColorR[_2729], FfxDofLDSFullColorG[_2729], FfxDofLDSFullColorB[_2729])) + float3(FfxDofLDSFullColorR[_2738], FfxDofLDSFullColorG[_2738], FfxDofLDSFullColorB[_2738])) * 0.971700012683868408203125)) * float3(0.1414827406406402587890625);
            float _2750 = _2239.w;
            float4 _2758;
            if (_2750 > 0.0)
            {
                float3 _2756 = _2239.xyz / float3(_2750);
                _2758 = float4(_2756.x, _2756.y, _2756.z, _2239.w);
            }
            else
            {
                _2758 = _2239;
            }
            bool _2799;
            float _2763 = 2.0 * abs(fast::clamp((cbDOF.cocScale * _2662) + cbDOF.cocBias, _2372, cbDOF.cocLimit));
            float4 _2779 = float4(mix(mix(float3(FfxDofLDSFullColorR[_2664], FfxDofLDSFullColorG[_2664], FfxDofLDSFullColorB[_2664]), _2749, float3(fast::clamp(_2763 - 0.5, 0.0, 1.0))), _2758.xyz, float3((_2758.w == 0.0) ? 0.0 : fast::clamp(_2763 - 1.5, 0.0, 1.0))), 1.0);
            uint2 _2781 = as_type<uint2>(_2391.xy);
            uint2 _2783 = as_type<uint2>(_2391.zw);
            uint2 _2785 = as_type<uint2>(_2521.xy);
            uint2 _2787 = as_type<uint2>(_2521.zw);
            uint2 _2789 = as_type<uint2>(_2652.xy);
            uint2 _2791 = as_type<uint2>(_2652.zw);
            uint2 _2793 = as_type<uint2>(_2779.xy);
            uint2 _2795 = as_type<uint2>(_2779.zw);
            uint2 _2837;
            uint2 _2838;
            uint2 _2839;
            uint2 _2840;
            do
            {
                _2799 = gl_SubgroupSize < 32u;
                if (_2799)
                {
                    _2837 = _2793;
                    _2838 = _2789;
                    _2839 = _2785;
                    _2840 = _2781;
                    break;
                }
                uint _2806 = ((gl_SubgroupInvocationID & 3u) << 3u) + (gl_SubgroupInvocationID >> 2u);
                uint _2807 = gl_SubgroupInvocationID & 4294967264u;
                uint2 _2810 = spvSubgroupShuffle(_2781, _2807 + (_2806 % 32u));
                uint2 _2814 = spvSubgroupShuffle(_2785, _2807 + ((_2806 + 8u) % 32u));
                uint2 _2818 = spvSubgroupShuffle(_2789, _2807 + ((_2806 + 16u) % 32u));
                uint2 _2822 = spvSubgroupShuffle(_2793, _2807 + ((_2806 + 24u) % 32u));
                bool2 _2825 = bool2((gl_SubgroupInvocationID & 1u) != 0u);
                uint2 _2826 = select(_2822, _2818, _2825);
                uint2 _2827 = select(_2814, _2810, _2825);
                uint2 _2828 = select(_2818, _2814, _2825);
                uint2 _2829 = select(_2810, _2822, _2825);
                bool2 _2832 = bool2((gl_SubgroupInvocationID & 2u) != 0u);
                _2837 = select(_2826, _2827, _2832);
                _2838 = select(_2828, _2829, _2832);
                _2839 = select(_2827, _2826, _2832);
                _2840 = select(_2829, _2828, _2832);
                break;
            } while(false);
            uint2 _2880;
            uint2 _2881;
            uint2 _2882;
            uint2 _2883;
            do
            {
                if (_2799)
                {
                    _2880 = _2795;
                    _2881 = _2791;
                    _2882 = _2787;
                    _2883 = _2783;
                    break;
                }
                uint _2849 = ((gl_SubgroupInvocationID & 3u) << 3u) + (gl_SubgroupInvocationID >> 2u);
                uint _2850 = gl_SubgroupInvocationID & 4294967264u;
                uint2 _2853 = spvSubgroupShuffle(_2783, _2850 + (_2849 % 32u));
                uint2 _2857 = spvSubgroupShuffle(_2787, _2850 + ((_2849 + 8u) % 32u));
                uint2 _2861 = spvSubgroupShuffle(_2791, _2850 + ((_2849 + 16u) % 32u));
                uint2 _2865 = spvSubgroupShuffle(_2795, _2850 + ((_2849 + 24u) % 32u));
                bool2 _2868 = bool2((gl_SubgroupInvocationID & 1u) != 0u);
                uint2 _2869 = select(_2865, _2861, _2868);
                uint2 _2870 = select(_2857, _2853, _2868);
                uint2 _2871 = select(_2861, _2857, _2868);
                uint2 _2872 = select(_2853, _2865, _2868);
                bool2 _2875 = bool2((gl_SubgroupInvocationID & 2u) != 0u);
                _2880 = select(_2869, _2870, _2875);
                _2881 = select(_2871, _2872, _2875);
                _2882 = select(_2870, _2869, _2875);
                _2883 = select(_2872, _2871, _2875);
                break;
            } while(false);
            uint2 _2951;
            uint2 _2952;
            uint2 _2953;
            uint2 _2954;
            do
            {
                if (_2799)
                {
                    _2951 = _2653;
                    _2952 = _2524;
                    _2953 = _2394;
                    _2954 = _2255;
                    break;
                }
                uint _2920 = ((gl_SubgroupInvocationID & 3u) << 3u) + (gl_SubgroupInvocationID >> 2u);
                uint _2921 = gl_SubgroupInvocationID & 4294967264u;
                uint2 _2924 = spvSubgroupShuffle(_2255, _2921 + (_2920 % 32u));
                uint2 _2928 = spvSubgroupShuffle(_2394, _2921 + ((_2920 + 8u) % 32u));
                uint2 _2932 = spvSubgroupShuffle(_2524, _2921 + ((_2920 + 16u) % 32u));
                uint2 _2936 = spvSubgroupShuffle(_2653, _2921 + ((_2920 + 24u) % 32u));
                bool2 _2939 = bool2((gl_SubgroupInvocationID & 1u) != 0u);
                uint2 _2940 = select(_2936, _2932, _2939);
                uint2 _2941 = select(_2928, _2924, _2939);
                uint2 _2942 = select(_2932, _2928, _2939);
                uint2 _2943 = select(_2924, _2936, _2939);
                bool2 _2946 = bool2((gl_SubgroupInvocationID & 2u) != 0u);
                _2951 = select(_2940, _2941, _2946);
                _2952 = select(_2942, _2943, _2946);
                _2953 = select(_2941, _2940, _2946);
                _2954 = select(_2943, _2942, _2946);
                break;
            } while(false);
            if (all(_2954 < cbDOF.inputSize))
            {
                rw_output_color.write(float4(as_type<float2>(_2840), as_type<float2>(_2883)), uint2(_2954));
            }
            if (all(_2953 < cbDOF.inputSize))
            {
                rw_output_color.write(float4(as_type<float2>(_2839), as_type<float2>(_2882)), uint2(_2953));
            }
            if (all(_2952 < cbDOF.inputSize))
            {
                rw_output_color.write(float4(as_type<float2>(_2838), as_type<float2>(_2881)), uint2(_2952));
            }
            if (all(_2951 < cbDOF.inputSize))
            {
                rw_output_color.write(float4(as_type<float2>(_2837), as_type<float2>(_2880)), uint2(_2951));
            }
        }
        else
        {
            uint _208 = gl_LocalInvocationIndex % 324u;
            int2 _210 = int2(gl_WorkGroupID.xy * uint2(16u));
            int2 _220 = int2(cbDOF.inputSize) - int2(1);
            uint2 _222 = uint2(clamp(_210 + int2(int((_208 % 18u) - 1u), int((_208 / 18u) - 1u)), int2(0), _220));
            float4 _230;
            if (all(_222 < cbDOF.inputSize))
            {
                _230 = r_input_color.read(uint2(_222), 0u);
            }
            else
            {
                _230 = float4(0.0);
            }
            FfxDofLDSFullColorR[_208] = _230.x;
            FfxDofLDSFullColorG[_208] = _230.y;
            FfxDofLDSFullColorB[_208] = _230.z;
            uint _237 = gl_LocalInvocationIndex + 64u;
            uint _238 = _237 % 324u;
            uint2 _248 = uint2(clamp(_210 + int2(int((_238 % 18u) - 1u), int((_238 / 18u) - 1u)), int2(0), _220));
            float4 _256;
            if (all(_248 < cbDOF.inputSize))
            {
                _256 = r_input_color.read(uint2(_248), 0u);
            }
            else
            {
                _256 = float4(0.0);
            }
            FfxDofLDSFullColorR[_238] = _256.x;
            FfxDofLDSFullColorG[_238] = _256.y;
            FfxDofLDSFullColorB[_238] = _256.z;
            uint _264 = (gl_LocalInvocationIndex + 128u) % 324u;
            uint2 _274 = uint2(clamp(_210 + int2(int((_264 % 18u) - 1u), int((_264 / 18u) - 1u)), int2(0), _220));
            float4 _282;
            if (all(_274 < cbDOF.inputSize))
            {
                _282 = r_input_color.read(uint2(_274), 0u);
            }
            else
            {
                _282 = float4(0.0);
            }
            FfxDofLDSFullColorR[_264] = _282.x;
            FfxDofLDSFullColorG[_264] = _282.y;
            FfxDofLDSFullColorB[_264] = _282.z;
            uint _290 = (gl_LocalInvocationIndex + 192u) % 324u;
            uint2 _300 = uint2(clamp(_210 + int2(int((_290 % 18u) - 1u), int((_290 / 18u) - 1u)), int2(0), _220));
            float4 _308;
            if (all(_300 < cbDOF.inputSize))
            {
                _308 = r_input_color.read(uint2(_300), 0u);
            }
            else
            {
                _308 = float4(0.0);
            }
            FfxDofLDSFullColorR[_290] = _308.x;
            FfxDofLDSFullColorG[_290] = _308.y;
            FfxDofLDSFullColorB[_290] = _308.z;
            uint _316 = (gl_LocalInvocationIndex + 256u) % 324u;
            uint2 _326 = uint2(clamp(_210 + int2(int((_316 % 18u) - 1u), int((_316 / 18u) - 1u)), int2(0), _220));
            float4 _334;
            if (all(_326 < cbDOF.inputSize))
            {
                _334 = r_input_color.read(uint2(_326), 0u);
            }
            else
            {
                _334 = float4(0.0);
            }
            FfxDofLDSFullColorR[_316] = _334.x;
            FfxDofLDSFullColorG[_316] = _334.y;
            FfxDofLDSFullColorB[_316] = _334.z;
            uint _342 = (gl_LocalInvocationIndex + 320u) % 324u;
            uint2 _352 = uint2(clamp(_210 + int2(int((_342 % 18u) - 1u), int((_342 / 18u) - 1u)), int2(0), _220));
            float4 _360;
            if (all(_352 < cbDOF.inputSize))
            {
                _360 = r_input_color.read(uint2(_352), 0u);
            }
            else
            {
                _360 = float4(0.0);
            }
            FfxDofLDSFullColorR[_342] = _360.x;
            FfxDofLDSFullColorG[_342] = _360.y;
            FfxDofLDSFullColorB[_342] = _360.z;
            uint _367 = gl_LocalInvocationIndex % 121u;
            int2 _369 = int2(gl_WorkGroupID.xy * uint2(8u));
            int2 _379 = int2(cbDOF.inputSizeHalf - uint2(1u));
            uint2 _381 = uint2(clamp(_369 + int2(int((_367 % 11u) - 1u), int((_367 / 11u) - 1u)), int2(0), _379));
            bool _383 = all(_381 < cbDOF.inputSizeHalf);
            float4 _389;
            if (_383)
            {
                _389 = rw_internal_far.read(uint2(_381));
            }
            else
            {
                _389 = float4(0.0);
            }
            float4 _395;
            if (_383)
            {
                _395 = rw_internal_near.read(uint2(_381));
            }
            else
            {
                _395 = float4(0.0);
            }
            FfxDofLDSFarLuma[_367] = ((0.2125999927520751953125 * _389.x) + (0.715200006961822509765625 * _389.y)) + (0.072200000286102294921875 * _389.z);
            FfxDofLDSNearLuma[_367] = ((0.2125999927520751953125 * _395.x) + (0.715200006961822509765625 * _395.y)) + (0.072200000286102294921875 * _395.z);
            FfxDofLDSFarR[_367] = _389.x;
            FfxDofLDSFarG[_367] = _389.y;
            FfxDofLDSFarB[_367] = _389.z;
            FfxDofLDSFarA[_367] = _389.w;
            FfxDofLDSNearR[_367] = _395.x;
            FfxDofLDSNearG[_367] = _395.y;
            FfxDofLDSNearB[_367] = _395.z;
            FfxDofLDSNearA[_367] = _395.w;
            uint _424 = _237 % 121u;
            uint2 _434 = uint2(clamp(_369 + int2(int((_424 % 11u) - 1u), int((_424 / 11u) - 1u)), int2(0), _379));
            bool _436 = all(_434 < cbDOF.inputSizeHalf);
            float4 _442;
            if (_436)
            {
                _442 = rw_internal_far.read(uint2(_434));
            }
            else
            {
                _442 = float4(0.0);
            }
            float4 _448;
            if (_436)
            {
                _448 = rw_internal_near.read(uint2(_434));
            }
            else
            {
                _448 = float4(0.0);
            }
            FfxDofLDSFarLuma[_424] = ((0.2125999927520751953125 * _442.x) + (0.715200006961822509765625 * _442.y)) + (0.072200000286102294921875 * _442.z);
            FfxDofLDSNearLuma[_424] = ((0.2125999927520751953125 * _448.x) + (0.715200006961822509765625 * _448.y)) + (0.072200000286102294921875 * _448.z);
            FfxDofLDSFarR[_424] = _442.x;
            FfxDofLDSFarG[_424] = _442.y;
            FfxDofLDSFarB[_424] = _442.z;
            FfxDofLDSFarA[_424] = _442.w;
            FfxDofLDSNearR[_424] = _448.x;
            FfxDofLDSNearG[_424] = _448.y;
            FfxDofLDSNearB[_424] = _448.z;
            FfxDofLDSNearA[_424] = _448.w;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            uint _480 = gl_LocalInvocationID.x + (gl_LocalInvocationID.y * 11u);
            uint _489 = ((8u + (11u * gl_LocalInvocationIndex)) + ((gl_LocalInvocationIndex / 9u) * (((gl_LocalInvocationIndex - 8u) * 4294967286u) - 9u))) % 121u;
            uint _492 = _480 + 1u;
            uint _495 = _480 + 2u;
            uint _498 = _480 + 11u;
            uint _501 = _480 + 12u;
            uint _504 = _480 + 13u;
            uint _507 = _480 + 22u;
            uint _510 = _480 + 23u;
            uint _513 = _480 + 24u;
            float _523 = precise::max(precise::min(FfxDofLDSFarLuma[_480], precise::min(FfxDofLDSFarLuma[_492], FfxDofLDSFarLuma[_495])), precise::max(precise::min(FfxDofLDSFarLuma[_498], precise::min(FfxDofLDSFarLuma[_501], FfxDofLDSFarLuma[_504])), precise::min(FfxDofLDSFarLuma[_507], precise::min(FfxDofLDSFarLuma[_510], FfxDofLDSFarLuma[_513]))));
            float _527 = precise::max(precise::min(FfxDofLDSFarLuma[_480], FfxDofLDSFarLuma[_492]), precise::min(precise::max(FfxDofLDSFarLuma[_480], FfxDofLDSFarLuma[_492]), FfxDofLDSFarLuma[_495]));
            float _531 = precise::max(precise::min(FfxDofLDSFarLuma[_498], FfxDofLDSFarLuma[_501]), precise::min(precise::max(FfxDofLDSFarLuma[_498], FfxDofLDSFarLuma[_501]), FfxDofLDSFarLuma[_504]));
            float _539 = precise::max(precise::min(_527, _531), precise::min(precise::max(_527, _531), precise::max(precise::min(FfxDofLDSFarLuma[_507], FfxDofLDSFarLuma[_510]), precise::min(precise::max(FfxDofLDSFarLuma[_507], FfxDofLDSFarLuma[_510]), FfxDofLDSFarLuma[_513]))));
            float _551 = precise::max(precise::min(_523, _539), precise::min(precise::max(_523, _539), precise::min(precise::max(FfxDofLDSFarLuma[_480], precise::max(FfxDofLDSFarLuma[_492], FfxDofLDSFarLuma[_495])), precise::min(precise::max(FfxDofLDSFarLuma[_498], precise::max(FfxDofLDSFarLuma[_501], FfxDofLDSFarLuma[_504])), precise::max(FfxDofLDSFarLuma[_507], precise::max(FfxDofLDSFarLuma[_510], FfxDofLDSFarLuma[_513]))))));
            float _553 = FfxDofLDSFarR[_501];
            float _555 = FfxDofLDSFarG[_501];
            float _557 = FfxDofLDSFarB[_501];
            float _560 = FfxDofLDSFarLuma[_501];
            float3 _565 = float4(_553, _555, _557, _122).xyz * ((_551 == 0.0) ? 1.0 : fast::clamp(_551 / _560, 0.0, 2.0));
            float _567 = FfxDofLDSFarA[_501];
            float _568 = _565.x;
            float4 _571 = float4(_568, _565.yz, _567);
            bool _572 = gl_LocalInvocationIndex < 17u;
            float4 _658;
            if (_572)
            {
                uint _578 = _489 + 1u;
                uint _581 = _489 + 2u;
                uint _584 = _489 + 11u;
                uint _587 = _489 + 12u;
                uint _590 = _489 + 13u;
                uint _593 = _489 + 22u;
                uint _596 = _489 + 23u;
                uint _599 = _489 + 24u;
                float _609 = precise::max(precise::min(FfxDofLDSFarLuma[_489], precise::min(FfxDofLDSFarLuma[_578], FfxDofLDSFarLuma[_581])), precise::max(precise::min(FfxDofLDSFarLuma[_584], precise::min(FfxDofLDSFarLuma[_587], FfxDofLDSFarLuma[_590])), precise::min(FfxDofLDSFarLuma[_593], precise::min(FfxDofLDSFarLuma[_596], FfxDofLDSFarLuma[_599]))));
                float _613 = precise::max(precise::min(FfxDofLDSFarLuma[_489], FfxDofLDSFarLuma[_578]), precise::min(precise::max(FfxDofLDSFarLuma[_489], FfxDofLDSFarLuma[_578]), FfxDofLDSFarLuma[_581]));
                float _617 = precise::max(precise::min(FfxDofLDSFarLuma[_584], FfxDofLDSFarLuma[_587]), precise::min(precise::max(FfxDofLDSFarLuma[_584], FfxDofLDSFarLuma[_587]), FfxDofLDSFarLuma[_590]));
                float _625 = precise::max(precise::min(_613, _617), precise::min(precise::max(_613, _617), precise::max(precise::min(FfxDofLDSFarLuma[_593], FfxDofLDSFarLuma[_596]), precise::min(precise::max(FfxDofLDSFarLuma[_593], FfxDofLDSFarLuma[_596]), FfxDofLDSFarLuma[_599]))));
                float _637 = precise::max(precise::min(_609, _625), precise::min(precise::max(_609, _625), precise::min(precise::max(FfxDofLDSFarLuma[_489], precise::max(FfxDofLDSFarLuma[_578], FfxDofLDSFarLuma[_581])), precise::min(precise::max(FfxDofLDSFarLuma[_584], precise::max(FfxDofLDSFarLuma[_587], FfxDofLDSFarLuma[_590])), precise::max(FfxDofLDSFarLuma[_593], precise::max(FfxDofLDSFarLuma[_596], FfxDofLDSFarLuma[_599]))))));
                _658 = float4(float4(FfxDofLDSFarR[_587], FfxDofLDSFarG[_587], FfxDofLDSFarB[_587], _122).xyz * ((_637 == 0.0) ? 1.0 : fast::clamp(_637 / FfxDofLDSFarLuma[_587], 0.0, 2.0)), FfxDofLDSFarA[_587]);
            }
            else
            {
                _658 = float4(0.0);
            }
            float _684 = precise::max(precise::min(FfxDofLDSNearLuma[_480], precise::min(FfxDofLDSNearLuma[_492], FfxDofLDSNearLuma[_495])), precise::max(precise::min(FfxDofLDSNearLuma[_498], precise::min(FfxDofLDSNearLuma[_501], FfxDofLDSNearLuma[_504])), precise::min(FfxDofLDSNearLuma[_507], precise::min(FfxDofLDSNearLuma[_510], FfxDofLDSNearLuma[_513]))));
            float _688 = precise::max(precise::min(FfxDofLDSNearLuma[_480], FfxDofLDSNearLuma[_492]), precise::min(precise::max(FfxDofLDSNearLuma[_480], FfxDofLDSNearLuma[_492]), FfxDofLDSNearLuma[_495]));
            float _692 = precise::max(precise::min(FfxDofLDSNearLuma[_498], FfxDofLDSNearLuma[_501]), precise::min(precise::max(FfxDofLDSNearLuma[_498], FfxDofLDSNearLuma[_501]), FfxDofLDSNearLuma[_504]));
            float _700 = precise::max(precise::min(_688, _692), precise::min(precise::max(_688, _692), precise::max(precise::min(FfxDofLDSNearLuma[_507], FfxDofLDSNearLuma[_510]), precise::min(precise::max(FfxDofLDSNearLuma[_507], FfxDofLDSNearLuma[_510]), FfxDofLDSNearLuma[_513]))));
            float _712 = precise::max(precise::min(_684, _700), precise::min(precise::max(_684, _700), precise::min(precise::max(FfxDofLDSNearLuma[_480], precise::max(FfxDofLDSNearLuma[_492], FfxDofLDSNearLuma[_495])), precise::min(precise::max(FfxDofLDSNearLuma[_498], precise::max(FfxDofLDSNearLuma[_501], FfxDofLDSNearLuma[_504])), precise::max(FfxDofLDSNearLuma[_507], precise::max(FfxDofLDSNearLuma[_510], FfxDofLDSNearLuma[_513]))))));
            float _714 = FfxDofLDSNearA[_480];
            float _716 = FfxDofLDSNearA[_492];
            float _719 = FfxDofLDSNearA[_495];
            float _722 = FfxDofLDSNearA[_498];
            float _725 = FfxDofLDSNearA[_501];
            float _728 = FfxDofLDSNearA[_504];
            float _731 = FfxDofLDSNearA[_507];
            float _734 = FfxDofLDSNearA[_510];
            float _737 = FfxDofLDSNearA[_513];
            float _739 = 0.111111111938953399658203125 * ((((((((_714 + _716) + _719) + _722) + _725) + _728) + _731) + _734) + _737);
            uint _758;
            if (FfxDofLDSNearA[_501] < 0.00999999977648258209228515625)
            {
                uint _747 = (FfxDofLDSNearLuma[_495] > FfxDofLDSNearLuma[_480]) ? _495 : _480;
                uint _752 = (FfxDofLDSNearLuma[_507] > FfxDofLDSNearLuma[_747]) ? _507 : _747;
                _758 = (FfxDofLDSNearLuma[_513] > FfxDofLDSNearLuma[_752]) ? _513 : _752;
            }
            else
            {
                _758 = _501;
            }
            float _760 = FfxDofLDSNearR[_758];
            float _762 = FfxDofLDSNearG[_758];
            float _764 = FfxDofLDSNearB[_758];
            float _775;
            if (_712 > 0.0)
            {
                _775 = fast::clamp(_712 / FfxDofLDSNearLuma[_758], 0.0, 2.0);
            }
            else
            {
                _775 = 1.0;
            }
            float3 _776 = float4(_760, _762, _764, _122).xyz * _775;
            float _777 = _776.x;
            float4 _780 = float4(_777, _776.yz, _739);
            float4 _914;
            if (_572)
            {
                uint _786 = _489 + 1u;
                uint _789 = _489 + 2u;
                uint _792 = _489 + 11u;
                uint _795 = _489 + 12u;
                uint _798 = _489 + 13u;
                uint _801 = _489 + 22u;
                uint _804 = _489 + 23u;
                uint _807 = _489 + 24u;
                float _817 = precise::max(precise::min(FfxDofLDSNearLuma[_489], precise::min(FfxDofLDSNearLuma[_786], FfxDofLDSNearLuma[_789])), precise::max(precise::min(FfxDofLDSNearLuma[_792], precise::min(FfxDofLDSNearLuma[_795], FfxDofLDSNearLuma[_798])), precise::min(FfxDofLDSNearLuma[_801], precise::min(FfxDofLDSNearLuma[_804], FfxDofLDSNearLuma[_807]))));
                float _821 = precise::max(precise::min(FfxDofLDSNearLuma[_489], FfxDofLDSNearLuma[_786]), precise::min(precise::max(FfxDofLDSNearLuma[_489], FfxDofLDSNearLuma[_786]), FfxDofLDSNearLuma[_789]));
                float _825 = precise::max(precise::min(FfxDofLDSNearLuma[_792], FfxDofLDSNearLuma[_795]), precise::min(precise::max(FfxDofLDSNearLuma[_792], FfxDofLDSNearLuma[_795]), FfxDofLDSNearLuma[_798]));
                float _833 = precise::max(precise::min(_821, _825), precise::min(precise::max(_821, _825), precise::max(precise::min(FfxDofLDSNearLuma[_801], FfxDofLDSNearLuma[_804]), precise::min(precise::max(FfxDofLDSNearLuma[_801], FfxDofLDSNearLuma[_804]), FfxDofLDSNearLuma[_807]))));
                float _845 = precise::max(precise::min(_817, _833), precise::min(precise::max(_817, _833), precise::min(precise::max(FfxDofLDSNearLuma[_489], precise::max(FfxDofLDSNearLuma[_786], FfxDofLDSNearLuma[_789])), precise::min(precise::max(FfxDofLDSNearLuma[_792], precise::max(FfxDofLDSNearLuma[_795], FfxDofLDSNearLuma[_798])), precise::max(FfxDofLDSNearLuma[_801], precise::max(FfxDofLDSNearLuma[_804], FfxDofLDSNearLuma[_807]))))));
                uint _891;
                if (FfxDofLDSNearA[_795] < 0.00999999977648258209228515625)
                {
                    uint _880 = (FfxDofLDSNearLuma[_789] > FfxDofLDSNearLuma[_489]) ? _789 : _489;
                    uint _885 = (FfxDofLDSNearLuma[_801] > FfxDofLDSNearLuma[_880]) ? _801 : _880;
                    _891 = (FfxDofLDSNearLuma[_807] > FfxDofLDSNearLuma[_885]) ? _807 : _885;
                }
                else
                {
                    _891 = _795;
                }
                float _908;
                if (_845 > 0.0)
                {
                    _908 = fast::clamp(_845 / FfxDofLDSNearLuma[_891], 0.0, 2.0);
                }
                else
                {
                    _908 = 1.0;
                }
                _914 = float4(float4(FfxDofLDSNearR[_891], FfxDofLDSNearG[_891], FfxDofLDSNearB[_891], _122).xyz * _908, 0.111111111938953399658203125 * ((((((((FfxDofLDSNearA[_489] + FfxDofLDSNearA[_786]) + FfxDofLDSNearA[_789]) + FfxDofLDSNearA[_792]) + FfxDofLDSNearA[_795]) + FfxDofLDSNearA[_798]) + FfxDofLDSNearA[_801]) + FfxDofLDSNearA[_804]) + FfxDofLDSNearA[_807]));
            }
            else
            {
                _914 = float4(0.0);
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            FfxDofLDSNearR[_480] = _777;
            FfxDofLDSNearG[_480] = _776.y;
            FfxDofLDSNearB[_480] = _776.z;
            FfxDofLDSNearA[_480] = _739;
            FfxDofLDSFarR[_480] = _568;
            FfxDofLDSFarG[_480] = _565.y;
            FfxDofLDSFarB[_480] = _565.z;
            FfxDofLDSFarA[_480] = _567;
            if (_572)
            {
                FfxDofLDSNearR[_489] = _914.x;
                FfxDofLDSNearG[_489] = _914.y;
                FfxDofLDSNearB[_489] = _914.z;
                FfxDofLDSNearA[_489] = _914.w;
                FfxDofLDSFarR[_489] = _658.x;
                FfxDofLDSFarG[_489] = _658.y;
                FfxDofLDSFarB[_489] = _658.z;
                FfxDofLDSFarA[_489] = _658.w;
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            float4 _946 = _780 * 0.5;
            float4 _956 = _946 + (float4(FfxDofLDSNearR[_492], FfxDofLDSNearG[_492], FfxDofLDSNearB[_492], FfxDofLDSNearA[_492]) * 0.5);
            float4 _966 = _946 + (float4(FfxDofLDSNearR[_498], FfxDofLDSNearG[_498], FfxDofLDSNearB[_498], FfxDofLDSNearA[_498]) * 0.5);
            float4 _984 = ((_956 * 0.5) + (float4(FfxDofLDSNearR[_498], FfxDofLDSNearG[_498], FfxDofLDSNearB[_498], FfxDofLDSNearA[_498]) * 0.25)) + (float4(FfxDofLDSNearR[_501], FfxDofLDSNearG[_501], FfxDofLDSNearB[_501], FfxDofLDSNearA[_501]) * 0.25);
            float4 _985 = _571 * 0.5;
            float4 _996 = _985 + (float4(FfxDofLDSFarR[_492], FfxDofLDSFarG[_492], FfxDofLDSFarB[_492], FfxDofLDSFarA[_492]) * 0.5);
            float4 _1007 = _985 + (float4(FfxDofLDSFarR[_498], FfxDofLDSFarG[_498], FfxDofLDSFarB[_498], FfxDofLDSFarA[_498]) * 0.5);
            float4 _1022 = ((_996 * 0.5) + (float4(FfxDofLDSFarR[_498], FfxDofLDSFarG[_498], FfxDofLDSFarB[_498], FfxDofLDSFarA[_498]) * 0.25)) + (float4(FfxDofLDSFarR[_501], FfxDofLDSFarG[_501], FfxDofLDSFarB[_501], FfxDofLDSFarA[_501]) * 0.25);
            uint2 _1023 = uint2(2u) * gl_GlobalInvocationID.xy;
            uint2 _1024 = uint2(2u) * gl_LocalInvocationID.xy;
            float _1033;
            if (all(_1023 < cbDOF.inputSize))
            {
                _1033 = r_input_depth.read(uint2(_1023), 0u).x;
            }
            else
            {
                _1033 = 0.0;
            }
            uint _1034 = _1024.x;
            uint _1035 = _1024.y;
            uint _1036 = 18u * _1035;
            uint _1037 = _1034 + _1036;
            uint _1038 = _1037 + 19u;
            uint _1057 = _1037 + 2u;
            uint _1066 = _1037 + 36u;
            uint _1075 = _1037 + 38u;
            uint _1086 = _1037 + 1u;
            uint _1094 = _1037 + 18u;
            uint _1103 = _1037 + 20u;
            uint _1112 = _1037 + 37u;
            float3 _1123 = ((float3(FfxDofLDSFullColorR[_1038], FfxDofLDSFullColorG[_1038], FfxDofLDSFullColorB[_1038]) + ((((float3(FfxDofLDSFullColorR[_1037], FfxDofLDSFullColorG[_1037], FfxDofLDSFullColorB[_1037]) + float3(FfxDofLDSFullColorR[_1057], FfxDofLDSFullColorG[_1057], FfxDofLDSFullColorB[_1057])) + float3(FfxDofLDSFullColorR[_1066], FfxDofLDSFullColorG[_1066], FfxDofLDSFullColorB[_1066])) + float3(FfxDofLDSFullColorR[_1075], FfxDofLDSFullColorG[_1075], FfxDofLDSFullColorB[_1075])) * 0.545300006866455078125)) + ((((float3(FfxDofLDSFullColorR[_1086], FfxDofLDSFullColorG[_1086], FfxDofLDSFullColorB[_1086]) + float3(FfxDofLDSFullColorR[_1094], FfxDofLDSFullColorG[_1094], FfxDofLDSFullColorB[_1094])) + float3(FfxDofLDSFullColorR[_1103], FfxDofLDSFullColorG[_1103], FfxDofLDSFullColorB[_1103])) + float3(FfxDofLDSFullColorR[_1112], FfxDofLDSFullColorG[_1112], FfxDofLDSFullColorB[_1112])) * 0.971700012683868408203125)) * float3(0.1414827406406402587890625);
            float4 _1131;
            if (_567 > 0.0)
            {
                float3 _1129 = _571.xyz / float3(_567);
                _1131 = float4(_1129.x, _1129.y, _1129.z, _571.w);
            }
            else
            {
                _1131 = _571;
            }
            bool _1132 = precise::min(_739, precise::min(FfxDofLDSNearA[_492], precise::min(FfxDofLDSNearA[_498], FfxDofLDSNearA[_501]))) == 0.0;
            float4 _1136;
            if (_1132)
            {
                float4 _1135 = _780;
                _1135.w = 0.0;
                _1136 = _1135;
            }
            else
            {
                _1136 = _780;
            }
            float _1145 = -cbDOF.cocLimit;
            float _1148 = 2.0 * abs(fast::clamp((cbDOF.cocScale * _1033) + cbDOF.cocBias, _1145, cbDOF.cocLimit));
            float4 _1172 = float4(mix(mix(mix(float3(FfxDofLDSFullColorR[_1038], FfxDofLDSFullColorG[_1038], FfxDofLDSFullColorB[_1038]), _1123, float3(fast::clamp(_1148 - 0.5, 0.0, 1.0))), _1131.xyz, float3((_1131.w == 0.0) ? 0.0 : fast::clamp(_1148 - 1.5, 0.0, 1.0))), _1136.xyz, float3((_1136.w * _1136.w) * (3.0 - (2.0 * _1136.w)))), 1.0);
            uint _1173 = _1023.x;
            uint _1174 = _1173 + 1u;
            uint2 _1175 = _1023;
            _1175.x = _1174;
            uint _1176 = _1034 + 1u;
            float _1185;
            if (all(_1175 < cbDOF.inputSize))
            {
                _1185 = r_input_depth.read(uint2(_1175), 0u).x;
            }
            else
            {
                _1185 = 0.0;
            }
            uint _1186 = _1176 + _1036;
            uint _1187 = _1186 + 19u;
            uint _1206 = _1186 + 2u;
            uint _1215 = _1186 + 36u;
            uint _1224 = _1186 + 38u;
            uint _1235 = _1186 + 1u;
            uint _1243 = _1186 + 18u;
            uint _1252 = _1186 + 20u;
            uint _1261 = _1186 + 37u;
            float3 _1272 = ((float3(FfxDofLDSFullColorR[_1187], FfxDofLDSFullColorG[_1187], FfxDofLDSFullColorB[_1187]) + ((((float3(FfxDofLDSFullColorR[_1186], FfxDofLDSFullColorG[_1186], FfxDofLDSFullColorB[_1186]) + float3(FfxDofLDSFullColorR[_1206], FfxDofLDSFullColorG[_1206], FfxDofLDSFullColorB[_1206])) + float3(FfxDofLDSFullColorR[_1215], FfxDofLDSFullColorG[_1215], FfxDofLDSFullColorB[_1215])) + float3(FfxDofLDSFullColorR[_1224], FfxDofLDSFullColorG[_1224], FfxDofLDSFullColorB[_1224])) * 0.545300006866455078125)) + ((((float3(FfxDofLDSFullColorR[_1235], FfxDofLDSFullColorG[_1235], FfxDofLDSFullColorB[_1235]) + float3(FfxDofLDSFullColorR[_1243], FfxDofLDSFullColorG[_1243], FfxDofLDSFullColorB[_1243])) + float3(FfxDofLDSFullColorR[_1252], FfxDofLDSFullColorG[_1252], FfxDofLDSFullColorB[_1252])) + float3(FfxDofLDSFullColorR[_1261], FfxDofLDSFullColorG[_1261], FfxDofLDSFullColorB[_1261])) * 0.971700012683868408203125)) * float3(0.1414827406406402587890625);
            float _1273 = _996.w;
            float4 _1281;
            if (_1273 > 0.0)
            {
                float3 _1279 = _996.xyz / float3(_1273);
                _1281 = float4(_1279.x, _1279.y, _1279.z, _996.w);
            }
            else
            {
                _1281 = _996;
            }
            float4 _1285;
            if (_1132)
            {
                float4 _1284 = _956;
                _1284.w = 0.0;
                _1285 = _1284;
            }
            else
            {
                _1285 = _956;
            }
            float _1290 = 2.0 * abs(fast::clamp((cbDOF.cocScale * _1185) + cbDOF.cocBias, _1145, cbDOF.cocLimit));
            float4 _1314 = float4(mix(mix(mix(float3(FfxDofLDSFullColorR[_1187], FfxDofLDSFullColorG[_1187], FfxDofLDSFullColorB[_1187]), _1272, float3(fast::clamp(_1290 - 0.5, 0.0, 1.0))), _1281.xyz, float3((_1281.w == 0.0) ? 0.0 : fast::clamp(_1290 - 1.5, 0.0, 1.0))), _1285.xyz, float3((_1285.w * _1285.w) * (3.0 - (2.0 * _1285.w)))), 1.0);
            uint2 _1317 = uint2(_1174, _1023.y + 1u);
            float _1327;
            if (all(_1317 < cbDOF.inputSize))
            {
                _1327 = r_input_depth.read(uint2(_1317), 0u).x;
            }
            else
            {
                _1327 = 0.0;
            }
            uint _1328 = 18u * (_1035 + 1u);
            uint _1329 = _1176 + _1328;
            uint _1330 = _1329 + 19u;
            uint _1349 = _1329 + 2u;
            uint _1358 = _1329 + 36u;
            uint _1367 = _1329 + 38u;
            uint _1378 = _1329 + 1u;
            uint _1386 = _1329 + 18u;
            uint _1395 = _1329 + 20u;
            uint _1404 = _1329 + 37u;
            float3 _1415 = ((float3(FfxDofLDSFullColorR[_1330], FfxDofLDSFullColorG[_1330], FfxDofLDSFullColorB[_1330]) + ((((float3(FfxDofLDSFullColorR[_1329], FfxDofLDSFullColorG[_1329], FfxDofLDSFullColorB[_1329]) + float3(FfxDofLDSFullColorR[_1349], FfxDofLDSFullColorG[_1349], FfxDofLDSFullColorB[_1349])) + float3(FfxDofLDSFullColorR[_1358], FfxDofLDSFullColorG[_1358], FfxDofLDSFullColorB[_1358])) + float3(FfxDofLDSFullColorR[_1367], FfxDofLDSFullColorG[_1367], FfxDofLDSFullColorB[_1367])) * 0.545300006866455078125)) + ((((float3(FfxDofLDSFullColorR[_1378], FfxDofLDSFullColorG[_1378], FfxDofLDSFullColorB[_1378]) + float3(FfxDofLDSFullColorR[_1386], FfxDofLDSFullColorG[_1386], FfxDofLDSFullColorB[_1386])) + float3(FfxDofLDSFullColorR[_1395], FfxDofLDSFullColorG[_1395], FfxDofLDSFullColorB[_1395])) + float3(FfxDofLDSFullColorR[_1404], FfxDofLDSFullColorG[_1404], FfxDofLDSFullColorB[_1404])) * 0.971700012683868408203125)) * float3(0.1414827406406402587890625);
            float _1416 = _1022.w;
            float4 _1424;
            if (_1416 > 0.0)
            {
                float3 _1422 = _1022.xyz / float3(_1416);
                _1424 = float4(_1422.x, _1422.y, _1422.z, _1022.w);
            }
            else
            {
                _1424 = _1022;
            }
            float4 _1428;
            if (_1132)
            {
                float4 _1427 = _984;
                _1427.w = 0.0;
                _1428 = _1427;
            }
            else
            {
                _1428 = _984;
            }
            float _1433 = 2.0 * abs(fast::clamp((cbDOF.cocScale * _1327) + cbDOF.cocBias, _1145, cbDOF.cocLimit));
            float4 _1457 = float4(mix(mix(mix(float3(FfxDofLDSFullColorR[_1330], FfxDofLDSFullColorG[_1330], FfxDofLDSFullColorB[_1330]), _1415, float3(fast::clamp(_1433 - 0.5, 0.0, 1.0))), _1424.xyz, float3((_1424.w == 0.0) ? 0.0 : fast::clamp(_1433 - 1.5, 0.0, 1.0))), _1428.xyz, float3((_1428.w * _1428.w) * (3.0 - (2.0 * _1428.w)))), 1.0);
            uint2 _1458 = _1317;
            _1458.x = _1173;
            float _1467;
            if (all(_1458 < cbDOF.inputSize))
            {
                _1467 = r_input_depth.read(uint2(_1458), 0u).x;
            }
            else
            {
                _1467 = 0.0;
            }
            uint _1468 = _1034 + _1328;
            uint _1469 = _1468 + 19u;
            uint _1488 = _1468 + 2u;
            uint _1497 = _1468 + 36u;
            uint _1506 = _1468 + 38u;
            uint _1517 = _1468 + 1u;
            uint _1525 = _1468 + 18u;
            uint _1534 = _1468 + 20u;
            uint _1543 = _1468 + 37u;
            float3 _1554 = ((float3(FfxDofLDSFullColorR[_1469], FfxDofLDSFullColorG[_1469], FfxDofLDSFullColorB[_1469]) + ((((float3(FfxDofLDSFullColorR[_1468], FfxDofLDSFullColorG[_1468], FfxDofLDSFullColorB[_1468]) + float3(FfxDofLDSFullColorR[_1488], FfxDofLDSFullColorG[_1488], FfxDofLDSFullColorB[_1488])) + float3(FfxDofLDSFullColorR[_1497], FfxDofLDSFullColorG[_1497], FfxDofLDSFullColorB[_1497])) + float3(FfxDofLDSFullColorR[_1506], FfxDofLDSFullColorG[_1506], FfxDofLDSFullColorB[_1506])) * 0.545300006866455078125)) + ((((float3(FfxDofLDSFullColorR[_1517], FfxDofLDSFullColorG[_1517], FfxDofLDSFullColorB[_1517]) + float3(FfxDofLDSFullColorR[_1525], FfxDofLDSFullColorG[_1525], FfxDofLDSFullColorB[_1525])) + float3(FfxDofLDSFullColorR[_1534], FfxDofLDSFullColorG[_1534], FfxDofLDSFullColorB[_1534])) + float3(FfxDofLDSFullColorR[_1543], FfxDofLDSFullColorG[_1543], FfxDofLDSFullColorB[_1543])) * 0.971700012683868408203125)) * float3(0.1414827406406402587890625);
            float _1555 = _1007.w;
            float4 _1563;
            if (_1555 > 0.0)
            {
                float3 _1561 = _1007.xyz / float3(_1555);
                _1563 = float4(_1561.x, _1561.y, _1561.z, _1007.w);
            }
            else
            {
                _1563 = _1007;
            }
            float4 _1567;
            if (_1132)
            {
                float4 _1566 = _966;
                _1566.w = 0.0;
                _1567 = _1566;
            }
            else
            {
                _1567 = _966;
            }
            bool _1616;
            float _1572 = 2.0 * abs(fast::clamp((cbDOF.cocScale * _1467) + cbDOF.cocBias, _1145, cbDOF.cocLimit));
            float4 _1596 = float4(mix(mix(mix(float3(FfxDofLDSFullColorR[_1469], FfxDofLDSFullColorG[_1469], FfxDofLDSFullColorB[_1469]), _1554, float3(fast::clamp(_1572 - 0.5, 0.0, 1.0))), _1563.xyz, float3((_1563.w == 0.0) ? 0.0 : fast::clamp(_1572 - 1.5, 0.0, 1.0))), _1567.xyz, float3((_1567.w * _1567.w) * (3.0 - (2.0 * _1567.w)))), 1.0);
            uint2 _1598 = as_type<uint2>(_1172.xy);
            uint2 _1600 = as_type<uint2>(_1172.zw);
            uint2 _1602 = as_type<uint2>(_1314.xy);
            uint2 _1604 = as_type<uint2>(_1314.zw);
            uint2 _1606 = as_type<uint2>(_1457.xy);
            uint2 _1608 = as_type<uint2>(_1457.zw);
            uint2 _1610 = as_type<uint2>(_1596.xy);
            uint2 _1612 = as_type<uint2>(_1596.zw);
            uint2 _1654;
            uint2 _1655;
            uint2 _1656;
            uint2 _1657;
            do
            {
                _1616 = gl_SubgroupSize < 32u;
                if (_1616)
                {
                    _1654 = _1610;
                    _1655 = _1606;
                    _1656 = _1602;
                    _1657 = _1598;
                    break;
                }
                uint _1623 = ((gl_SubgroupInvocationID & 3u) << 3u) + (gl_SubgroupInvocationID >> 2u);
                uint _1624 = gl_SubgroupInvocationID & 4294967264u;
                uint2 _1627 = spvSubgroupShuffle(_1598, _1624 + (_1623 % 32u));
                uint2 _1631 = spvSubgroupShuffle(_1602, _1624 + ((_1623 + 8u) % 32u));
                uint2 _1635 = spvSubgroupShuffle(_1606, _1624 + ((_1623 + 16u) % 32u));
                uint2 _1639 = spvSubgroupShuffle(_1610, _1624 + ((_1623 + 24u) % 32u));
                bool2 _1642 = bool2((gl_SubgroupInvocationID & 1u) != 0u);
                uint2 _1643 = select(_1639, _1635, _1642);
                uint2 _1644 = select(_1631, _1627, _1642);
                uint2 _1645 = select(_1635, _1631, _1642);
                uint2 _1646 = select(_1627, _1639, _1642);
                bool2 _1649 = bool2((gl_SubgroupInvocationID & 2u) != 0u);
                _1654 = select(_1643, _1644, _1649);
                _1655 = select(_1645, _1646, _1649);
                _1656 = select(_1644, _1643, _1649);
                _1657 = select(_1646, _1645, _1649);
                break;
            } while(false);
            uint2 _1697;
            uint2 _1698;
            uint2 _1699;
            uint2 _1700;
            do
            {
                if (_1616)
                {
                    _1697 = _1612;
                    _1698 = _1608;
                    _1699 = _1604;
                    _1700 = _1600;
                    break;
                }
                uint _1666 = ((gl_SubgroupInvocationID & 3u) << 3u) + (gl_SubgroupInvocationID >> 2u);
                uint _1667 = gl_SubgroupInvocationID & 4294967264u;
                uint2 _1670 = spvSubgroupShuffle(_1600, _1667 + (_1666 % 32u));
                uint2 _1674 = spvSubgroupShuffle(_1604, _1667 + ((_1666 + 8u) % 32u));
                uint2 _1678 = spvSubgroupShuffle(_1608, _1667 + ((_1666 + 16u) % 32u));
                uint2 _1682 = spvSubgroupShuffle(_1612, _1667 + ((_1666 + 24u) % 32u));
                bool2 _1685 = bool2((gl_SubgroupInvocationID & 1u) != 0u);
                uint2 _1686 = select(_1682, _1678, _1685);
                uint2 _1687 = select(_1674, _1670, _1685);
                uint2 _1688 = select(_1678, _1674, _1685);
                uint2 _1689 = select(_1670, _1682, _1685);
                bool2 _1692 = bool2((gl_SubgroupInvocationID & 2u) != 0u);
                _1697 = select(_1686, _1687, _1692);
                _1698 = select(_1688, _1689, _1692);
                _1699 = select(_1687, _1686, _1692);
                _1700 = select(_1689, _1688, _1692);
                break;
            } while(false);
            uint2 _1768;
            uint2 _1769;
            uint2 _1770;
            uint2 _1771;
            do
            {
                if (_1616)
                {
                    _1768 = _1458;
                    _1769 = _1317;
                    _1770 = _1175;
                    _1771 = _1023;
                    break;
                }
                uint _1737 = ((gl_SubgroupInvocationID & 3u) << 3u) + (gl_SubgroupInvocationID >> 2u);
                uint _1738 = gl_SubgroupInvocationID & 4294967264u;
                uint2 _1741 = spvSubgroupShuffle(_1023, _1738 + (_1737 % 32u));
                uint2 _1745 = spvSubgroupShuffle(_1175, _1738 + ((_1737 + 8u) % 32u));
                uint2 _1749 = spvSubgroupShuffle(_1317, _1738 + ((_1737 + 16u) % 32u));
                uint2 _1753 = spvSubgroupShuffle(_1458, _1738 + ((_1737 + 24u) % 32u));
                bool2 _1756 = bool2((gl_SubgroupInvocationID & 1u) != 0u);
                uint2 _1757 = select(_1753, _1749, _1756);
                uint2 _1758 = select(_1745, _1741, _1756);
                uint2 _1759 = select(_1749, _1745, _1756);
                uint2 _1760 = select(_1741, _1753, _1756);
                bool2 _1763 = bool2((gl_SubgroupInvocationID & 2u) != 0u);
                _1768 = select(_1757, _1758, _1763);
                _1769 = select(_1759, _1760, _1763);
                _1770 = select(_1758, _1757, _1763);
                _1771 = select(_1760, _1759, _1763);
                break;
            } while(false);
            if (all(_1771 < cbDOF.inputSize))
            {
                rw_output_color.write(float4(as_type<float2>(_1657), as_type<float2>(_1700)), uint2(_1771));
            }
            if (all(_1770 < cbDOF.inputSize))
            {
                rw_output_color.write(float4(as_type<float2>(_1656), as_type<float2>(_1699)), uint2(_1770));
            }
            if (all(_1769 < cbDOF.inputSize))
            {
                rw_output_color.write(float4(as_type<float2>(_1655), as_type<float2>(_1698)), uint2(_1769));
            }
            if (all(_1768 < cbDOF.inputSize))
            {
                rw_output_color.write(float4(as_type<float2>(_1654), as_type<float2>(_1697)), uint2(_1768));
            }
        }
    }
}

)DOF_GPU";
inline constexpr Binding bindings5[]={{"cbDOF","buffer",0},{"rw_internal_globals","buffer",1},{"r_internal_bilat_color","texture",0},{"r_internal_dilated_radius","texture",1},{"rw_internal_near","texture",2},{"rw_internal_far","texture",3},{"LinearSampler","sampler",0},{"PointSampler","sampler",1}};
inline constexpr const char*source5=R"DOF_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"

#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

template<typename T>
inline T spvSubgroupBroadcastFirst(T value)
{
    return simd_broadcast_first(value);
}

template<>
inline bool spvSubgroupBroadcastFirst(bool value)
{
    return !!simd_broadcast_first((ushort)value);
}

template<uint N>
inline vec<bool, N> spvSubgroupBroadcastFirst(vec<bool, N> value)
{
    return (vec<bool, N>)simd_broadcast_first((vec<ushort, N>)value);
}

struct type_cbDOF
{
    float cocScale;
    float cocBias;
    uint2 inputSizeHalf;
    uint2 inputSize;
    float2 inputSizeHalfRcp;
    float cocLimit;
    uint maxRings;
};

struct DofGlobalVars
{
    uint maxTileRad;
};

struct type_RWStructuredBuffer_DofGlobalVars
{
    DofGlobalVars _m0[1];
};

constant float _81 = {};
constant uint _82 = {};
constant bool _83 = {};
constant float2 _84 = {};

kernel void CS(constant type_cbDOF& cbDOF [[buffer(0)]], volatile device type_RWStructuredBuffer_DofGlobalVars& rw_internal_globals [[buffer(1)]], texture2d<float> r_internal_bilat_color [[texture(0)]], texture2d<float> r_internal_dilated_radius [[texture(1)]], texture2d<float, access::write> rw_internal_near [[texture(2)]], texture2d<float, access::write> rw_internal_far [[texture(3)]], sampler LinearSampler [[sampler(0)]], sampler PointSampler [[sampler(1)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    do
    {
        float2 _100;
        rw_internal_globals._m0[0u].maxTileRad = 0u;
        float2 _179;
        float _180;
        float _181;
        uint _182;
        bool _183;
        uint _184;
        uint _185;
        float _186;
        float _187;
        float _188;
        bool _189;
        bool _190;
        bool _191;
        do
        {
            float2 _98 = float2(gl_GlobalInvocationID.xy);
            _100 = cbDOF.inputSizeHalfRcp;
            float4 _103 = r_internal_dilated_radius.sample(LinearSampler, (_98 * _100), level(0.0));
            float2 _105 = abs(_103.xy);
            float _108 = precise::max(_105.x, _105.y);
            if (simd_all(_108 < 0.5))
            {
                _179 = _84;
                _180 = _81;
                _181 = _81;
                _182 = _82;
                _183 = _83;
                _184 = _82;
                _185 = _82;
                _186 = _81;
                _187 = _81;
                _188 = _81;
                _189 = false;
                _190 = false;
                _191 = false;
                break;
            }
            float _114 = simd_max(ceil(_108));
            float _118 = float(cbDOF.maxRings);
            bool _119 = _114 > _118;
            uint _126;
            if (_119)
            {
                _126 = uint(log2(_114 * (1.0 / _118)));
            }
            else
            {
                _126 = 0u;
            }
            uint _127 = _119 ? cbDOF.maxRings : uint(_114);
            float _128 = float(_127);
            float3 _133 = (_98 + float2(0.25)).xyx * float3(0.103100001811981201171875, 0.10300000011920928955078125, 0.097300000488758087158203125);
            float3 _135 = _133 - floor(_133);
            float3 _140 = _135 + float3(dot(_135, _135.yzx + float3(33.3300018310546875)));
            float2 _145 = (_140.xx + _140.yz) * _140.zy;
            float4 _157;
            if (all(gl_GlobalInvocationID.xy < cbDOF.inputSizeHalf))
            {
                _157 = r_internal_bilat_color.read(uint2(gl_GlobalInvocationID.xy), 0u);
            }
            else
            {
                _157 = float4(0.0);
            }
            float _166 = 0.5 / _128;
            float _170 = _103.x;
            float _173 = _103.y;
            _179 = _98 + ((_145 - floor(_145)) * 0.5);
            _180 = _108;
            _181 = (_114 / _128) - 1.0;
            _182 = _126;
            _183 = _157.w > 0.0;
            _184 = uint(3.125 * float(_127 * (_127 + 1u)));
            _185 = _127;
            _186 = spvSubgroupBroadcastFirst(_166 * _108);
            _187 = spvSubgroupBroadcastFirst(_166);
            _188 = abs(_157.w);
            _189 = simd_all((_170 - _173) < 0.5);
            _190 = simd_any(_170 > (-1.0));
            _191 = simd_any(_173 < 1.0);
            break;
        } while(false);
        float _194 = fast::clamp(0.25 / (_188 * _188), 0.0, 1.0);
        bool _199 = all(gl_GlobalInvocationID.xy < cbDOF.inputSizeHalf);
        float4 _205;
        if (_199)
        {
            _205 = r_internal_bilat_color.read(uint2(gl_GlobalInvocationID.xy), 0u);
        }
        else
        {
            _205 = float4(0.0);
        }
        float4 _209 = float4(_205.xyz, 1.0);
        float4 _226;
        float4 _227;
        if (_183)
        {
            float _218 = precise::max(1.0, (_180 * (1.0 / float(_185))) - powr(2.0, float(_182)));
            float _220 = fast::clamp(_188, 0.0, 1.0);
            _226 = ((_209 * _194) * (_218 * _218)) * _220;
            _227 = _209 * (1.0 - _220);
        }
        else
        {
            _226 = float4(0.0);
            _227 = float4(0.0);
        }
        float4 _2771;
        float4 _2772;
        float4 _2773;
        float _2774;
        uint _2775;
        float _2776;
        if (_190 ? _191 : false)
        {
            float4 _233;
            float4 _236;
            float4 _238;
            float _240;
            uint _242;
            float _244;
            _233 = _226;
            _236 = _227;
            _238 = float4(0.0);
            _240 = 0.0;
            _242 = 0u;
            _244 = 0.0;
            float4 _239;
            float _241;
            uint _243;
            float _245;
            float4 _234;
            float4 _237;
            for (uint _246 = 0u; _246 < _185; _233 = _234, _236 = _237, _238 = _239, _240 = _241, _242 = _243, _244 = _245, _246++)
            {
                float _251 = float(_185);
                float _252 = 1.0 / _251;
                float _254 = float(_185 - _246);
                float _255 = _252 * _254;
                float _257 = _251 - float(_246);
                uint _260 = (27u * uint(_257)) >> 2u;
                float _261 = _180 * _252;
                float _266 = float(_260);
                float _267 = 6.283185482025146484375 / _266;
                float _268 = sin(_267);
                float _269 = cos(_267);
                float2 _272 = float2(cbDOF.inputSizeHalf) * _100.yx;
                float _274 = _268 * _272.x;
                float _275 = -_268;
                float _277 = _275 * _272.y;
                float2 _286 = _100 * ((_179 - (float2(_269, _268) * _179.x)) - (float2(_275, _269) * _179.y));
                float _287 = _261 * _254;
                float _295 = ((float((_185 - 1u) - _246) + 2.5) * _180) * (1.0 / (0.5 + _251));
                float _296 = _287 - _181;
                float _298 = precise::max(0.0, _296 - 0.5);
                float _299 = precise::max(0.0, _296);
                float _300 = _188 - _287;
                float _302 = 1.0 / (_287 * _287);
                float4 _304;
                float4 _307;
                float2 _309;
                float4 _311;
                float4 _313;
                float _315;
                uint _317;
                float _319;
                uint _321;
                uint _323;
                _304 = _233;
                _307 = _236;
                _309 = _100 * (_179 + float2(_261 * _257, 0.0));
                _311 = float4(0.0);
                _313 = _238;
                _315 = 0.0;
                _317 = _242;
                _319 = _244;
                _321 = 0u;
                _323 = 0u;
                float4 _305;
                float2 _310;
                float4 _308;
                float4 _312;
                float4 _314;
                float _316;
                uint _318;
                float _320;
                uint _322;
                uint _324;
                for (;;)
                {
                    _324 = _323 + 2u;
                    if (_324 <= _260)
                    {
                        float2 _337 = float2((_269 * _309.x) + (_277 * _309.y), (_274 * _309.x) + (_269 * _309.y)) + _286;
                        uint2 _339 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                        float2 _346 = float2(max((cbDOF.inputSizeHalf >> (uint2(_182) & uint2(31u))), uint2(1u)));
                        float2 _347 = float2(0.5) / _346;
                        float2 _348 = float2(1.0) - _347;
                        float _357 = float(_182);
                        float4 _359 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_309, _347, _348) * _346) / float2(float(_339.x), float(_339.y))), level(_357));
                        float _360 = _359.w;
                        float _361 = -_360;
                        float _364 = abs(_360);
                        float _367 = fast::clamp((_186 / _364) + _187, 0.0, 1.0);
                        float4 _375 = float4(_359.xyz, 1.0) * fast::clamp(0.25 / (_364 * _364), 0.0, 1.0);
                        float4 _376 = _375 * fast::clamp(_361 - _299, 0.0, 1.0);
                        uint _387;
                        float4 _388;
                        float _389;
                        uint _390;
                        float4 _391;
                        float _392;
                        if (_361 >= _295)
                        {
                            _387 = _317 + 1u;
                            _388 = _313 + _376;
                            _389 = _319 + _367;
                            _390 = _321;
                            _391 = _311;
                            _392 = _315;
                        }
                        else
                        {
                            _387 = _317;
                            _388 = _313;
                            _389 = _319;
                            _390 = _321 + 1u;
                            _391 = _311 + _376;
                            _392 = _315 + _367;
                        }
                        float4 _402;
                        if (_183)
                        {
                            _402 = _307 + ((_375 * _302) * ((_360 < _300) ? 1.0 : 0.00048828125));
                        }
                        else
                        {
                            _402 = _307;
                        }
                        float _405 = _337.x;
                        float _407 = _337.y;
                        _310 = float2((_269 * _405) + (_277 * _407), (_274 * _405) + (_269 * _407)) + _286;
                        uint2 _415 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                        float4 _427 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_337, _347, _348) * _346) / float2(float(_415.x), float(_415.y))), level(_357));
                        float _428 = _427.w;
                        float _429 = -_428;
                        float _432 = abs(_428);
                        float _435 = fast::clamp((_186 / _432) + _187, 0.0, 1.0);
                        float4 _443 = float4(_427.xyz, 1.0) * fast::clamp(0.25 / (_432 * _432), 0.0, 1.0);
                        float4 _444 = _443 * fast::clamp(_429 - _299, 0.0, 1.0);
                        if (_429 >= _295)
                        {
                            _318 = _387 + 1u;
                            _314 = _388 + _444;
                            _320 = _389 + _435;
                            _322 = _390;
                            _312 = _391;
                            _316 = _392;
                        }
                        else
                        {
                            _318 = _387;
                            _314 = _388;
                            _320 = _389;
                            _322 = _390 + 1u;
                            _312 = _391 + _444;
                            _316 = _392 + _435;
                        }
                        if (_183)
                        {
                            _308 = _402 + ((_443 * _302) * ((_428 < _300) ? 1.0 : 0.00048828125));
                        }
                        else
                        {
                            _308 = _402;
                        }
                        _305 = (_304 + (_375 * fast::clamp(_360 - _298, 0.0, 1.0))) + (_443 * fast::clamp(_428 - _298, 0.0, 1.0));
                        _304 = _305;
                        _307 = _308;
                        _309 = _310;
                        _311 = _312;
                        _313 = _314;
                        _315 = _316;
                        _317 = _318;
                        _319 = _320;
                        _321 = _322;
                        _323 = _324;
                        continue;
                    }
                    else
                    {
                        break;
                    }
                }
                float2 _469;
                float4 _471;
                float4 _473;
                float _475;
                uint _477;
                float _479;
                uint _481;
                _234 = _304;
                _237 = _307;
                _469 = _309;
                _471 = _311;
                _473 = _313;
                _475 = _315;
                _477 = _317;
                _479 = _319;
                _481 = _321;
                float4 _466;
                float2 _470;
                float4 _468;
                float4 _472;
                float4 _474;
                float _476;
                uint _478;
                float _480;
                uint _482;
                for (uint _483 = _323; _483 < _260; _234 = _466, _237 = _468, _469 = _470, _471 = _472, _473 = _474, _475 = _476, _477 = _478, _479 = _480, _481 = _482, _483++)
                {
                    _470 = float2((_269 * _469.x) + (_277 * _469.y), (_274 * _469.x) + (_269 * _469.y)) + _286;
                    uint2 _498 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                    float2 _505 = float2(max((cbDOF.inputSizeHalf >> (uint2(_182) & uint2(31u))), uint2(1u)));
                    float2 _506 = float2(0.5) / _505;
                    float4 _518 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_469, _506, float2(1.0) - _506) * _505) / float2(float(_498.x), float(_498.y))), level(float(_182)));
                    float _519 = _518.w;
                    float _520 = -_519;
                    float _523 = abs(_519);
                    float _526 = fast::clamp((_186 / _523) + _187, 0.0, 1.0);
                    float4 _534 = float4(_518.xyz, 1.0) * fast::clamp(0.25 / (_523 * _523), 0.0, 1.0);
                    float4 _535 = _534 * fast::clamp(_520 - _299, 0.0, 1.0);
                    if (_520 >= _295)
                    {
                        _472 = _471;
                        _474 = _473 + _535;
                        _476 = _475;
                        _478 = _477 + 1u;
                        _480 = _479 + _526;
                        _482 = _481;
                    }
                    else
                    {
                        _472 = _471 + _535;
                        _474 = _473;
                        _476 = _475 + _526;
                        _478 = _477;
                        _480 = _479;
                        _482 = _481 + 1u;
                    }
                    if (_183)
                    {
                        _468 = _237 + ((_534 * _302) * ((_519 < _300) ? 1.0 : 0.00048828125));
                    }
                    else
                    {
                        _468 = _237;
                    }
                    _466 = _234 + (_534 * fast::clamp(_519 - _298, 0.0, 1.0));
                }
                float _556 = float(_481);
                float _558 = float(_477);
                float _560 = fast::clamp(_479 / _558, 0.0, 1.0);
                float _562 = fast::clamp(_475 / _556, 0.0, 1.0);
                float _564 = fast::clamp(_240 + _560, 0.0, 1.0);
                float _565 = _240 - _560;
                float _567 = fast::clamp(_255 + _562, 0.0, 1.0);
                float _568 = _255 - _562;
                float _569 = precise::min(_564, _567);
                float _570 = precise::max(_565, _568);
                float _591;
                if (_569 < _570)
                {
                    _591 = 0.0;
                }
                else
                {
                    _591 = fast::clamp(((_569 * _569) - ((float(int(sign(_570))) * _570) * _570)) / ((_564 * _564) - ((float(int(sign(_565))) * _565) * _565)), 0.0, 1.0);
                }
                float _593 = 1.0 - ((_556 / _266) * _591);
                _239 = (_473 * _593) + _471;
                float _595 = precise::max(_564, _567);
                float _596 = precise::min(_565, _568);
                _241 = 0.5 * (_595 + _596);
                _243 = uint(_558 * _593) + _481;
                _245 = float(_243) * (0.5 * (_595 - _596));
            }
            _2771 = _233;
            _2772 = _236;
            _2773 = _238;
            _2774 = _240;
            _2775 = _242;
            _2776 = _244;
        }
        else
        {
            float4 _2765;
            float4 _2766;
            float4 _2767;
            float _2768;
            uint _2769;
            float _2770;
            if (_190)
            {
                float4 _1272;
                float4 _1273;
                if (_189)
                {
                    float4 _610;
                    _610 = _226;
                    float4 _611;
                    uint _614;
                    for (uint _613 = 0u; _613 < _185; _610 = _611, _613 = _614)
                    {
                        uint _622 = min(min((1u << (_613 & 31u)), 1u), (_185 - _613));
                        float _624 = float(_622);
                        float _629 = float(_185);
                        float _630 = _629 - ((float(_613) + (0.5 * _624)) - 0.5);
                        uint _633 = (27u * uint(_630)) >> 2u;
                        float _636 = (_180 * (1.0 / _629)) * _630;
                        float _642 = (6.283185482025146484375 / float(_633)) * _624;
                        float _643 = sin(_642);
                        float _644 = cos(_642);
                        float2 _647 = float2(cbDOF.inputSizeHalf) * _100.yx;
                        float _649 = _643 * _647.x;
                        float _650 = -_643;
                        float _652 = _650 * _647.y;
                        float2 _661 = _100 * ((_179 - (float2(_644, _643) * _179.x)) - (float2(_650, _644) * _179.y));
                        uint _662 = _633 / _622;
                        uint _665 = 2u * uint(log2(_624));
                        float _668 = precise::max(0.0, (_636 - _181) - 0.5);
                        float2 _670;
                        float _673;
                        float3 _675;
                        uint _677;
                        _670 = _100 * (_179 + float2(_636, 0.0));
                        _673 = 0.0;
                        _675 = float3(0.0);
                        _677 = 0u;
                        uint _678;
                        for (;;)
                        {
                            _678 = _677 + 6u;
                            if (_678 <= _662)
                            {
                                float2 _690 = float2((_644 * _670.x) + (_652 * _670.y), (_649 * _670.x) + (_644 * _670.y)) + _661;
                                uint _691 = _182 + _665;
                                uint2 _693 = uint2(r_internal_bilat_color.get_width(_691), r_internal_bilat_color.get_height(_691));
                                float2 _700 = float2(max((cbDOF.inputSizeHalf >> (uint2(_691) & uint2(31u))), uint2(1u)));
                                float2 _701 = float2(0.5) / _700;
                                float2 _702 = float2(1.0) - _701;
                                float _711 = float(_691);
                                float4 _713 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_670, _701, _702) * _700) / float2(float(_693.x), float(_693.y))), level(_711));
                                float _717 = fast::clamp(_713.w - _668, 0.0, 1.0);
                                float _721 = _690.x;
                                float _723 = _690.y;
                                float2 _730 = float2((_644 * _721) + (_652 * _723), (_649 * _721) + (_644 * _723)) + _661;
                                uint2 _732 = uint2(r_internal_bilat_color.get_width(_691), r_internal_bilat_color.get_height(_691));
                                float4 _744 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_690, _701, _702) * _700) / float2(float(_732.x), float(_732.y))), level(_711));
                                float _748 = fast::clamp(_744.w - _668, 0.0, 1.0);
                                float _752 = _730.x;
                                float _754 = _730.y;
                                float2 _761 = float2((_644 * _752) + (_652 * _754), (_649 * _752) + (_644 * _754)) + _661;
                                uint2 _763 = uint2(r_internal_bilat_color.get_width(_691), r_internal_bilat_color.get_height(_691));
                                float4 _775 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_730, _701, _702) * _700) / float2(float(_763.x), float(_763.y))), level(_711));
                                float _779 = fast::clamp(_775.w - _668, 0.0, 1.0);
                                float _783 = _761.x;
                                float _785 = _761.y;
                                float2 _792 = float2((_644 * _783) + (_652 * _785), (_649 * _783) + (_644 * _785)) + _661;
                                uint2 _794 = uint2(r_internal_bilat_color.get_width(_691), r_internal_bilat_color.get_height(_691));
                                float4 _806 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_761, _701, _702) * _700) / float2(float(_794.x), float(_794.y))), level(_711));
                                float _810 = fast::clamp(_806.w - _668, 0.0, 1.0);
                                float _814 = _792.x;
                                float _816 = _792.y;
                                float2 _823 = float2((_644 * _814) + (_652 * _816), (_649 * _814) + (_644 * _816)) + _661;
                                uint2 _825 = uint2(r_internal_bilat_color.get_width(_691), r_internal_bilat_color.get_height(_691));
                                float4 _837 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_792, _701, _702) * _700) / float2(float(_825.x), float(_825.y))), level(_711));
                                float _841 = fast::clamp(_837.w - _668, 0.0, 1.0);
                                float _845 = _823.x;
                                float _847 = _823.y;
                                uint2 _855 = uint2(r_internal_bilat_color.get_width(_691), r_internal_bilat_color.get_height(_691));
                                float4 _867 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_823, _701, _702) * _700) / float2(float(_855.x), float(_855.y))), level(_711));
                                float _871 = fast::clamp(_867.w - _668, 0.0, 1.0);
                                _670 = float2((_644 * _845) + (_652 * _847), (_649 * _845) + (_644 * _847)) + _661;
                                _673 = (((((_673 + _717) + _748) + _779) + _810) + _841) + _871;
                                _675 = (((((_675 + (_713.xyz * _717)) + (_744.xyz * _748)) + (_775.xyz * _779)) + (_806.xyz * _810)) + (_837.xyz * _841)) + (_867.xyz * _871);
                                _677 = _678;
                                continue;
                            }
                            else
                            {
                                break;
                            }
                        }
                        float2 _874;
                        float _877;
                        float3 _879;
                        _874 = _670;
                        _877 = _673;
                        _879 = _675;
                        for (uint _881 = _677; _881 < _662; )
                        {
                            uint _894 = _182 + _665;
                            uint2 _896 = uint2(r_internal_bilat_color.get_width(_894), r_internal_bilat_color.get_height(_894));
                            float2 _903 = float2(max((cbDOF.inputSizeHalf >> (uint2(_894) & uint2(31u))), uint2(1u)));
                            float2 _904 = float2(0.5) / _903;
                            float2 _906 = fast::clamp(_874, _904, float2(1.0) - _904);
                            float4 _916 = r_internal_bilat_color.sample(PointSampler, ((_906 * _903) / float2(float(_896.x), float(_896.y))), level(float(_894)));
                            float _920 = fast::clamp(_916.w - _668, 0.0, 1.0);
                            _874 = float2((_644 * _874.x) + (_652 * _874.y), (_649 * _874.x) + (_644 * _874.y)) + _661;
                            _877 += _920;
                            _879 += (_916.xyz * _920);
                            _881++;
                            continue;
                        }
                        float _922 = float(_622 * _622);
                        float3 _925 = _610.xyz + (_879 * _922);
                        _611 = float4(_925.x, _925.y, _925.z, _610.w);
                        _611.w = _610.w + (_877 * _922);
                        _614 = _613 + _622;
                    }
                    _1272 = _610;
                    _1273 = _227;
                }
                else
                {
                    float4 _934;
                    float4 _936;
                    _934 = _226;
                    _936 = _227;
                    float4 _935;
                    float4 _937;
                    for (uint _931 = 0u; _931 < _185; _931++, _934 = _935, _936 = _937)
                    {
                        float _942 = float(_185);
                        float _943 = _942 - float(_931);
                        uint _946 = (27u * uint(_943)) >> 2u;
                        float _948 = _180 * (1.0 / _942);
                        float _954 = 6.283185482025146484375 / float(_946);
                        float _955 = sin(_954);
                        float _956 = cos(_954);
                        float2 _959 = float2(cbDOF.inputSizeHalf) * _100.yx;
                        float _961 = _955 * _959.x;
                        float _962 = -_955;
                        float _964 = _962 * _959.y;
                        float2 _973 = _100 * ((_179 - (float2(_956, _955) * _179.x)) - (float2(_962, _956) * _179.y));
                        float _976 = _948 * float(_185 - _931);
                        float _979 = precise::max(0.0, (_976 - _181) - 0.5);
                        float _980 = _188 - _976;
                        float _982 = 1.0 / (_976 * _976);
                        float4 _984;
                        float4 _987;
                        float2 _989;
                        uint _991;
                        _984 = _934;
                        _987 = _936;
                        _989 = _100 * (_179 + float2(_948 * _943, 0.0));
                        _991 = 0u;
                        float4 _985;
                        float2 _990;
                        float4 _988;
                        uint _992;
                        for (;;)
                        {
                            _992 = _991 + 4u;
                            if (_992 <= _946)
                            {
                                float2 _1005 = float2((_956 * _989.x) + (_964 * _989.y), (_961 * _989.x) + (_956 * _989.y)) + _973;
                                uint2 _1007 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                float2 _1014 = float2(max((cbDOF.inputSizeHalf >> (uint2(_182) & uint2(31u))), uint2(1u)));
                                float2 _1015 = float2(0.5) / _1014;
                                float2 _1016 = float2(1.0) - _1015;
                                float _1025 = float(_182);
                                float4 _1027 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_989, _1015, _1016) * _1014) / float2(float(_1007.x), float(_1007.y))), level(_1025));
                                float _1028 = _1027.w;
                                float _1031 = abs(_1028);
                                float _1034 = fast::clamp(0.25 / (_1031 * _1031), 0.0, 1.0);
                                float4 _1047;
                                if (_183)
                                {
                                    _1047 = _987 + (((float4(_1027.xyz, 1.0) * _1034) * _982) * ((_1028 < _980) ? 1.0 : 0.00048828125));
                                }
                                else
                                {
                                    _1047 = _987;
                                }
                                float _1055 = _1005.x;
                                float _1057 = _1005.y;
                                float2 _1064 = float2((_956 * _1055) + (_964 * _1057), (_961 * _1055) + (_956 * _1057)) + _973;
                                uint2 _1066 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                float4 _1078 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1005, _1015, _1016) * _1014) / float2(float(_1066.x), float(_1066.y))), level(_1025));
                                float _1079 = _1078.w;
                                float _1082 = abs(_1079);
                                float _1085 = fast::clamp(0.25 / (_1082 * _1082), 0.0, 1.0);
                                float4 _1098;
                                if (_183)
                                {
                                    _1098 = _1047 + (((float4(_1078.xyz, 1.0) * _1085) * _982) * ((_1079 < _980) ? 1.0 : 0.00048828125));
                                }
                                else
                                {
                                    _1098 = _1047;
                                }
                                float _1106 = _1064.x;
                                float _1108 = _1064.y;
                                float2 _1115 = float2((_956 * _1106) + (_964 * _1108), (_961 * _1106) + (_956 * _1108)) + _973;
                                uint2 _1117 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                float4 _1129 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1064, _1015, _1016) * _1014) / float2(float(_1117.x), float(_1117.y))), level(_1025));
                                float _1130 = _1129.w;
                                float _1133 = abs(_1130);
                                float _1136 = fast::clamp(0.25 / (_1133 * _1133), 0.0, 1.0);
                                float4 _1149;
                                if (_183)
                                {
                                    _1149 = _1098 + (((float4(_1129.xyz, 1.0) * _1136) * _982) * ((_1130 < _980) ? 1.0 : 0.00048828125));
                                }
                                else
                                {
                                    _1149 = _1098;
                                }
                                float _1157 = _1115.x;
                                float _1159 = _1115.y;
                                _990 = float2((_956 * _1157) + (_964 * _1159), (_961 * _1157) + (_956 * _1159)) + _973;
                                uint2 _1167 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                float4 _1179 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1115, _1015, _1016) * _1014) / float2(float(_1167.x), float(_1167.y))), level(_1025));
                                float _1180 = _1179.w;
                                float _1183 = abs(_1180);
                                float _1186 = fast::clamp(0.25 / (_1183 * _1183), 0.0, 1.0);
                                if (_183)
                                {
                                    _988 = _1149 + (((float4(_1179.xyz, 1.0) * _1186) * _982) * ((_1180 < _980) ? 1.0 : 0.00048828125));
                                }
                                else
                                {
                                    _988 = _1149;
                                }
                                _985 = (((_984 + ((float4(_1027.xyz, 1.0) * _1034) * fast::clamp(_1028 - _979, 0.0, 1.0))) + ((float4(_1078.xyz, 1.0) * _1085) * fast::clamp(_1079 - _979, 0.0, 1.0))) + ((float4(_1129.xyz, 1.0) * _1136) * fast::clamp(_1130 - _979, 0.0, 1.0))) + ((float4(_1179.xyz, 1.0) * _1186) * fast::clamp(_1180 - _979, 0.0, 1.0));
                                _984 = _985;
                                _987 = _988;
                                _989 = _990;
                                _991 = _992;
                                continue;
                            }
                            else
                            {
                                break;
                            }
                        }
                        float2 _1209;
                        _935 = _984;
                        _937 = _987;
                        _1209 = _989;
                        float4 _1206;
                        float2 _1210;
                        float4 _1208;
                        for (uint _1211 = _991; _1211 < _946; _935 = _1206, _937 = _1208, _1209 = _1210, _1211++)
                        {
                            _1210 = float2((_956 * _1209.x) + (_964 * _1209.y), (_961 * _1209.x) + (_956 * _1209.y)) + _973;
                            uint2 _1226 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                            float2 _1233 = float2(max((cbDOF.inputSizeHalf >> (uint2(_182) & uint2(31u))), uint2(1u)));
                            float2 _1234 = float2(0.5) / _1233;
                            float4 _1246 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1209, _1234, float2(1.0) - _1234) * _1233) / float2(float(_1226.x), float(_1226.y))), level(float(_182)));
                            float _1247 = _1246.w;
                            float _1250 = abs(_1247);
                            float _1253 = fast::clamp(0.25 / (_1250 * _1250), 0.0, 1.0);
                            if (_183)
                            {
                                _1208 = _937 + (((float4(_1246.xyz, 1.0) * _1253) * _982) * ((_1247 < _980) ? 1.0 : 0.00048828125));
                            }
                            else
                            {
                                _1208 = _937;
                            }
                            _1206 = _935 + ((float4(_1246.xyz, 1.0) * _1253) * fast::clamp(_1247 - _979, 0.0, 1.0));
                        }
                    }
                    _1272 = _934;
                    _1273 = _936;
                }
                _2765 = _1272;
                _2766 = _1273;
                _2767 = float4(0.0);
                _2768 = 0.0;
                _2769 = 0u;
                _2770 = 0.0;
            }
            else
            {
                float4 _2745;
                float _2746;
                uint _2747;
                float _2748;
                if (_191)
                {
                    if (_189)
                    {
                        float4 _1801;
                        float _1802;
                        uint _1803;
                        if (0u < _185)
                        {
                            uint _1283 = min(1u, _185);
                            float _1284 = float(_1283);
                            float _1288 = float(_185);
                            float _1289 = _1288 - ((0.5 * _1284) - 0.5);
                            uint _1292 = (27u * uint(_1289)) >> 2u;
                            float _1295 = (_180 * (1.0 / _1288)) * _1289;
                            float _1301 = (6.283185482025146484375 / float(_1292)) * _1284;
                            float _1302 = sin(_1301);
                            float _1303 = cos(_1301);
                            float2 _1306 = float2(cbDOF.inputSizeHalf) * _100.yx;
                            float _1308 = _1302 * _1306.x;
                            float _1309 = -_1302;
                            float _1311 = _1309 * _1306.y;
                            float2 _1320 = _100 * ((_179 - (float2(_1303, _1302) * _179.x)) - (float2(_1309, _1303) * _179.y));
                            uint _1321 = _1292 / _1283;
                            uint _1324 = 2u * uint(log2(_1284));
                            float _1326 = precise::max(0.0, _1295 - _181);
                            float2 _1328;
                            float _1331;
                            float3 _1333;
                            uint _1335;
                            _1328 = _100 * (_179 + float2(_1295, 0.0));
                            _1331 = 0.0;
                            _1333 = float3(0.0);
                            _1335 = 0u;
                            uint _1336;
                            for (;;)
                            {
                                _1336 = _1335 + 8u;
                                if (_1336 <= _1321)
                                {
                                    float2 _1348 = float2((_1303 * _1328.x) + (_1311 * _1328.y), (_1308 * _1328.x) + (_1303 * _1328.y)) + _1320;
                                    uint _1349 = _182 + _1324;
                                    uint2 _1351 = uint2(r_internal_bilat_color.get_width(_1349), r_internal_bilat_color.get_height(_1349));
                                    float2 _1358 = float2(max((cbDOF.inputSizeHalf >> (uint2(_1349) & uint2(31u))), uint2(1u)));
                                    float2 _1359 = float2(0.5) / _1358;
                                    float2 _1360 = float2(1.0) - _1359;
                                    float _1369 = float(_1349);
                                    float4 _1371 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1328, _1359, _1360) * _1358) / float2(float(_1351.x), float(_1351.y))), level(_1369));
                                    float _1376 = fast::clamp((-_1371.w) - _1326, 0.0, 1.0);
                                    float _1380 = _1348.x;
                                    float _1382 = _1348.y;
                                    float2 _1389 = float2((_1303 * _1380) + (_1311 * _1382), (_1308 * _1380) + (_1303 * _1382)) + _1320;
                                    uint2 _1391 = uint2(r_internal_bilat_color.get_width(_1349), r_internal_bilat_color.get_height(_1349));
                                    float4 _1403 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1348, _1359, _1360) * _1358) / float2(float(_1391.x), float(_1391.y))), level(_1369));
                                    float _1408 = fast::clamp((-_1403.w) - _1326, 0.0, 1.0);
                                    float _1412 = _1389.x;
                                    float _1414 = _1389.y;
                                    float2 _1421 = float2((_1303 * _1412) + (_1311 * _1414), (_1308 * _1412) + (_1303 * _1414)) + _1320;
                                    uint2 _1423 = uint2(r_internal_bilat_color.get_width(_1349), r_internal_bilat_color.get_height(_1349));
                                    float4 _1435 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1389, _1359, _1360) * _1358) / float2(float(_1423.x), float(_1423.y))), level(_1369));
                                    float _1440 = fast::clamp((-_1435.w) - _1326, 0.0, 1.0);
                                    float _1444 = _1421.x;
                                    float _1446 = _1421.y;
                                    float2 _1453 = float2((_1303 * _1444) + (_1311 * _1446), (_1308 * _1444) + (_1303 * _1446)) + _1320;
                                    uint2 _1455 = uint2(r_internal_bilat_color.get_width(_1349), r_internal_bilat_color.get_height(_1349));
                                    float4 _1467 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1421, _1359, _1360) * _1358) / float2(float(_1455.x), float(_1455.y))), level(_1369));
                                    float _1472 = fast::clamp((-_1467.w) - _1326, 0.0, 1.0);
                                    float _1476 = _1453.x;
                                    float _1478 = _1453.y;
                                    float2 _1485 = float2((_1303 * _1476) + (_1311 * _1478), (_1308 * _1476) + (_1303 * _1478)) + _1320;
                                    uint2 _1487 = uint2(r_internal_bilat_color.get_width(_1349), r_internal_bilat_color.get_height(_1349));
                                    float4 _1499 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1453, _1359, _1360) * _1358) / float2(float(_1487.x), float(_1487.y))), level(_1369));
                                    float _1504 = fast::clamp((-_1499.w) - _1326, 0.0, 1.0);
                                    float _1508 = _1485.x;
                                    float _1510 = _1485.y;
                                    float2 _1517 = float2((_1303 * _1508) + (_1311 * _1510), (_1308 * _1508) + (_1303 * _1510)) + _1320;
                                    uint2 _1519 = uint2(r_internal_bilat_color.get_width(_1349), r_internal_bilat_color.get_height(_1349));
                                    float4 _1531 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1485, _1359, _1360) * _1358) / float2(float(_1519.x), float(_1519.y))), level(_1369));
                                    float _1536 = fast::clamp((-_1531.w) - _1326, 0.0, 1.0);
                                    float _1540 = _1517.x;
                                    float _1542 = _1517.y;
                                    float2 _1549 = float2((_1303 * _1540) + (_1311 * _1542), (_1308 * _1540) + (_1303 * _1542)) + _1320;
                                    uint2 _1551 = uint2(r_internal_bilat_color.get_width(_1349), r_internal_bilat_color.get_height(_1349));
                                    float4 _1563 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1517, _1359, _1360) * _1358) / float2(float(_1551.x), float(_1551.y))), level(_1369));
                                    float _1568 = fast::clamp((-_1563.w) - _1326, 0.0, 1.0);
                                    float _1572 = _1549.x;
                                    float _1574 = _1549.y;
                                    uint2 _1582 = uint2(r_internal_bilat_color.get_width(_1349), r_internal_bilat_color.get_height(_1349));
                                    float4 _1594 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1549, _1359, _1360) * _1358) / float2(float(_1582.x), float(_1582.y))), level(_1369));
                                    float _1599 = fast::clamp((-_1594.w) - _1326, 0.0, 1.0);
                                    _1328 = float2((_1303 * _1572) + (_1311 * _1574), (_1308 * _1572) + (_1303 * _1574)) + _1320;
                                    _1331 = (((((((_1331 + _1376) + _1408) + _1440) + _1472) + _1504) + _1536) + _1568) + _1599;
                                    _1333 = (((((((_1333 + (_1371.xyz * _1376)) + (_1403.xyz * _1408)) + (_1435.xyz * _1440)) + (_1467.xyz * _1472)) + (_1499.xyz * _1504)) + (_1531.xyz * _1536)) + (_1563.xyz * _1568)) + (_1594.xyz * _1599);
                                    _1335 = _1336;
                                    continue;
                                }
                                else
                                {
                                    break;
                                }
                            }
                            float2 _1602;
                            float _1605;
                            float3 _1607;
                            uint _1609;
                            _1602 = _1328;
                            _1605 = _1331;
                            _1607 = _1333;
                            _1609 = _1335;
                            uint _1610;
                            for (;;)
                            {
                                _1610 = _1609 + 4u;
                                if (_1610 <= _1321)
                                {
                                    float2 _1622 = float2((_1303 * _1602.x) + (_1311 * _1602.y), (_1308 * _1602.x) + (_1303 * _1602.y)) + _1320;
                                    uint _1623 = _182 + _1324;
                                    uint2 _1625 = uint2(r_internal_bilat_color.get_width(_1623), r_internal_bilat_color.get_height(_1623));
                                    float2 _1632 = float2(max((cbDOF.inputSizeHalf >> (uint2(_1623) & uint2(31u))), uint2(1u)));
                                    float2 _1633 = float2(0.5) / _1632;
                                    float2 _1634 = float2(1.0) - _1633;
                                    float2 _1635 = fast::clamp(_1602, _1633, _1634);
                                    float _1643 = float(_1623);
                                    float4 _1645 = r_internal_bilat_color.sample(PointSampler, ((_1635 * _1632) / float2(float(_1625.x), float(_1625.y))), level(_1643));
                                    float _1650 = fast::clamp((-_1645.w) - _1326, 0.0, 1.0);
                                    float _1654 = _1622.x;
                                    float _1656 = _1622.y;
                                    float2 _1663 = float2((_1303 * _1654) + (_1311 * _1656), (_1308 * _1654) + (_1303 * _1656)) + _1320;
                                    uint2 _1665 = uint2(r_internal_bilat_color.get_width(_1623), r_internal_bilat_color.get_height(_1623));
                                    float4 _1677 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1622, _1633, _1634) * _1632) / float2(float(_1665.x), float(_1665.y))), level(_1643));
                                    float _1682 = fast::clamp((-_1677.w) - _1326, 0.0, 1.0);
                                    float _1686 = _1663.x;
                                    float _1688 = _1663.y;
                                    float2 _1695 = float2((_1303 * _1686) + (_1311 * _1688), (_1308 * _1686) + (_1303 * _1688)) + _1320;
                                    uint2 _1697 = uint2(r_internal_bilat_color.get_width(_1623), r_internal_bilat_color.get_height(_1623));
                                    float4 _1709 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1663, _1633, _1634) * _1632) / float2(float(_1697.x), float(_1697.y))), level(_1643));
                                    float _1714 = fast::clamp((-_1709.w) - _1326, 0.0, 1.0);
                                    float _1718 = _1695.x;
                                    float _1720 = _1695.y;
                                    uint2 _1728 = uint2(r_internal_bilat_color.get_width(_1623), r_internal_bilat_color.get_height(_1623));
                                    float4 _1740 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1695, _1633, _1634) * _1632) / float2(float(_1728.x), float(_1728.y))), level(_1643));
                                    float _1745 = fast::clamp((-_1740.w) - _1326, 0.0, 1.0);
                                    _1602 = float2((_1303 * _1718) + (_1311 * _1720), (_1308 * _1718) + (_1303 * _1720)) + _1320;
                                    _1605 = (((_1605 + _1650) + _1682) + _1714) + _1745;
                                    _1607 = (((_1607 + (_1645.xyz * _1650)) + (_1677.xyz * _1682)) + (_1709.xyz * _1714)) + (_1740.xyz * _1745);
                                    _1609 = _1610;
                                    continue;
                                }
                                else
                                {
                                    break;
                                }
                            }
                            float2 _1748;
                            float _1751;
                            float3 _1753;
                            _1748 = _1602;
                            _1751 = _1605;
                            _1753 = _1607;
                            for (uint _1755 = _1609; _1755 < _1321; )
                            {
                                uint _1768 = _182 + _1324;
                                uint2 _1770 = uint2(r_internal_bilat_color.get_width(_1768), r_internal_bilat_color.get_height(_1768));
                                float2 _1777 = float2(max((cbDOF.inputSizeHalf >> (uint2(_1768) & uint2(31u))), uint2(1u)));
                                float2 _1778 = float2(0.5) / _1777;
                                float2 _1780 = fast::clamp(_1748, _1778, float2(1.0) - _1778);
                                float4 _1790 = r_internal_bilat_color.sample(PointSampler, ((_1780 * _1777) / float2(float(_1770.x), float(_1770.y))), level(float(_1768)));
                                float _1795 = fast::clamp((-_1790.w) - _1326, 0.0, 1.0);
                                _1748 = float2((_1303 * _1748.x) + (_1311 * _1748.y), (_1308 * _1748.x) + (_1303 * _1748.y)) + _1320;
                                _1751 += _1795;
                                _1753 += (_1790.xyz * _1795);
                                _1755++;
                                continue;
                            }
                            float _1797 = float(_1283 * _1283);
                            float3 _1798 = _1753 * _1797;
                            _1801 = float4(_1798.x, _1798.y, _1798.z, float4(0.0).w);
                            _1802 = _1751 * _1797;
                            _1803 = _1283;
                        }
                        else
                        {
                            _1801 = float4(0.0);
                            _1802 = 0.0;
                            _1803 = 0u;
                        }
                        float4 _1805;
                        float _1808;
                        _1805 = _1801;
                        _1808 = _1802;
                        float4 _1806;
                        float _1809;
                        uint _1811;
                        for (uint _1810 = _1803; _1810 < _185; _1805 = _1806, _1808 = _1809, _1810 = _1811)
                        {
                            uint _1819 = min(min((1u << (_1810 & 31u)), 1u), (_185 - _1810));
                            float _1821 = float(_1819);
                            uint _1825 = _1819 * _1819;
                            float _1826 = float(_185);
                            float _1827 = _1826 - ((float(_1810) + (0.5 * _1821)) - 0.5);
                            uint _1830 = (27u * uint(_1827)) >> 2u;
                            float _1839 = (6.283185482025146484375 / float(_1830)) * _1821;
                            float _1840 = sin(_1839);
                            float _1841 = cos(_1839);
                            float2 _1844 = float2(cbDOF.inputSizeHalf) * _100.yx;
                            float _1846 = _1840 * _1844.x;
                            float _1847 = -_1840;
                            float _1849 = _1847 * _1844.y;
                            float2 _1858 = _100 * ((_179 - (float2(_1841, _1840) * _179.x)) - (float2(_1847, _1841) * _179.y));
                            uint _1859 = _1830 / _1819;
                            uint _1862 = 2u * uint(log2(_1821));
                            float2 _1864;
                            float3 _1867;
                            uint _1869;
                            _1864 = _100 * (_179 + float2((_180 * (1.0 / _1826)) * _1827, 0.0));
                            _1867 = float3(0.0);
                            _1869 = 0u;
                            uint _1870;
                            for (;;)
                            {
                                _1870 = _1869 + 12u;
                                if (_1870 <= _1859)
                                {
                                    float2 _1882 = float2((_1841 * _1864.x) + (_1849 * _1864.y), (_1846 * _1864.x) + (_1841 * _1864.y)) + _1858;
                                    uint _1883 = _182 + _1862;
                                    uint2 _1885 = uint2(r_internal_bilat_color.get_width(_1883), r_internal_bilat_color.get_height(_1883));
                                    float2 _1892 = float2(max((cbDOF.inputSizeHalf >> (uint2(_1883) & uint2(31u))), uint2(1u)));
                                    float2 _1893 = float2(0.5) / _1892;
                                    float2 _1894 = float2(1.0) - _1893;
                                    float _1903 = float(_1883);
                                    float _1908 = _1882.x;
                                    float _1910 = _1882.y;
                                    float2 _1917 = float2((_1841 * _1908) + (_1849 * _1910), (_1846 * _1908) + (_1841 * _1910)) + _1858;
                                    uint2 _1919 = uint2(r_internal_bilat_color.get_width(_1883), r_internal_bilat_color.get_height(_1883));
                                    float _1934 = _1917.x;
                                    float _1936 = _1917.y;
                                    float2 _1943 = float2((_1841 * _1934) + (_1849 * _1936), (_1846 * _1934) + (_1841 * _1936)) + _1858;
                                    uint2 _1945 = uint2(r_internal_bilat_color.get_width(_1883), r_internal_bilat_color.get_height(_1883));
                                    float _1960 = _1943.x;
                                    float _1962 = _1943.y;
                                    float2 _1969 = float2((_1841 * _1960) + (_1849 * _1962), (_1846 * _1960) + (_1841 * _1962)) + _1858;
                                    uint2 _1971 = uint2(r_internal_bilat_color.get_width(_1883), r_internal_bilat_color.get_height(_1883));
                                    float _1986 = _1969.x;
                                    float _1988 = _1969.y;
                                    float2 _1995 = float2((_1841 * _1986) + (_1849 * _1988), (_1846 * _1986) + (_1841 * _1988)) + _1858;
                                    uint2 _1997 = uint2(r_internal_bilat_color.get_width(_1883), r_internal_bilat_color.get_height(_1883));
                                    float _2012 = _1995.x;
                                    float _2014 = _1995.y;
                                    float2 _2021 = float2((_1841 * _2012) + (_1849 * _2014), (_1846 * _2012) + (_1841 * _2014)) + _1858;
                                    uint2 _2023 = uint2(r_internal_bilat_color.get_width(_1883), r_internal_bilat_color.get_height(_1883));
                                    float3 _2037 = (((((_1867 + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1864, _1893, _1894) * _1892) / float2(float(_1885.x), float(_1885.y))), level(_1903)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1882, _1893, _1894) * _1892) / float2(float(_1919.x), float(_1919.y))), level(_1903)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1917, _1893, _1894) * _1892) / float2(float(_1945.x), float(_1945.y))), level(_1903)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1943, _1893, _1894) * _1892) / float2(float(_1971.x), float(_1971.y))), level(_1903)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1969, _1893, _1894) * _1892) / float2(float(_1997.x), float(_1997.y))), level(_1903)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_1995, _1893, _1894) * _1892) / float2(float(_2023.x), float(_2023.y))), level(_1903)).xyz;
                                    float _2038 = _2021.x;
                                    float _2040 = _2021.y;
                                    float2 _2047 = float2((_1841 * _2038) + (_1849 * _2040), (_1846 * _2038) + (_1841 * _2040)) + _1858;
                                    uint2 _2049 = uint2(r_internal_bilat_color.get_width(_1883), r_internal_bilat_color.get_height(_1883));
                                    float _2064 = _2047.x;
                                    float _2066 = _2047.y;
                                    float2 _2073 = float2((_1841 * _2064) + (_1849 * _2066), (_1846 * _2064) + (_1841 * _2066)) + _1858;
                                    uint2 _2075 = uint2(r_internal_bilat_color.get_width(_1883), r_internal_bilat_color.get_height(_1883));
                                    float _2090 = _2073.x;
                                    float _2092 = _2073.y;
                                    float2 _2099 = float2((_1841 * _2090) + (_1849 * _2092), (_1846 * _2090) + (_1841 * _2092)) + _1858;
                                    uint2 _2101 = uint2(r_internal_bilat_color.get_width(_1883), r_internal_bilat_color.get_height(_1883));
                                    float _2116 = _2099.x;
                                    float _2118 = _2099.y;
                                    float2 _2125 = float2((_1841 * _2116) + (_1849 * _2118), (_1846 * _2116) + (_1841 * _2118)) + _1858;
                                    uint2 _2127 = uint2(r_internal_bilat_color.get_width(_1883), r_internal_bilat_color.get_height(_1883));
                                    float _2142 = _2125.x;
                                    float _2144 = _2125.y;
                                    float2 _2151 = float2((_1841 * _2142) + (_1849 * _2144), (_1846 * _2142) + (_1841 * _2144)) + _1858;
                                    uint2 _2153 = uint2(r_internal_bilat_color.get_width(_1883), r_internal_bilat_color.get_height(_1883));
                                    float _2168 = _2151.x;
                                    float _2170 = _2151.y;
                                    uint2 _2178 = uint2(r_internal_bilat_color.get_width(_1883), r_internal_bilat_color.get_height(_1883));
                                    float3 _1868 = (((((_2037 + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2021, _1893, _1894) * _1892) / float2(float(_2049.x), float(_2049.y))), level(_1903)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2047, _1893, _1894) * _1892) / float2(float(_2075.x), float(_2075.y))), level(_1903)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2073, _1893, _1894) * _1892) / float2(float(_2101.x), float(_2101.y))), level(_1903)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2099, _1893, _1894) * _1892) / float2(float(_2127.x), float(_2127.y))), level(_1903)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2125, _1893, _1894) * _1892) / float2(float(_2153.x), float(_2153.y))), level(_1903)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2151, _1893, _1894) * _1892) / float2(float(_2178.x), float(_2178.y))), level(_1903)).xyz;
                                    _1864 = float2((_1841 * _2168) + (_1849 * _2170), (_1846 * _2168) + (_1841 * _2170)) + _1858;
                                    _1867 = _1868;
                                    _1869 = _1870;
                                    continue;
                                }
                                else
                                {
                                    break;
                                }
                            }
                            float2 _2193;
                            float3 _2196;
                            uint _2198;
                            _2193 = _1864;
                            _2196 = _1867;
                            _2198 = _1869;
                            uint _2199;
                            for (;;)
                            {
                                _2199 = _2198 + 4u;
                                if (_2199 <= _1859)
                                {
                                    float2 _2211 = float2((_1841 * _2193.x) + (_1849 * _2193.y), (_1846 * _2193.x) + (_1841 * _2193.y)) + _1858;
                                    uint _2212 = _182 + _1862;
                                    uint2 _2214 = uint2(r_internal_bilat_color.get_width(_2212), r_internal_bilat_color.get_height(_2212));
                                    float2 _2221 = float2(max((cbDOF.inputSizeHalf >> (uint2(_2212) & uint2(31u))), uint2(1u)));
                                    float2 _2222 = float2(0.5) / _2221;
                                    float2 _2223 = float2(1.0) - _2222;
                                    float2 _2224 = fast::clamp(_2193, _2222, _2223);
                                    float _2232 = float(_2212);
                                    float _2237 = _2211.x;
                                    float _2239 = _2211.y;
                                    float2 _2246 = float2((_1841 * _2237) + (_1849 * _2239), (_1846 * _2237) + (_1841 * _2239)) + _1858;
                                    uint2 _2248 = uint2(r_internal_bilat_color.get_width(_2212), r_internal_bilat_color.get_height(_2212));
                                    float _2263 = _2246.x;
                                    float _2265 = _2246.y;
                                    float2 _2272 = float2((_1841 * _2263) + (_1849 * _2265), (_1846 * _2263) + (_1841 * _2265)) + _1858;
                                    uint2 _2274 = uint2(r_internal_bilat_color.get_width(_2212), r_internal_bilat_color.get_height(_2212));
                                    float _2289 = _2272.x;
                                    float _2291 = _2272.y;
                                    uint2 _2299 = uint2(r_internal_bilat_color.get_width(_2212), r_internal_bilat_color.get_height(_2212));
                                    _2193 = float2((_1841 * _2289) + (_1849 * _2291), (_1846 * _2289) + (_1841 * _2291)) + _1858;
                                    _2196 = (((_2196 + r_internal_bilat_color.sample(PointSampler, ((_2224 * _2221) / float2(float(_2214.x), float(_2214.y))), level(_2232)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2211, _2222, _2223) * _2221) / float2(float(_2248.x), float(_2248.y))), level(_2232)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2246, _2222, _2223) * _2221) / float2(float(_2274.x), float(_2274.y))), level(_2232)).xyz) + r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2272, _2222, _2223) * _2221) / float2(float(_2299.x), float(_2299.y))), level(_2232)).xyz;
                                    _2198 = _2199;
                                    continue;
                                }
                                else
                                {
                                    break;
                                }
                            }
                            float2 _2314;
                            float3 _2317;
                            _2314 = _2193;
                            _2317 = _2196;
                            for (uint _2319 = _2198; _2319 < _1859; )
                            {
                                uint _2332 = _182 + _1862;
                                uint2 _2334 = uint2(r_internal_bilat_color.get_width(_2332), r_internal_bilat_color.get_height(_2332));
                                float2 _2341 = float2(max((cbDOF.inputSizeHalf >> (uint2(_2332) & uint2(31u))), uint2(1u)));
                                float2 _2342 = float2(0.5) / _2341;
                                float2 _2344 = fast::clamp(_2314, _2342, float2(1.0) - _2342);
                                _2314 = float2((_1841 * _2314.x) + (_1849 * _2314.y), (_1846 * _2314.x) + (_1841 * _2314.y)) + _1858;
                                _2317 += r_internal_bilat_color.sample(PointSampler, ((_2344 * _2341) / float2(float(_2334.x), float(_2334.y))), level(float(_2332))).xyz;
                                _2319++;
                                continue;
                            }
                            float3 _2359 = _1805.xyz + (_2317 * float(_1825));
                            _1806 = float4(_2359.x, _2359.y, _2359.z, _1805.w);
                            _1809 = _1808 + float(_1859 * _1825);
                            _1811 = _1810 + _1819;
                        }
                        float4 _2362 = _1805;
                        _2362.w = _1808;
                        _2745 = _2362;
                        _2746 = 0.0;
                        _2747 = uint(_1808);
                        _2748 = _1808;
                    }
                    else
                    {
                        float4 _2365;
                        float _2368;
                        uint _2370;
                        float _2372;
                        _2365 = float4(0.0);
                        _2368 = 0.0;
                        _2370 = 0u;
                        _2372 = 0.0;
                        float4 _2366;
                        float _2369;
                        uint _2371;
                        float _2373;
                        for (uint _2374 = 0u; _2374 < _185; _2365 = _2366, _2368 = _2369, _2370 = _2371, _2372 = _2373, _2374++)
                        {
                            float _2379 = float(_185);
                            float _2380 = 1.0 / _2379;
                            float _2382 = float(_185 - _2374);
                            float _2383 = _2380 * _2382;
                            float _2385 = _2379 - float(_2374);
                            uint _2388 = (27u * uint(_2385)) >> 2u;
                            float _2389 = _180 * _2380;
                            float _2394 = float(_2388);
                            float _2395 = 6.283185482025146484375 / _2394;
                            float _2396 = sin(_2395);
                            float _2397 = cos(_2395);
                            float2 _2400 = float2(cbDOF.inputSizeHalf) * _100.yx;
                            float _2402 = _2396 * _2400.x;
                            float _2403 = -_2396;
                            float _2405 = _2403 * _2400.y;
                            float2 _2414 = _100 * ((_179 - (float2(_2397, _2396) * _179.x)) - (float2(_2403, _2397) * _179.y));
                            float _2423 = ((float((_185 - 1u) - _2374) + 2.5) * _180) * (1.0 / (0.5 + _2379));
                            float _2425 = precise::max(0.0, (_2389 * _2382) - _181);
                            float2 _2427;
                            float4 _2430;
                            float4 _2432;
                            float _2434;
                            uint _2436;
                            float _2438;
                            uint _2440;
                            uint _2442;
                            _2427 = _100 * (_179 + float2(_2389 * _2385, 0.0));
                            _2430 = float4(0.0);
                            _2432 = _2365;
                            _2434 = 0.0;
                            _2436 = _2370;
                            _2438 = _2372;
                            _2440 = 0u;
                            _2442 = 0u;
                            float2 _2428;
                            float4 _2431;
                            float4 _2433;
                            float _2435;
                            uint _2437;
                            float _2439;
                            uint _2441;
                            uint _2443;
                            for (;;)
                            {
                                _2443 = _2442 + 3u;
                                if (_2443 <= _2388)
                                {
                                    float2 _2456 = float2((_2397 * _2427.x) + (_2405 * _2427.y), (_2402 * _2427.x) + (_2397 * _2427.y)) + _2414;
                                    uint2 _2458 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                    float2 _2465 = float2(max((cbDOF.inputSizeHalf >> (uint2(_182) & uint2(31u))), uint2(1u)));
                                    float2 _2466 = float2(0.5) / _2465;
                                    float2 _2467 = float2(1.0) - _2466;
                                    float _2476 = float(_182);
                                    float4 _2478 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2427, _2466, _2467) * _2465) / float2(float(_2458.x), float(_2458.y))), level(_2476));
                                    float _2479 = _2478.w;
                                    float _2480 = -_2479;
                                    float _2483 = abs(_2479);
                                    float _2486 = fast::clamp((_186 / _2483) + _187, 0.0, 1.0);
                                    float4 _2495 = (float4(_2478.xyz, 1.0) * fast::clamp(0.25 / (_2483 * _2483), 0.0, 1.0)) * fast::clamp(_2480 - _2425, 0.0, 1.0);
                                    uint _2506;
                                    float4 _2507;
                                    float _2508;
                                    uint _2509;
                                    float4 _2510;
                                    float _2511;
                                    if (_2480 >= _2423)
                                    {
                                        _2506 = _2436 + 1u;
                                        _2507 = _2432 + _2495;
                                        _2508 = _2438 + _2486;
                                        _2509 = _2440;
                                        _2510 = _2430;
                                        _2511 = _2434;
                                    }
                                    else
                                    {
                                        _2506 = _2436;
                                        _2507 = _2432;
                                        _2508 = _2438;
                                        _2509 = _2440 + 1u;
                                        _2510 = _2430 + _2495;
                                        _2511 = _2434 + _2486;
                                    }
                                    float _2512 = _2456.x;
                                    float _2514 = _2456.y;
                                    float2 _2521 = float2((_2397 * _2512) + (_2405 * _2514), (_2402 * _2512) + (_2397 * _2514)) + _2414;
                                    uint2 _2523 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                    float4 _2535 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2456, _2466, _2467) * _2465) / float2(float(_2523.x), float(_2523.y))), level(_2476));
                                    float _2536 = _2535.w;
                                    float _2537 = -_2536;
                                    float _2540 = abs(_2536);
                                    float _2543 = fast::clamp((_186 / _2540) + _187, 0.0, 1.0);
                                    float4 _2552 = (float4(_2535.xyz, 1.0) * fast::clamp(0.25 / (_2540 * _2540), 0.0, 1.0)) * fast::clamp(_2537 - _2425, 0.0, 1.0);
                                    uint _2563;
                                    float4 _2564;
                                    float _2565;
                                    uint _2566;
                                    float4 _2567;
                                    float _2568;
                                    if (_2537 >= _2423)
                                    {
                                        _2563 = _2506 + 1u;
                                        _2564 = _2507 + _2552;
                                        _2565 = _2508 + _2543;
                                        _2566 = _2509;
                                        _2567 = _2510;
                                        _2568 = _2511;
                                    }
                                    else
                                    {
                                        _2563 = _2506;
                                        _2564 = _2507;
                                        _2565 = _2508;
                                        _2566 = _2509 + 1u;
                                        _2567 = _2510 + _2552;
                                        _2568 = _2511 + _2543;
                                    }
                                    float _2569 = _2521.x;
                                    float _2571 = _2521.y;
                                    _2428 = float2((_2397 * _2569) + (_2405 * _2571), (_2402 * _2569) + (_2397 * _2571)) + _2414;
                                    uint2 _2579 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                    float4 _2591 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2521, _2466, _2467) * _2465) / float2(float(_2579.x), float(_2579.y))), level(_2476));
                                    float _2592 = _2591.w;
                                    float _2593 = -_2592;
                                    float _2596 = abs(_2592);
                                    float _2599 = fast::clamp((_186 / _2596) + _187, 0.0, 1.0);
                                    float4 _2608 = (float4(_2591.xyz, 1.0) * fast::clamp(0.25 / (_2596 * _2596), 0.0, 1.0)) * fast::clamp(_2593 - _2425, 0.0, 1.0);
                                    if (_2593 >= _2423)
                                    {
                                        _2437 = _2563 + 1u;
                                        _2433 = _2564 + _2608;
                                        _2439 = _2565 + _2599;
                                        _2441 = _2566;
                                        _2431 = _2567;
                                        _2435 = _2568;
                                    }
                                    else
                                    {
                                        _2437 = _2563;
                                        _2433 = _2564;
                                        _2439 = _2565;
                                        _2441 = _2566 + 1u;
                                        _2431 = _2567 + _2608;
                                        _2435 = _2568 + _2599;
                                    }
                                    _2427 = _2428;
                                    _2430 = _2431;
                                    _2432 = _2433;
                                    _2434 = _2435;
                                    _2436 = _2437;
                                    _2438 = _2439;
                                    _2440 = _2441;
                                    _2442 = _2443;
                                    continue;
                                }
                                else
                                {
                                    break;
                                }
                            }
                            float2 _2620;
                            float4 _2623;
                            float4 _2625;
                            float _2627;
                            uint _2629;
                            float _2631;
                            uint _2633;
                            _2620 = _2427;
                            _2623 = _2430;
                            _2625 = _2432;
                            _2627 = _2434;
                            _2629 = _2436;
                            _2631 = _2438;
                            _2633 = _2440;
                            float2 _2621;
                            float4 _2624;
                            float4 _2626;
                            float _2628;
                            uint _2630;
                            float _2632;
                            uint _2634;
                            for (uint _2635 = _2442; _2635 < _2388; _2620 = _2621, _2623 = _2624, _2625 = _2626, _2627 = _2628, _2629 = _2630, _2631 = _2632, _2633 = _2634, _2635++)
                            {
                                _2621 = float2((_2397 * _2620.x) + (_2405 * _2620.y), (_2402 * _2620.x) + (_2397 * _2620.y)) + _2414;
                                uint2 _2650 = uint2(r_internal_bilat_color.get_width(_182), r_internal_bilat_color.get_height(_182));
                                float2 _2657 = float2(max((cbDOF.inputSizeHalf >> (uint2(_182) & uint2(31u))), uint2(1u)));
                                float2 _2658 = float2(0.5) / _2657;
                                float4 _2670 = r_internal_bilat_color.sample(PointSampler, ((fast::clamp(_2620, _2658, float2(1.0) - _2658) * _2657) / float2(float(_2650.x), float(_2650.y))), level(float(_182)));
                                float _2671 = _2670.w;
                                float _2672 = -_2671;
                                float _2675 = abs(_2671);
                                float _2678 = fast::clamp((_186 / _2675) + _187, 0.0, 1.0);
                                float4 _2687 = (float4(_2670.xyz, 1.0) * fast::clamp(0.25 / (_2675 * _2675), 0.0, 1.0)) * fast::clamp(_2672 - _2425, 0.0, 1.0);
                                if (_2672 >= _2423)
                                {
                                    _2624 = _2623;
                                    _2626 = _2625 + _2687;
                                    _2628 = _2627;
                                    _2630 = _2629 + 1u;
                                    _2632 = _2631 + _2678;
                                    _2634 = _2633;
                                }
                                else
                                {
                                    _2624 = _2623 + _2687;
                                    _2626 = _2625;
                                    _2628 = _2627 + _2678;
                                    _2630 = _2629;
                                    _2632 = _2631;
                                    _2634 = _2633 + 1u;
                                }
                            }
                            float _2698 = float(_2633);
                            float _2700 = float(_2629);
                            float _2702 = fast::clamp(_2631 / _2700, 0.0, 1.0);
                            float _2704 = fast::clamp(_2627 / _2698, 0.0, 1.0);
                            float _2706 = fast::clamp(_2368 + _2702, 0.0, 1.0);
                            float _2707 = _2368 - _2702;
                            float _2709 = fast::clamp(_2383 + _2704, 0.0, 1.0);
                            float _2710 = _2383 - _2704;
                            float _2711 = precise::min(_2706, _2709);
                            float _2712 = precise::max(_2707, _2710);
                            float _2733;
                            if (_2711 < _2712)
                            {
                                _2733 = 0.0;
                            }
                            else
                            {
                                _2733 = fast::clamp(((_2711 * _2711) - ((float(int(sign(_2712))) * _2712) * _2712)) / ((_2706 * _2706) - ((float(int(sign(_2707))) * _2707) * _2707)), 0.0, 1.0);
                            }
                            float _2735 = 1.0 - ((_2698 / _2394) * _2733);
                            _2366 = (_2625 * _2735) + _2623;
                            float _2737 = precise::max(_2706, _2709);
                            float _2738 = precise::min(_2707, _2710);
                            _2369 = 0.5 * (_2737 + _2738);
                            _2371 = uint(_2700 * _2735) + _2633;
                            _2373 = float(_2371) * (0.5 * (_2737 - _2738));
                        }
                        _2745 = _2365;
                        _2746 = _2368;
                        _2747 = _2370;
                        _2748 = _2372;
                    }
                }
                else
                {
                    float4 _2754;
                    if (_199)
                    {
                        _2754 = r_internal_bilat_color.read(uint2(gl_GlobalInvocationID.xy), 0u);
                    }
                    else
                    {
                        _2754 = float4(0.0);
                    }
                    if (_199)
                    {
                        rw_internal_far.write(float4(_2754.xyz, 1.0), uint2(gl_GlobalInvocationID.xy));
                    }
                    if (_199)
                    {
                        rw_internal_near.write(float4(0.0), uint2(gl_GlobalInvocationID.xy));
                    }
                    break;
                }
                _2765 = _226;
                _2766 = _227;
                _2767 = _2745;
                _2768 = _2746;
                _2769 = _2747;
                _2770 = _2748;
            }
            _2771 = _2765;
            _2772 = _2766;
            _2773 = _2767;
            _2774 = _2768;
            _2775 = _2769;
            _2776 = _2770;
        }
        float4 _2782;
        if (_183)
        {
            _2782 = float4(0.0);
        }
        else
        {
            _2782 = _209 * _194;
        }
        float _2785 = fast::clamp(_2776 / float(_2775), 0.0, 1.0);
        float _2786 = fast::clamp(_183 ? 0.0 : fast::clamp((_186 / _188) + _187, 0.0, 1.0), 0.0, 1.0);
        float _2788 = fast::clamp(_2774 + _2785, 0.0, 1.0);
        float _2789 = _2774 - _2785;
        float _2792 = precise::min(_2788, fast::clamp(_2786, 0.0, 1.0));
        float _2793 = precise::max(_2789, -_2786);
        float _2814;
        if (_2792 < _2793)
        {
            _2814 = 0.0;
        }
        else
        {
            _2814 = fast::clamp(((_2792 * _2792) - ((float(int(sign(_2793))) * _2793) * _2793)) / ((_2788 * _2788) - ((float(int(sign(_2789))) * _2789) * _2789)), 0.0, 1.0);
        }
        float4 _2817 = (_2773 * (1.0 - _2814)) + _2782;
        float4 _2821;
        if (_183)
        {
            _2821 = _2817 + _2772;
        }
        else
        {
            _2821 = _2817;
        }
        float _2835;
        if ((!_191) ? _189 : false)
        {
            _2835 = 1.0;
        }
        else
        {
            _2835 = fast::clamp(_2771.w / (fast::clamp(0.25 / (_180 * _180), 0.0, 1.0) * float(_184)), 0.0, 1.0);
        }
        float4 _2838 = _2821 / float4(_2821.w);
        float3 _2847 = _2771.xyz / float3(_2771.w);
        if (_199)
        {
            rw_internal_far.write(select(float4(0.0), _2838, bool4(!any(isnan(_2838)))), uint2(gl_GlobalInvocationID.xy));
        }
        if (_199)
        {
            rw_internal_near.write(float4(select(float3(0.0), _2847, bool3(!any(isnan(_2847)))), _2835), uint2(gl_GlobalInvocationID.xy));
        }
        break;
    } while(false);
}

)DOF_GPU";
inline constexpr Binding bindings6[]={{"MacLauncherScene","buffer",0},{"mlValidity","buffer",1},{"mlRawDepth","texture",0},{"mlDepth","texture",1}};
inline constexpr const char*source6=R"DOF_GPU(#pragma clang diagnostic ignored "-Wunused-variable"

#include <metal_stdlib>
#include <simd/simd.h>
#include <metal_atomic>

using namespace metal;

struct type_MacLauncherScene
{
    float4 mlProjection[4];
    float4 mlInverse[4];
    float4 mlJitterSign;
    uint4 mlDepthROI;
    float4 mlClip;
};

struct type_RWStructuredBuffer_uint
{
    uint _m0[1];
};

kernel void CSDepth(constant type_MacLauncherScene& MacLauncherScene [[buffer(0)]], device type_RWStructuredBuffer_uint& mlValidity [[buffer(1)]], texture2d<float> mlRawDepth [[texture(0)]], texture2d<float, access::write> mlDepth [[texture(1)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    uint2 _61 = gl_GlobalInvocationID.xy;
    do
    {
        if (any(_61 >= MacLauncherScene.mlDepthROI.zw))
        {
            break;
        }
        uint _74 = uint(MacLauncherScene.mlJitterSign.w);
        uint2 _85;
        if ((_74 & 1u) != 0u)
        {
            uint2 _84 = _61;
            _84.y = (MacLauncherScene.mlDepthROI.w - 1u) - gl_GlobalInvocationID.y;
            _85 = _84;
        }
        else
        {
            _85 = _61;
        }
        uint2 _87 = _85 + MacLauncherScene.mlDepthROI.xy;
        float4 _95 = mlRawDepth.read(uint2(int3(int(_87.x), int(_87.y), 0).xy), 0);
        float _96 = _95.x;
        float2 _99 = float2(MacLauncherScene.mlDepthROI.zw);
        bool _102 = (_74 & 2u) != 0u;
        float2 _114 = ((((float2(_61) + float2(0.5)) / _99) - (MacLauncherScene.mlJitterSign.xy / _99)) * float2(2.0, float(_102 ? 2 : (-2)))) + float2(-1.0, float(_102 ? (-1) : 1));
        float4 _137 = (((MacLauncherScene.mlInverse[0] * _114.x) + (MacLauncherScene.mlInverse[1] * _114.y)) + (MacLauncherScene.mlInverse[2] * ((_96 * MacLauncherScene.mlClip.x) + MacLauncherScene.mlClip.y))) + (MacLauncherScene.mlInverse[3] * 1.0);
        bool _150;
        if (!(isnan(_96) || isinf(_96)))
        {
            bool4 _144 = isnan(_137);
            bool4 _145 = isinf(_137);
            _150 = !all(not(bool4(_144.x || _145.x, _144.y || _145.y, _144.z || _145.z, _144.w || _145.w)));
        }
        else
        {
            _150 = true;
        }
        if (_150)
        {
            uint _154 = atomic_exchange_explicit((device atomic_uint*)&mlValidity._m0[0u], 0u, memory_order_relaxed);
            mlDepth.write(float4(0.0), uint2(_61));
            break;
        }
        float _156 = _137.z;
        float _165;
        if (abs(_156) > 1.0000000031710768509710513471353e-30)
        {
            _165 = abs(_137.w / _156);
        }
        else
        {
            _165 = 1000000015047466219876688855040.0;
        }
        mlDepth.write(float4((isnan(_165) || isinf(_165)) ? 1000000015047466219876688855040.0 : _165), uint2(_61));
        break;
    } while(false);
}

)DOF_GPU";
inline constexpr Binding bindings7[]={{"MacLauncherScene","buffer",0},{"mlValidity","buffer",1},{"mlSource","texture",0},{"mlResult","texture",1},{"mlOutput","texture",2}};
inline constexpr const char*source7=R"DOF_GPU(#include <metal_stdlib>
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

struct type_RWStructuredBuffer_uint
{
    uint _m0[1];
};

kernel void CSOrient(constant type_MacLauncherScene& MacLauncherScene [[buffer(0)]], const device type_RWStructuredBuffer_uint& mlValidity [[buffer(1)]], texture2d<float> mlSource [[texture(0)]], texture2d<float> mlResult [[texture(1)]], texture2d<float, access::write> mlOutput [[texture(2)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    uint2 _44 = gl_GlobalInvocationID.xy;
    do
    {
        if (any(_44 >= MacLauncherScene.mlDepthROI.zw))
        {
            break;
        }
        uint2 _67;
        if ((uint(MacLauncherScene.mlJitterSign.w) & 1u) != 0u)
        {
            uint2 _66 = _44;
            _66.y = (MacLauncherScene.mlDepthROI.w - 1u) - gl_GlobalInvocationID.y;
            _67 = _66;
        }
        else
        {
            _67 = _44;
        }
        int2 _73 = int3(int(_67.x), int(_67.y), 0).xy;
        float4 _75 = mlSource.read(uint2(_73), 0);
        float4 _89;
        if (mlValidity._m0[0u] != 0u)
        {
            _89 = float4(mlResult.read(uint2(_73), 0).xyz, _75.w);
        }
        else
        {
            _89 = _75;
        }
        mlOutput.write(_89, uint2(_44));
        break;
    } while(false);
}

)DOF_GPU";
inline constexpr Shader shaders[]={{"downsample-depth","CS",source0,bindings0,sizeof(bindings0)/sizeof(Binding),8,8,1},{"downsample-color","CS",source1,bindings1,sizeof(bindings1)/sizeof(Binding),16,16,1},{"dilate","CS",source2,bindings2,sizeof(bindings2)/sizeof(Binding),8,8,1},{"blur","CS",source3,bindings3,sizeof(bindings3)/sizeof(Binding),8,8,1},{"composite","CS",source4,bindings4,sizeof(bindings4)/sizeof(Binding),8,8,1},{"blur-unmerged","CS",source5,bindings5,sizeof(bindings5)/sizeof(Binding),8,8,1},{"depth","CSDepth",source6,bindings6,sizeof(bindings6)/sizeof(Binding),8,8,1},{"orient","CSOrient",source7,bindings7,sizeof(bindings7)/sizeof(Binding),8,8,1}};
}
