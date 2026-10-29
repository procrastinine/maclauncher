// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see ffx-blur-MIT.txt.
// Generated original FidelityFX blur compute kernels.
#pragma once
#include <cstddef>
namespace macfx::ffx_blur_shaders {
struct Binding{const char*name;const char*kind;unsigned index;};
struct Shader{const char*name;const char*entry;const char*source;const Binding*bindings;size_t count;unsigned dimension,sigma,x,y,z;};
inline constexpr Binding bindings0[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source0=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 2> _58 = spvUnsafeArray<float, 2>({ 0.376577079296112060546875, 0.3117114603519439697265625 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 256> OutputCache;
    int2 _69 = int2(gl_LocalInvocationID.xy);
    int2 _71 = int2(gl_WorkGroupID.xy);
    int _76 = (cbBLUR._imageSize.y + 63) / 64;
    int _79 = _69.x;
    int _82 = _71.y;
    int _83 = _82 * _76;
    int2 _86 = int2((_71.x * 8) + _79, _69.y + (_83 * 8));
    for (int _88 = 0; _88 < 1; _88++)
    {
        int2 _96 = _86 + int2(0, 8 * _88);
        float3 _98;
        _98 = float3(0.0);
        for (int _101 = -1; _101 < 2; )
        {
            int2 _106 = _96 + int2(_101, 0);
            _106.x = clamp(_106.x, 0, cbBLUR._imageSize.x - 1);
            _98 += (r_input_src.read(uint2(uint2(clamp(_106, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _58[abs(_101)]);
            _101++;
            continue;
        }
        int2 _125 = _69 + int2(0, 8 * (_88 & 3));
        OutputCache[uint(_125.x + (_125.y * 8))] = _98;
    }
    if (_82 != 0)
    {
        for (int _136 = 1; _136 < 3; _136++)
        {
            int2 _144 = _86 - int2(0, 8 * _136);
            float3 _146;
            _146 = float3(0.0);
            for (int _149 = -1; _149 < 2; )
            {
                int2 _154 = _144 + int2(_149, 0);
                _154.x = clamp(_154.x, 0, cbBLUR._imageSize.x - 1);
                _146 += (r_input_src.read(uint2(uint2(clamp(_154, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _58[abs(_149)]);
                _149++;
                continue;
            }
            int2 _174 = _69 + int2(0, 8 * ((4 - _136) & 3));
            OutputCache[uint(_174.x + (_174.y * 8))] = _146;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _182;
    _182 = 0;
    int _183;
    int _185;
    for (;;)
    {
        _185 = _76 - 1;
        if (_182 < _185)
        {
            _183 = _182 + 1;
            int2 _191 = _86 + int2(0, 8 * _183);
            float3 _193;
            _193 = float3(0.0);
            for (int _196 = -1; _196 < 2; )
            {
                int2 _201 = _191 + int2(_196, 0);
                _201.x = clamp(_201.x, 0, cbBLUR._imageSize.x - 1);
                _193 += (r_input_src.read(uint2(uint2(clamp(_201, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _58[abs(_196)]);
                _196++;
                continue;
            }
            int2 _220 = _69 + int2(0, 8 * (_183 & 3));
            OutputCache[uint(_220.x + (_220.y * 8))] = _193;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _229 = _86 + int2(0, 8 * _182);
            float3 _231;
            _231 = float3(0.0);
            for (int _234 = -1; _234 < 2; )
            {
                int2 _241 = clamp(_229 + int2(0, _234), int2(0), cbBLUR._imageSize - int2(1));
                int _242 = _241.y;
                int2 _252 = int2(_79, _242 & 7) + int2(0, 8 * ((int(float(_242) * 0.125) - _83) & 3));
                _231 += (OutputCache[uint(_252.x + (_252.y * 8))] * _58[abs(_234)]);
                _234++;
                continue;
            }
            bool _270;
            if (all(_229 >= int2(0)))
            {
                _270 = all(_229 < cbBLUR._imageSize);
            }
            else
            {
                _270 = false;
            }
            if (_270)
            {
                rw_output.write(float4(_231, 1.0), uint2(uint2(_229)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _182 = _183;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _280 = _182; _280 < _76; _280++)
    {
        int _286 = 8 * _280;
        int2 _288 = _86 + int2(0, _286);
        if (_280 >= _185)
        {
            int _292 = _280 + 1;
            int2 _295 = _86 + int2(0, 8 * _292);
            float3 _297;
            _297 = float3(0.0);
            for (int _300 = -1; _300 < 2; )
            {
                int2 _305 = _295 + int2(_300, 0);
                _305.x = clamp(_305.x, 0, cbBLUR._imageSize.x - 1);
                _297 += (r_input_src.read(uint2(uint2(clamp(_305, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _58[abs(_300)]);
                _300++;
                continue;
            }
            int2 _324 = _69 + int2(0, 8 * (_292 & 3));
            OutputCache[uint(_324.x + (_324.y * 8))] = _297;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _332;
        _332 = float3(0.0);
        for (int _335 = -1; _335 < 2; )
        {
            int2 _342 = clamp(_288 + int2(0, _335), int2(0), cbBLUR._imageSize - int2(1));
            int _343 = _342.y;
            int2 _353 = int2(_79, _343 & 7) + int2(0, 8 * ((int(float(_343) * 0.125) - _83) & 3));
            _332 += (OutputCache[uint(_353.x + (_353.y * 8))] * _58[abs(_335)]);
            _335++;
            continue;
        }
        bool _371;
        if (all(_288 >= int2(0)))
        {
            _371 = all(_288 < cbBLUR._imageSize);
        }
        else
        {
            _371 = false;
        }
        if (_371)
        {
            rw_output.write(float4(_332, 1.0), uint2(uint2(_288)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings1[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source1=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 2> _58 = spvUnsafeArray<float, 2>({ 0.34749996662139892578125, 0.326250016689300537109375 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 256> OutputCache;
    int2 _69 = int2(gl_LocalInvocationID.xy);
    int2 _71 = int2(gl_WorkGroupID.xy);
    int _76 = (cbBLUR._imageSize.y + 63) / 64;
    int _79 = _69.x;
    int _82 = _71.y;
    int _83 = _82 * _76;
    int2 _86 = int2((_71.x * 8) + _79, _69.y + (_83 * 8));
    for (int _88 = 0; _88 < 1; _88++)
    {
        int2 _96 = _86 + int2(0, 8 * _88);
        float3 _98;
        _98 = float3(0.0);
        for (int _101 = -1; _101 < 2; )
        {
            int2 _106 = _96 + int2(_101, 0);
            _106.x = clamp(_106.x, 0, cbBLUR._imageSize.x - 1);
            _98 += (r_input_src.read(uint2(uint2(clamp(_106, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _58[abs(_101)]);
            _101++;
            continue;
        }
        int2 _125 = _69 + int2(0, 8 * (_88 & 3));
        OutputCache[uint(_125.x + (_125.y * 8))] = _98;
    }
    if (_82 != 0)
    {
        for (int _136 = 1; _136 < 3; _136++)
        {
            int2 _144 = _86 - int2(0, 8 * _136);
            float3 _146;
            _146 = float3(0.0);
            for (int _149 = -1; _149 < 2; )
            {
                int2 _154 = _144 + int2(_149, 0);
                _154.x = clamp(_154.x, 0, cbBLUR._imageSize.x - 1);
                _146 += (r_input_src.read(uint2(uint2(clamp(_154, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _58[abs(_149)]);
                _149++;
                continue;
            }
            int2 _174 = _69 + int2(0, 8 * ((4 - _136) & 3));
            OutputCache[uint(_174.x + (_174.y * 8))] = _146;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _182;
    _182 = 0;
    int _183;
    int _185;
    for (;;)
    {
        _185 = _76 - 1;
        if (_182 < _185)
        {
            _183 = _182 + 1;
            int2 _191 = _86 + int2(0, 8 * _183);
            float3 _193;
            _193 = float3(0.0);
            for (int _196 = -1; _196 < 2; )
            {
                int2 _201 = _191 + int2(_196, 0);
                _201.x = clamp(_201.x, 0, cbBLUR._imageSize.x - 1);
                _193 += (r_input_src.read(uint2(uint2(clamp(_201, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _58[abs(_196)]);
                _196++;
                continue;
            }
            int2 _220 = _69 + int2(0, 8 * (_183 & 3));
            OutputCache[uint(_220.x + (_220.y * 8))] = _193;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _229 = _86 + int2(0, 8 * _182);
            float3 _231;
            _231 = float3(0.0);
            for (int _234 = -1; _234 < 2; )
            {
                int2 _241 = clamp(_229 + int2(0, _234), int2(0), cbBLUR._imageSize - int2(1));
                int _242 = _241.y;
                int2 _252 = int2(_79, _242 & 7) + int2(0, 8 * ((int(float(_242) * 0.125) - _83) & 3));
                _231 += (OutputCache[uint(_252.x + (_252.y * 8))] * _58[abs(_234)]);
                _234++;
                continue;
            }
            bool _270;
            if (all(_229 >= int2(0)))
            {
                _270 = all(_229 < cbBLUR._imageSize);
            }
            else
            {
                _270 = false;
            }
            if (_270)
            {
                rw_output.write(float4(_231, 1.0), uint2(uint2(_229)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _182 = _183;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _280 = _182; _280 < _76; _280++)
    {
        int _286 = 8 * _280;
        int2 _288 = _86 + int2(0, _286);
        if (_280 >= _185)
        {
            int _292 = _280 + 1;
            int2 _295 = _86 + int2(0, 8 * _292);
            float3 _297;
            _297 = float3(0.0);
            for (int _300 = -1; _300 < 2; )
            {
                int2 _305 = _295 + int2(_300, 0);
                _305.x = clamp(_305.x, 0, cbBLUR._imageSize.x - 1);
                _297 += (r_input_src.read(uint2(uint2(clamp(_305, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _58[abs(_300)]);
                _300++;
                continue;
            }
            int2 _324 = _69 + int2(0, 8 * (_292 & 3));
            OutputCache[uint(_324.x + (_324.y * 8))] = _297;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _332;
        _332 = float3(0.0);
        for (int _335 = -1; _335 < 2; )
        {
            int2 _342 = clamp(_288 + int2(0, _335), int2(0), cbBLUR._imageSize - int2(1));
            int _343 = _342.y;
            int2 _353 = int2(_79, _343 & 7) + int2(0, 8 * ((int(float(_343) * 0.125) - _83) & 3));
            _332 += (OutputCache[uint(_353.x + (_353.y * 8))] * _58[abs(_335)]);
            _335++;
            continue;
        }
        bool _371;
        if (all(_288 >= int2(0)))
        {
            _371 = all(_288 < cbBLUR._imageSize);
        }
        else
        {
            _371 = false;
        }
        if (_371)
        {
            rw_output.write(float4(_332, 1.0), uint2(uint2(_288)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings2[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source2=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 2> _58 = spvUnsafeArray<float, 2>({ 0.3402771055698394775390625, 0.329861462116241455078125 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 256> OutputCache;
    int2 _69 = int2(gl_LocalInvocationID.xy);
    int2 _71 = int2(gl_WorkGroupID.xy);
    int _76 = (cbBLUR._imageSize.y + 63) / 64;
    int _79 = _69.x;
    int _82 = _71.y;
    int _83 = _82 * _76;
    int2 _86 = int2((_71.x * 8) + _79, _69.y + (_83 * 8));
    for (int _88 = 0; _88 < 1; _88++)
    {
        int2 _96 = _86 + int2(0, 8 * _88);
        float3 _98;
        _98 = float3(0.0);
        for (int _101 = -1; _101 < 2; )
        {
            int2 _106 = _96 + int2(_101, 0);
            _106.x = clamp(_106.x, 0, cbBLUR._imageSize.x - 1);
            _98 += (r_input_src.read(uint2(uint2(clamp(_106, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _58[abs(_101)]);
            _101++;
            continue;
        }
        int2 _125 = _69 + int2(0, 8 * (_88 & 3));
        OutputCache[uint(_125.x + (_125.y * 8))] = _98;
    }
    if (_82 != 0)
    {
        for (int _136 = 1; _136 < 3; _136++)
        {
            int2 _144 = _86 - int2(0, 8 * _136);
            float3 _146;
            _146 = float3(0.0);
            for (int _149 = -1; _149 < 2; )
            {
                int2 _154 = _144 + int2(_149, 0);
                _154.x = clamp(_154.x, 0, cbBLUR._imageSize.x - 1);
                _146 += (r_input_src.read(uint2(uint2(clamp(_154, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _58[abs(_149)]);
                _149++;
                continue;
            }
            int2 _174 = _69 + int2(0, 8 * ((4 - _136) & 3));
            OutputCache[uint(_174.x + (_174.y * 8))] = _146;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _182;
    _182 = 0;
    int _183;
    int _185;
    for (;;)
    {
        _185 = _76 - 1;
        if (_182 < _185)
        {
            _183 = _182 + 1;
            int2 _191 = _86 + int2(0, 8 * _183);
            float3 _193;
            _193 = float3(0.0);
            for (int _196 = -1; _196 < 2; )
            {
                int2 _201 = _191 + int2(_196, 0);
                _201.x = clamp(_201.x, 0, cbBLUR._imageSize.x - 1);
                _193 += (r_input_src.read(uint2(uint2(clamp(_201, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _58[abs(_196)]);
                _196++;
                continue;
            }
            int2 _220 = _69 + int2(0, 8 * (_183 & 3));
            OutputCache[uint(_220.x + (_220.y * 8))] = _193;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _229 = _86 + int2(0, 8 * _182);
            float3 _231;
            _231 = float3(0.0);
            for (int _234 = -1; _234 < 2; )
            {
                int2 _241 = clamp(_229 + int2(0, _234), int2(0), cbBLUR._imageSize - int2(1));
                int _242 = _241.y;
                int2 _252 = int2(_79, _242 & 7) + int2(0, 8 * ((int(float(_242) * 0.125) - _83) & 3));
                _231 += (OutputCache[uint(_252.x + (_252.y * 8))] * _58[abs(_234)]);
                _234++;
                continue;
            }
            bool _270;
            if (all(_229 >= int2(0)))
            {
                _270 = all(_229 < cbBLUR._imageSize);
            }
            else
            {
                _270 = false;
            }
            if (_270)
            {
                rw_output.write(float4(_231, 1.0), uint2(uint2(_229)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _182 = _183;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _280 = _182; _280 < _76; _280++)
    {
        int _286 = 8 * _280;
        int2 _288 = _86 + int2(0, _286);
        if (_280 >= _185)
        {
            int _292 = _280 + 1;
            int2 _295 = _86 + int2(0, 8 * _292);
            float3 _297;
            _297 = float3(0.0);
            for (int _300 = -1; _300 < 2; )
            {
                int2 _305 = _295 + int2(_300, 0);
                _305.x = clamp(_305.x, 0, cbBLUR._imageSize.x - 1);
                _297 += (r_input_src.read(uint2(uint2(clamp(_305, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _58[abs(_300)]);
                _300++;
                continue;
            }
            int2 _324 = _69 + int2(0, 8 * (_292 & 3));
            OutputCache[uint(_324.x + (_324.y * 8))] = _297;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _332;
        _332 = float3(0.0);
        for (int _335 = -1; _335 < 2; )
        {
            int2 _342 = clamp(_288 + int2(0, _335), int2(0), cbBLUR._imageSize - int2(1));
            int _343 = _342.y;
            int2 _353 = int2(_79, _343 & 7) + int2(0, 8 * ((int(float(_343) * 0.125) - _83) & 3));
            _332 += (OutputCache[uint(_353.x + (_353.y * 8))] * _58[abs(_335)]);
            _335++;
            continue;
        }
        bool _371;
        if (all(_288 >= int2(0)))
        {
            _371 = all(_288 < cbBLUR._imageSize);
        }
        else
        {
            _371 = false;
        }
        if (_371)
        {
            rw_output.write(float4(_332, 1.0), uint2(uint2(_288)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings3[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source3=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 3> _59 = spvUnsafeArray<float, 3>({ 0.2782163321971893310546875, 0.23029339313507080078125, 0.13059844076633453369140625 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 256> OutputCache;
    int2 _70 = int2(gl_LocalInvocationID.xy);
    int2 _72 = int2(gl_WorkGroupID.xy);
    int _77 = (cbBLUR._imageSize.y + 63) / 64;
    int _80 = _70.x;
    int _83 = _72.y;
    int _84 = _83 * _77;
    int2 _87 = int2((_72.x * 8) + _80, _70.y + (_84 * 8));
    for (int _89 = 0; _89 < 1; _89++)
    {
        int2 _97 = _87 + int2(0, 8 * _89);
        float3 _99;
        _99 = float3(0.0);
        for (int _102 = -2; _102 < 3; )
        {
            int2 _107 = _97 + int2(_102, 0);
            _107.x = clamp(_107.x, 0, cbBLUR._imageSize.x - 1);
            _99 += (r_input_src.read(uint2(uint2(clamp(_107, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _59[abs(_102)]);
            _102++;
            continue;
        }
        int2 _126 = _70 + int2(0, 8 * (_89 & 3));
        OutputCache[uint(_126.x + (_126.y * 8))] = _99;
    }
    if (_83 != 0)
    {
        for (int _137 = 1; _137 < 3; _137++)
        {
            int2 _145 = _87 - int2(0, 8 * _137);
            float3 _147;
            _147 = float3(0.0);
            for (int _150 = -2; _150 < 3; )
            {
                int2 _155 = _145 + int2(_150, 0);
                _155.x = clamp(_155.x, 0, cbBLUR._imageSize.x - 1);
                _147 += (r_input_src.read(uint2(uint2(clamp(_155, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _59[abs(_150)]);
                _150++;
                continue;
            }
            int2 _175 = _70 + int2(0, 8 * ((4 - _137) & 3));
            OutputCache[uint(_175.x + (_175.y * 8))] = _147;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _183;
    _183 = 0;
    int _184;
    int _186;
    for (;;)
    {
        _186 = _77 - 1;
        if (_183 < _186)
        {
            _184 = _183 + 1;
            int2 _192 = _87 + int2(0, 8 * _184);
            float3 _194;
            _194 = float3(0.0);
            for (int _197 = -2; _197 < 3; )
            {
                int2 _202 = _192 + int2(_197, 0);
                _202.x = clamp(_202.x, 0, cbBLUR._imageSize.x - 1);
                _194 += (r_input_src.read(uint2(uint2(clamp(_202, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _59[abs(_197)]);
                _197++;
                continue;
            }
            int2 _221 = _70 + int2(0, 8 * (_184 & 3));
            OutputCache[uint(_221.x + (_221.y * 8))] = _194;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _230 = _87 + int2(0, 8 * _183);
            float3 _232;
            _232 = float3(0.0);
            for (int _235 = -2; _235 < 3; )
            {
                int2 _242 = clamp(_230 + int2(0, _235), int2(0), cbBLUR._imageSize - int2(1));
                int _243 = _242.y;
                int2 _253 = int2(_80, _243 & 7) + int2(0, 8 * ((int(float(_243) * 0.125) - _84) & 3));
                _232 += (OutputCache[uint(_253.x + (_253.y * 8))] * _59[abs(_235)]);
                _235++;
                continue;
            }
            bool _271;
            if (all(_230 >= int2(0)))
            {
                _271 = all(_230 < cbBLUR._imageSize);
            }
            else
            {
                _271 = false;
            }
            if (_271)
            {
                rw_output.write(float4(_232, 1.0), uint2(uint2(_230)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _183 = _184;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _281 = _183; _281 < _77; _281++)
    {
        int _287 = 8 * _281;
        int2 _289 = _87 + int2(0, _287);
        if (_281 >= _186)
        {
            int _293 = _281 + 1;
            int2 _296 = _87 + int2(0, 8 * _293);
            float3 _298;
            _298 = float3(0.0);
            for (int _301 = -2; _301 < 3; )
            {
                int2 _306 = _296 + int2(_301, 0);
                _306.x = clamp(_306.x, 0, cbBLUR._imageSize.x - 1);
                _298 += (r_input_src.read(uint2(uint2(clamp(_306, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _59[abs(_301)]);
                _301++;
                continue;
            }
            int2 _325 = _70 + int2(0, 8 * (_293 & 3));
            OutputCache[uint(_325.x + (_325.y * 8))] = _298;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _333;
        _333 = float3(0.0);
        for (int _336 = -2; _336 < 3; )
        {
            int2 _343 = clamp(_289 + int2(0, _336), int2(0), cbBLUR._imageSize - int2(1));
            int _344 = _343.y;
            int2 _354 = int2(_80, _344 & 7) + int2(0, 8 * ((int(float(_344) * 0.125) - _84) & 3));
            _333 += (OutputCache[uint(_354.x + (_354.y * 8))] * _59[abs(_336)]);
            _336++;
            continue;
        }
        bool _372;
        if (all(_289 >= int2(0)))
        {
            _372 = all(_289 < cbBLUR._imageSize);
        }
        else
        {
            _372 = false;
        }
        if (_372)
        {
            rw_output.write(float4(_333, 1.0), uint2(uint2(_289)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings4[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source4=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 3> _59 = spvUnsafeArray<float, 3>({ 0.22565414011478424072265625, 0.2118551731109619140625, 0.17531774938106536865234375 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 256> OutputCache;
    int2 _70 = int2(gl_LocalInvocationID.xy);
    int2 _72 = int2(gl_WorkGroupID.xy);
    int _77 = (cbBLUR._imageSize.y + 63) / 64;
    int _80 = _70.x;
    int _83 = _72.y;
    int _84 = _83 * _77;
    int2 _87 = int2((_72.x * 8) + _80, _70.y + (_84 * 8));
    for (int _89 = 0; _89 < 1; _89++)
    {
        int2 _97 = _87 + int2(0, 8 * _89);
        float3 _99;
        _99 = float3(0.0);
        for (int _102 = -2; _102 < 3; )
        {
            int2 _107 = _97 + int2(_102, 0);
            _107.x = clamp(_107.x, 0, cbBLUR._imageSize.x - 1);
            _99 += (r_input_src.read(uint2(uint2(clamp(_107, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _59[abs(_102)]);
            _102++;
            continue;
        }
        int2 _126 = _70 + int2(0, 8 * (_89 & 3));
        OutputCache[uint(_126.x + (_126.y * 8))] = _99;
    }
    if (_83 != 0)
    {
        for (int _137 = 1; _137 < 3; _137++)
        {
            int2 _145 = _87 - int2(0, 8 * _137);
            float3 _147;
            _147 = float3(0.0);
            for (int _150 = -2; _150 < 3; )
            {
                int2 _155 = _145 + int2(_150, 0);
                _155.x = clamp(_155.x, 0, cbBLUR._imageSize.x - 1);
                _147 += (r_input_src.read(uint2(uint2(clamp(_155, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _59[abs(_150)]);
                _150++;
                continue;
            }
            int2 _175 = _70 + int2(0, 8 * ((4 - _137) & 3));
            OutputCache[uint(_175.x + (_175.y * 8))] = _147;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _183;
    _183 = 0;
    int _184;
    int _186;
    for (;;)
    {
        _186 = _77 - 1;
        if (_183 < _186)
        {
            _184 = _183 + 1;
            int2 _192 = _87 + int2(0, 8 * _184);
            float3 _194;
            _194 = float3(0.0);
            for (int _197 = -2; _197 < 3; )
            {
                int2 _202 = _192 + int2(_197, 0);
                _202.x = clamp(_202.x, 0, cbBLUR._imageSize.x - 1);
                _194 += (r_input_src.read(uint2(uint2(clamp(_202, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _59[abs(_197)]);
                _197++;
                continue;
            }
            int2 _221 = _70 + int2(0, 8 * (_184 & 3));
            OutputCache[uint(_221.x + (_221.y * 8))] = _194;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _230 = _87 + int2(0, 8 * _183);
            float3 _232;
            _232 = float3(0.0);
            for (int _235 = -2; _235 < 3; )
            {
                int2 _242 = clamp(_230 + int2(0, _235), int2(0), cbBLUR._imageSize - int2(1));
                int _243 = _242.y;
                int2 _253 = int2(_80, _243 & 7) + int2(0, 8 * ((int(float(_243) * 0.125) - _84) & 3));
                _232 += (OutputCache[uint(_253.x + (_253.y * 8))] * _59[abs(_235)]);
                _235++;
                continue;
            }
            bool _271;
            if (all(_230 >= int2(0)))
            {
                _271 = all(_230 < cbBLUR._imageSize);
            }
            else
            {
                _271 = false;
            }
            if (_271)
            {
                rw_output.write(float4(_232, 1.0), uint2(uint2(_230)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _183 = _184;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _281 = _183; _281 < _77; _281++)
    {
        int _287 = 8 * _281;
        int2 _289 = _87 + int2(0, _287);
        if (_281 >= _186)
        {
            int _293 = _281 + 1;
            int2 _296 = _87 + int2(0, 8 * _293);
            float3 _298;
            _298 = float3(0.0);
            for (int _301 = -2; _301 < 3; )
            {
                int2 _306 = _296 + int2(_301, 0);
                _306.x = clamp(_306.x, 0, cbBLUR._imageSize.x - 1);
                _298 += (r_input_src.read(uint2(uint2(clamp(_306, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _59[abs(_301)]);
                _301++;
                continue;
            }
            int2 _325 = _70 + int2(0, 8 * (_293 & 3));
            OutputCache[uint(_325.x + (_325.y * 8))] = _298;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _333;
        _333 = float3(0.0);
        for (int _336 = -2; _336 < 3; )
        {
            int2 _343 = clamp(_289 + int2(0, _336), int2(0), cbBLUR._imageSize - int2(1));
            int _344 = _343.y;
            int2 _354 = int2(_80, _344 & 7) + int2(0, 8 * ((int(float(_344) * 0.125) - _84) & 3));
            _333 += (OutputCache[uint(_354.x + (_354.y * 8))] * _59[abs(_336)]);
            _336++;
            continue;
        }
        bool _372;
        if (all(_289 >= int2(0)))
        {
            _372 = all(_289 < cbBLUR._imageSize);
        }
        else
        {
            _372 = false;
        }
        if (_372)
        {
            rw_output.write(float4(_333, 1.0), uint2(uint2(_289)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings5[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source5=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 3> _59 = spvUnsafeArray<float, 3>({ 0.21254336833953857421875, 0.20603756606578826904296875, 0.18769074976444244384765625 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 256> OutputCache;
    int2 _70 = int2(gl_LocalInvocationID.xy);
    int2 _72 = int2(gl_WorkGroupID.xy);
    int _77 = (cbBLUR._imageSize.y + 63) / 64;
    int _80 = _70.x;
    int _83 = _72.y;
    int _84 = _83 * _77;
    int2 _87 = int2((_72.x * 8) + _80, _70.y + (_84 * 8));
    for (int _89 = 0; _89 < 1; _89++)
    {
        int2 _97 = _87 + int2(0, 8 * _89);
        float3 _99;
        _99 = float3(0.0);
        for (int _102 = -2; _102 < 3; )
        {
            int2 _107 = _97 + int2(_102, 0);
            _107.x = clamp(_107.x, 0, cbBLUR._imageSize.x - 1);
            _99 += (r_input_src.read(uint2(uint2(clamp(_107, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _59[abs(_102)]);
            _102++;
            continue;
        }
        int2 _126 = _70 + int2(0, 8 * (_89 & 3));
        OutputCache[uint(_126.x + (_126.y * 8))] = _99;
    }
    if (_83 != 0)
    {
        for (int _137 = 1; _137 < 3; _137++)
        {
            int2 _145 = _87 - int2(0, 8 * _137);
            float3 _147;
            _147 = float3(0.0);
            for (int _150 = -2; _150 < 3; )
            {
                int2 _155 = _145 + int2(_150, 0);
                _155.x = clamp(_155.x, 0, cbBLUR._imageSize.x - 1);
                _147 += (r_input_src.read(uint2(uint2(clamp(_155, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _59[abs(_150)]);
                _150++;
                continue;
            }
            int2 _175 = _70 + int2(0, 8 * ((4 - _137) & 3));
            OutputCache[uint(_175.x + (_175.y * 8))] = _147;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _183;
    _183 = 0;
    int _184;
    int _186;
    for (;;)
    {
        _186 = _77 - 1;
        if (_183 < _186)
        {
            _184 = _183 + 1;
            int2 _192 = _87 + int2(0, 8 * _184);
            float3 _194;
            _194 = float3(0.0);
            for (int _197 = -2; _197 < 3; )
            {
                int2 _202 = _192 + int2(_197, 0);
                _202.x = clamp(_202.x, 0, cbBLUR._imageSize.x - 1);
                _194 += (r_input_src.read(uint2(uint2(clamp(_202, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _59[abs(_197)]);
                _197++;
                continue;
            }
            int2 _221 = _70 + int2(0, 8 * (_184 & 3));
            OutputCache[uint(_221.x + (_221.y * 8))] = _194;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _230 = _87 + int2(0, 8 * _183);
            float3 _232;
            _232 = float3(0.0);
            for (int _235 = -2; _235 < 3; )
            {
                int2 _242 = clamp(_230 + int2(0, _235), int2(0), cbBLUR._imageSize - int2(1));
                int _243 = _242.y;
                int2 _253 = int2(_80, _243 & 7) + int2(0, 8 * ((int(float(_243) * 0.125) - _84) & 3));
                _232 += (OutputCache[uint(_253.x + (_253.y * 8))] * _59[abs(_235)]);
                _235++;
                continue;
            }
            bool _271;
            if (all(_230 >= int2(0)))
            {
                _271 = all(_230 < cbBLUR._imageSize);
            }
            else
            {
                _271 = false;
            }
            if (_271)
            {
                rw_output.write(float4(_232, 1.0), uint2(uint2(_230)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _183 = _184;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _281 = _183; _281 < _77; _281++)
    {
        int _287 = 8 * _281;
        int2 _289 = _87 + int2(0, _287);
        if (_281 >= _186)
        {
            int _293 = _281 + 1;
            int2 _296 = _87 + int2(0, 8 * _293);
            float3 _298;
            _298 = float3(0.0);
            for (int _301 = -2; _301 < 3; )
            {
                int2 _306 = _296 + int2(_301, 0);
                _306.x = clamp(_306.x, 0, cbBLUR._imageSize.x - 1);
                _298 += (r_input_src.read(uint2(uint2(clamp(_306, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _59[abs(_301)]);
                _301++;
                continue;
            }
            int2 _325 = _70 + int2(0, 8 * (_293 & 3));
            OutputCache[uint(_325.x + (_325.y * 8))] = _298;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _333;
        _333 = float3(0.0);
        for (int _336 = -2; _336 < 3; )
        {
            int2 _343 = clamp(_289 + int2(0, _336), int2(0), cbBLUR._imageSize - int2(1));
            int _344 = _343.y;
            int2 _354 = int2(_80, _344 & 7) + int2(0, 8 * ((int(float(_344) * 0.125) - _84) & 3));
            _333 += (OutputCache[uint(_354.x + (_354.y * 8))] * _59[abs(_336)]);
            _336++;
            continue;
        }
        bool _372;
        if (all(_289 >= int2(0)))
        {
            _372 = all(_289 < cbBLUR._imageSize);
        }
        else
        {
            _372 = false;
        }
        if (_372)
        {
            rw_output.write(float4(_333, 1.0), uint2(uint2(_289)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings6[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source6=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 4> _60 = spvUnsafeArray<float, 4>({ 0.25259029865264892578125, 0.209081470966339111328125, 0.11856923997402191162109375, 0.046054132282733917236328125 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 256> OutputCache;
    int2 _71 = int2(gl_LocalInvocationID.xy);
    int2 _73 = int2(gl_WorkGroupID.xy);
    int _78 = (cbBLUR._imageSize.y + 63) / 64;
    int _81 = _71.x;
    int _84 = _73.y;
    int _85 = _84 * _78;
    int2 _88 = int2((_73.x * 8) + _81, _71.y + (_85 * 8));
    for (int _90 = 0; _90 < 1; _90++)
    {
        int2 _98 = _88 + int2(0, 8 * _90);
        float3 _100;
        _100 = float3(0.0);
        for (int _103 = -3; _103 < 4; )
        {
            int2 _108 = _98 + int2(_103, 0);
            _108.x = clamp(_108.x, 0, cbBLUR._imageSize.x - 1);
            _100 += (r_input_src.read(uint2(uint2(clamp(_108, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _60[abs(_103)]);
            _103++;
            continue;
        }
        int2 _127 = _71 + int2(0, 8 * (_90 & 3));
        OutputCache[uint(_127.x + (_127.y * 8))] = _100;
    }
    if (_84 != 0)
    {
        for (int _138 = 1; _138 < 3; _138++)
        {
            int2 _146 = _88 - int2(0, 8 * _138);
            float3 _148;
            _148 = float3(0.0);
            for (int _151 = -3; _151 < 4; )
            {
                int2 _156 = _146 + int2(_151, 0);
                _156.x = clamp(_156.x, 0, cbBLUR._imageSize.x - 1);
                _148 += (r_input_src.read(uint2(uint2(clamp(_156, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _60[abs(_151)]);
                _151++;
                continue;
            }
            int2 _176 = _71 + int2(0, 8 * ((4 - _138) & 3));
            OutputCache[uint(_176.x + (_176.y * 8))] = _148;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _184;
    _184 = 0;
    int _185;
    int _187;
    for (;;)
    {
        _187 = _78 - 1;
        if (_184 < _187)
        {
            _185 = _184 + 1;
            int2 _193 = _88 + int2(0, 8 * _185);
            float3 _195;
            _195 = float3(0.0);
            for (int _198 = -3; _198 < 4; )
            {
                int2 _203 = _193 + int2(_198, 0);
                _203.x = clamp(_203.x, 0, cbBLUR._imageSize.x - 1);
                _195 += (r_input_src.read(uint2(uint2(clamp(_203, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _60[abs(_198)]);
                _198++;
                continue;
            }
            int2 _222 = _71 + int2(0, 8 * (_185 & 3));
            OutputCache[uint(_222.x + (_222.y * 8))] = _195;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _231 = _88 + int2(0, 8 * _184);
            float3 _233;
            _233 = float3(0.0);
            for (int _236 = -3; _236 < 4; )
            {
                int2 _243 = clamp(_231 + int2(0, _236), int2(0), cbBLUR._imageSize - int2(1));
                int _244 = _243.y;
                int2 _254 = int2(_81, _244 & 7) + int2(0, 8 * ((int(float(_244) * 0.125) - _85) & 3));
                _233 += (OutputCache[uint(_254.x + (_254.y * 8))] * _60[abs(_236)]);
                _236++;
                continue;
            }
            bool _272;
            if (all(_231 >= int2(0)))
            {
                _272 = all(_231 < cbBLUR._imageSize);
            }
            else
            {
                _272 = false;
            }
            if (_272)
            {
                rw_output.write(float4(_233, 1.0), uint2(uint2(_231)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _184 = _185;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _282 = _184; _282 < _78; _282++)
    {
        int _288 = 8 * _282;
        int2 _290 = _88 + int2(0, _288);
        if (_282 >= _187)
        {
            int _294 = _282 + 1;
            int2 _297 = _88 + int2(0, 8 * _294);
            float3 _299;
            _299 = float3(0.0);
            for (int _302 = -3; _302 < 4; )
            {
                int2 _307 = _297 + int2(_302, 0);
                _307.x = clamp(_307.x, 0, cbBLUR._imageSize.x - 1);
                _299 += (r_input_src.read(uint2(uint2(clamp(_307, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _60[abs(_302)]);
                _302++;
                continue;
            }
            int2 _326 = _71 + int2(0, 8 * (_294 & 3));
            OutputCache[uint(_326.x + (_326.y * 8))] = _299;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _334;
        _334 = float3(0.0);
        for (int _337 = -3; _337 < 4; )
        {
            int2 _344 = clamp(_290 + int2(0, _337), int2(0), cbBLUR._imageSize - int2(1));
            int _345 = _344.y;
            int2 _355 = int2(_81, _345 & 7) + int2(0, 8 * ((int(float(_345) * 0.125) - _85) & 3));
            _334 += (OutputCache[uint(_355.x + (_355.y * 8))] * _60[abs(_337)]);
            _337++;
            continue;
        }
        bool _373;
        if (all(_290 >= int2(0)))
        {
            _373 = all(_290 < cbBLUR._imageSize);
        }
        else
        {
            _373 = false;
        }
        if (_373)
        {
            rw_output.write(float4(_334, 1.0), uint2(uint2(_290)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings7[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source7=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 4> _60 = spvUnsafeArray<float, 4>({ 0.179695308208465576171875, 0.16870675981044769287109375, 0.13961088657379150390625, 0.101834692060947418212890625 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 256> OutputCache;
    int2 _71 = int2(gl_LocalInvocationID.xy);
    int2 _73 = int2(gl_WorkGroupID.xy);
    int _78 = (cbBLUR._imageSize.y + 63) / 64;
    int _81 = _71.x;
    int _84 = _73.y;
    int _85 = _84 * _78;
    int2 _88 = int2((_73.x * 8) + _81, _71.y + (_85 * 8));
    for (int _90 = 0; _90 < 1; _90++)
    {
        int2 _98 = _88 + int2(0, 8 * _90);
        float3 _100;
        _100 = float3(0.0);
        for (int _103 = -3; _103 < 4; )
        {
            int2 _108 = _98 + int2(_103, 0);
            _108.x = clamp(_108.x, 0, cbBLUR._imageSize.x - 1);
            _100 += (r_input_src.read(uint2(uint2(clamp(_108, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _60[abs(_103)]);
            _103++;
            continue;
        }
        int2 _127 = _71 + int2(0, 8 * (_90 & 3));
        OutputCache[uint(_127.x + (_127.y * 8))] = _100;
    }
    if (_84 != 0)
    {
        for (int _138 = 1; _138 < 3; _138++)
        {
            int2 _146 = _88 - int2(0, 8 * _138);
            float3 _148;
            _148 = float3(0.0);
            for (int _151 = -3; _151 < 4; )
            {
                int2 _156 = _146 + int2(_151, 0);
                _156.x = clamp(_156.x, 0, cbBLUR._imageSize.x - 1);
                _148 += (r_input_src.read(uint2(uint2(clamp(_156, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _60[abs(_151)]);
                _151++;
                continue;
            }
            int2 _176 = _71 + int2(0, 8 * ((4 - _138) & 3));
            OutputCache[uint(_176.x + (_176.y * 8))] = _148;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _184;
    _184 = 0;
    int _185;
    int _187;
    for (;;)
    {
        _187 = _78 - 1;
        if (_184 < _187)
        {
            _185 = _184 + 1;
            int2 _193 = _88 + int2(0, 8 * _185);
            float3 _195;
            _195 = float3(0.0);
            for (int _198 = -3; _198 < 4; )
            {
                int2 _203 = _193 + int2(_198, 0);
                _203.x = clamp(_203.x, 0, cbBLUR._imageSize.x - 1);
                _195 += (r_input_src.read(uint2(uint2(clamp(_203, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _60[abs(_198)]);
                _198++;
                continue;
            }
            int2 _222 = _71 + int2(0, 8 * (_185 & 3));
            OutputCache[uint(_222.x + (_222.y * 8))] = _195;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _231 = _88 + int2(0, 8 * _184);
            float3 _233;
            _233 = float3(0.0);
            for (int _236 = -3; _236 < 4; )
            {
                int2 _243 = clamp(_231 + int2(0, _236), int2(0), cbBLUR._imageSize - int2(1));
                int _244 = _243.y;
                int2 _254 = int2(_81, _244 & 7) + int2(0, 8 * ((int(float(_244) * 0.125) - _85) & 3));
                _233 += (OutputCache[uint(_254.x + (_254.y * 8))] * _60[abs(_236)]);
                _236++;
                continue;
            }
            bool _272;
            if (all(_231 >= int2(0)))
            {
                _272 = all(_231 < cbBLUR._imageSize);
            }
            else
            {
                _272 = false;
            }
            if (_272)
            {
                rw_output.write(float4(_233, 1.0), uint2(uint2(_231)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _184 = _185;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _282 = _184; _282 < _78; _282++)
    {
        int _288 = 8 * _282;
        int2 _290 = _88 + int2(0, _288);
        if (_282 >= _187)
        {
            int _294 = _282 + 1;
            int2 _297 = _88 + int2(0, 8 * _294);
            float3 _299;
            _299 = float3(0.0);
            for (int _302 = -3; _302 < 4; )
            {
                int2 _307 = _297 + int2(_302, 0);
                _307.x = clamp(_307.x, 0, cbBLUR._imageSize.x - 1);
                _299 += (r_input_src.read(uint2(uint2(clamp(_307, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _60[abs(_302)]);
                _302++;
                continue;
            }
            int2 _326 = _71 + int2(0, 8 * (_294 & 3));
            OutputCache[uint(_326.x + (_326.y * 8))] = _299;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _334;
        _334 = float3(0.0);
        for (int _337 = -3; _337 < 4; )
        {
            int2 _344 = clamp(_290 + int2(0, _337), int2(0), cbBLUR._imageSize - int2(1));
            int _345 = _344.y;
            int2 _355 = int2(_81, _345 & 7) + int2(0, 8 * ((int(float(_345) * 0.125) - _85) & 3));
            _334 += (OutputCache[uint(_355.x + (_355.y * 8))] * _60[abs(_337)]);
            _337++;
            continue;
        }
        bool _373;
        if (all(_290 >= int2(0)))
        {
            _373 = all(_290 < cbBLUR._imageSize);
        }
        else
        {
            _373 = false;
        }
        if (_373)
        {
            rw_output.write(float4(_334, 1.0), uint2(uint2(_290)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings8[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source8=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 4> _60 = spvUnsafeArray<float, 4>({ 0.16085422039031982421875, 0.155930578708648681640625, 0.14204560220241546630859375, 0.12159670889377593994140625 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 256> OutputCache;
    int2 _71 = int2(gl_LocalInvocationID.xy);
    int2 _73 = int2(gl_WorkGroupID.xy);
    int _78 = (cbBLUR._imageSize.y + 63) / 64;
    int _81 = _71.x;
    int _84 = _73.y;
    int _85 = _84 * _78;
    int2 _88 = int2((_73.x * 8) + _81, _71.y + (_85 * 8));
    for (int _90 = 0; _90 < 1; _90++)
    {
        int2 _98 = _88 + int2(0, 8 * _90);
        float3 _100;
        _100 = float3(0.0);
        for (int _103 = -3; _103 < 4; )
        {
            int2 _108 = _98 + int2(_103, 0);
            _108.x = clamp(_108.x, 0, cbBLUR._imageSize.x - 1);
            _100 += (r_input_src.read(uint2(uint2(clamp(_108, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _60[abs(_103)]);
            _103++;
            continue;
        }
        int2 _127 = _71 + int2(0, 8 * (_90 & 3));
        OutputCache[uint(_127.x + (_127.y * 8))] = _100;
    }
    if (_84 != 0)
    {
        for (int _138 = 1; _138 < 3; _138++)
        {
            int2 _146 = _88 - int2(0, 8 * _138);
            float3 _148;
            _148 = float3(0.0);
            for (int _151 = -3; _151 < 4; )
            {
                int2 _156 = _146 + int2(_151, 0);
                _156.x = clamp(_156.x, 0, cbBLUR._imageSize.x - 1);
                _148 += (r_input_src.read(uint2(uint2(clamp(_156, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _60[abs(_151)]);
                _151++;
                continue;
            }
            int2 _176 = _71 + int2(0, 8 * ((4 - _138) & 3));
            OutputCache[uint(_176.x + (_176.y * 8))] = _148;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _184;
    _184 = 0;
    int _185;
    int _187;
    for (;;)
    {
        _187 = _78 - 1;
        if (_184 < _187)
        {
            _185 = _184 + 1;
            int2 _193 = _88 + int2(0, 8 * _185);
            float3 _195;
            _195 = float3(0.0);
            for (int _198 = -3; _198 < 4; )
            {
                int2 _203 = _193 + int2(_198, 0);
                _203.x = clamp(_203.x, 0, cbBLUR._imageSize.x - 1);
                _195 += (r_input_src.read(uint2(uint2(clamp(_203, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _60[abs(_198)]);
                _198++;
                continue;
            }
            int2 _222 = _71 + int2(0, 8 * (_185 & 3));
            OutputCache[uint(_222.x + (_222.y * 8))] = _195;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _231 = _88 + int2(0, 8 * _184);
            float3 _233;
            _233 = float3(0.0);
            for (int _236 = -3; _236 < 4; )
            {
                int2 _243 = clamp(_231 + int2(0, _236), int2(0), cbBLUR._imageSize - int2(1));
                int _244 = _243.y;
                int2 _254 = int2(_81, _244 & 7) + int2(0, 8 * ((int(float(_244) * 0.125) - _85) & 3));
                _233 += (OutputCache[uint(_254.x + (_254.y * 8))] * _60[abs(_236)]);
                _236++;
                continue;
            }
            bool _272;
            if (all(_231 >= int2(0)))
            {
                _272 = all(_231 < cbBLUR._imageSize);
            }
            else
            {
                _272 = false;
            }
            if (_272)
            {
                rw_output.write(float4(_233, 1.0), uint2(uint2(_231)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _184 = _185;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _282 = _184; _282 < _78; _282++)
    {
        int _288 = 8 * _282;
        int2 _290 = _88 + int2(0, _288);
        if (_282 >= _187)
        {
            int _294 = _282 + 1;
            int2 _297 = _88 + int2(0, 8 * _294);
            float3 _299;
            _299 = float3(0.0);
            for (int _302 = -3; _302 < 4; )
            {
                int2 _307 = _297 + int2(_302, 0);
                _307.x = clamp(_307.x, 0, cbBLUR._imageSize.x - 1);
                _299 += (r_input_src.read(uint2(uint2(clamp(_307, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _60[abs(_302)]);
                _302++;
                continue;
            }
            int2 _326 = _71 + int2(0, 8 * (_294 & 3));
            OutputCache[uint(_326.x + (_326.y * 8))] = _299;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _334;
        _334 = float3(0.0);
        for (int _337 = -3; _337 < 4; )
        {
            int2 _344 = clamp(_290 + int2(0, _337), int2(0), cbBLUR._imageSize - int2(1));
            int _345 = _344.y;
            int2 _355 = int2(_81, _345 & 7) + int2(0, 8 * ((int(float(_345) * 0.125) - _85) & 3));
            _334 += (OutputCache[uint(_355.x + (_355.y * 8))] * _60[abs(_337)]);
            _337++;
            continue;
        }
        bool _373;
        if (all(_290 >= int2(0)))
        {
            _373 = all(_290 < cbBLUR._imageSize);
        }
        else
        {
            _373 = false;
        }
        if (_373)
        {
            rw_output.write(float4(_334, 1.0), uint2(uint2(_290)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings9[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source9=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 5> _62 = spvUnsafeArray<float, 5>({ 0.24655143916606903076171875, 0.20408280193805694580078125, 0.115734517574310302734375, 0.0449530817568302154541015625, 0.011953883804380893707275390625 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _73 = int2(gl_LocalInvocationID.xy);
    int2 _75 = int2(gl_WorkGroupID.xy);
    int _80 = (cbBLUR._imageSize.y + 63) / 64;
    int _83 = _73.x;
    int _86 = _75.y;
    int _87 = _86 * _80;
    int2 _90 = int2((_75.x * 8) + _83, _73.y + (_87 * 8));
    for (int _92 = 0; _92 < 2; _92++)
    {
        int2 _100 = _90 + int2(0, 8 * _92);
        float3 _102;
        _102 = float3(0.0);
        for (int _105 = -4; _105 < 5; )
        {
            int2 _110 = _100 + int2(_105, 0);
            _110.x = clamp(_110.x, 0, cbBLUR._imageSize.x - 1);
            _102 += (r_input_src.read(uint2(uint2(clamp(_110, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _62[abs(_105)]);
            _105++;
            continue;
        }
        int2 _129 = _73 + int2(0, 8 * (_92 & 7));
        OutputCache[uint(_129.x + (_129.y * 8))] = _102;
    }
    if (_86 != 0)
    {
        for (int _140 = 1; _140 < 4; _140++)
        {
            int2 _148 = _90 - int2(0, 8 * _140);
            float3 _150;
            _150 = float3(0.0);
            for (int _153 = -4; _153 < 5; )
            {
                int2 _158 = _148 + int2(_153, 0);
                _158.x = clamp(_158.x, 0, cbBLUR._imageSize.x - 1);
                _150 += (r_input_src.read(uint2(uint2(clamp(_158, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _62[abs(_153)]);
                _153++;
                continue;
            }
            int2 _178 = _73 + int2(0, 8 * ((8 - _140) & 7));
            OutputCache[uint(_178.x + (_178.y * 8))] = _150;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _186;
    _186 = 0;
    int _189;
    for (;;)
    {
        _189 = _80 - 2;
        if (_186 < _189)
        {
            int _193 = _186 + 2;
            int2 _196 = _90 + int2(0, 8 * _193);
            float3 _198;
            _198 = float3(0.0);
            for (int _201 = -4; _201 < 5; )
            {
                int2 _206 = _196 + int2(_201, 0);
                _206.x = clamp(_206.x, 0, cbBLUR._imageSize.x - 1);
                _198 += (r_input_src.read(uint2(uint2(clamp(_206, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _62[abs(_201)]);
                _201++;
                continue;
            }
            int2 _225 = _73 + int2(0, 8 * (_193 & 7));
            OutputCache[uint(_225.x + (_225.y * 8))] = _198;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _234 = _90 + int2(0, 8 * _186);
            float3 _236;
            _236 = float3(0.0);
            for (int _239 = -4; _239 < 5; )
            {
                int2 _246 = clamp(_234 + int2(0, _239), int2(0), cbBLUR._imageSize - int2(1));
                int _247 = _246.y;
                int2 _257 = int2(_83, _247 & 7) + int2(0, 8 * ((int(float(_247) * 0.125) - _87) & 7));
                _236 += (OutputCache[uint(_257.x + (_257.y * 8))] * _62[abs(_239)]);
                _239++;
                continue;
            }
            bool _275;
            if (all(_234 >= int2(0)))
            {
                _275 = all(_234 < cbBLUR._imageSize);
            }
            else
            {
                _275 = false;
            }
            if (_275)
            {
                rw_output.write(float4(_236, 1.0), uint2(uint2(_234)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _186++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _285 = _186; _285 < _80; _285++)
    {
        int _291 = 8 * _285;
        int2 _293 = _90 + int2(0, _291);
        if (_285 >= _189)
        {
            int _297 = _285 + 2;
            int2 _300 = _90 + int2(0, 8 * _297);
            float3 _302;
            _302 = float3(0.0);
            for (int _305 = -4; _305 < 5; )
            {
                int2 _310 = _300 + int2(_305, 0);
                _310.x = clamp(_310.x, 0, cbBLUR._imageSize.x - 1);
                _302 += (r_input_src.read(uint2(uint2(clamp(_310, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _62[abs(_305)]);
                _305++;
                continue;
            }
            int2 _329 = _73 + int2(0, 8 * (_297 & 7));
            OutputCache[uint(_329.x + (_329.y * 8))] = _302;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _337;
        _337 = float3(0.0);
        for (int _340 = -4; _340 < 5; )
        {
            int2 _347 = clamp(_293 + int2(0, _340), int2(0), cbBLUR._imageSize - int2(1));
            int _348 = _347.y;
            int2 _358 = int2(_83, _348 & 7) + int2(0, 8 * ((int(float(_348) * 0.125) - _87) & 7));
            _337 += (OutputCache[uint(_358.x + (_358.y * 8))] * _62[abs(_340)]);
            _340++;
            continue;
        }
        bool _376;
        if (all(_293 >= int2(0)))
        {
            _376 = all(_293 < cbBLUR._imageSize);
        }
        else
        {
            _376 = false;
        }
        if (_376)
        {
            rw_output.write(float4(_337, 1.0), uint2(uint2(_293)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings10[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source10=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 5> _62 = spvUnsafeArray<float, 5>({ 0.15888948738574981689453125, 0.14917324483394622802734375, 0.12344621121883392333984375, 0.090043880045413970947265625, 0.0578919164836406707763671875 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _73 = int2(gl_LocalInvocationID.xy);
    int2 _75 = int2(gl_WorkGroupID.xy);
    int _80 = (cbBLUR._imageSize.y + 63) / 64;
    int _83 = _73.x;
    int _86 = _75.y;
    int _87 = _86 * _80;
    int2 _90 = int2((_75.x * 8) + _83, _73.y + (_87 * 8));
    for (int _92 = 0; _92 < 2; _92++)
    {
        int2 _100 = _90 + int2(0, 8 * _92);
        float3 _102;
        _102 = float3(0.0);
        for (int _105 = -4; _105 < 5; )
        {
            int2 _110 = _100 + int2(_105, 0);
            _110.x = clamp(_110.x, 0, cbBLUR._imageSize.x - 1);
            _102 += (r_input_src.read(uint2(uint2(clamp(_110, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _62[abs(_105)]);
            _105++;
            continue;
        }
        int2 _129 = _73 + int2(0, 8 * (_92 & 7));
        OutputCache[uint(_129.x + (_129.y * 8))] = _102;
    }
    if (_86 != 0)
    {
        for (int _140 = 1; _140 < 4; _140++)
        {
            int2 _148 = _90 - int2(0, 8 * _140);
            float3 _150;
            _150 = float3(0.0);
            for (int _153 = -4; _153 < 5; )
            {
                int2 _158 = _148 + int2(_153, 0);
                _158.x = clamp(_158.x, 0, cbBLUR._imageSize.x - 1);
                _150 += (r_input_src.read(uint2(uint2(clamp(_158, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _62[abs(_153)]);
                _153++;
                continue;
            }
            int2 _178 = _73 + int2(0, 8 * ((8 - _140) & 7));
            OutputCache[uint(_178.x + (_178.y * 8))] = _150;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _186;
    _186 = 0;
    int _189;
    for (;;)
    {
        _189 = _80 - 2;
        if (_186 < _189)
        {
            int _193 = _186 + 2;
            int2 _196 = _90 + int2(0, 8 * _193);
            float3 _198;
            _198 = float3(0.0);
            for (int _201 = -4; _201 < 5; )
            {
                int2 _206 = _196 + int2(_201, 0);
                _206.x = clamp(_206.x, 0, cbBLUR._imageSize.x - 1);
                _198 += (r_input_src.read(uint2(uint2(clamp(_206, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _62[abs(_201)]);
                _201++;
                continue;
            }
            int2 _225 = _73 + int2(0, 8 * (_193 & 7));
            OutputCache[uint(_225.x + (_225.y * 8))] = _198;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _234 = _90 + int2(0, 8 * _186);
            float3 _236;
            _236 = float3(0.0);
            for (int _239 = -4; _239 < 5; )
            {
                int2 _246 = clamp(_234 + int2(0, _239), int2(0), cbBLUR._imageSize - int2(1));
                int _247 = _246.y;
                int2 _257 = int2(_83, _247 & 7) + int2(0, 8 * ((int(float(_247) * 0.125) - _87) & 7));
                _236 += (OutputCache[uint(_257.x + (_257.y * 8))] * _62[abs(_239)]);
                _239++;
                continue;
            }
            bool _275;
            if (all(_234 >= int2(0)))
            {
                _275 = all(_234 < cbBLUR._imageSize);
            }
            else
            {
                _275 = false;
            }
            if (_275)
            {
                rw_output.write(float4(_236, 1.0), uint2(uint2(_234)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _186++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _285 = _186; _285 < _80; _285++)
    {
        int _291 = 8 * _285;
        int2 _293 = _90 + int2(0, _291);
        if (_285 >= _189)
        {
            int _297 = _285 + 2;
            int2 _300 = _90 + int2(0, 8 * _297);
            float3 _302;
            _302 = float3(0.0);
            for (int _305 = -4; _305 < 5; )
            {
                int2 _310 = _300 + int2(_305, 0);
                _310.x = clamp(_310.x, 0, cbBLUR._imageSize.x - 1);
                _302 += (r_input_src.read(uint2(uint2(clamp(_310, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _62[abs(_305)]);
                _305++;
                continue;
            }
            int2 _329 = _73 + int2(0, 8 * (_297 & 7));
            OutputCache[uint(_329.x + (_329.y * 8))] = _302;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _337;
        _337 = float3(0.0);
        for (int _340 = -4; _340 < 5; )
        {
            int2 _347 = clamp(_293 + int2(0, _340), int2(0), cbBLUR._imageSize - int2(1));
            int _348 = _347.y;
            int2 _358 = int2(_83, _348 & 7) + int2(0, 8 * ((int(float(_348) * 0.125) - _87) & 7));
            _337 += (OutputCache[uint(_358.x + (_358.y * 8))] * _62[abs(_340)]);
            _340++;
            continue;
        }
        bool _376;
        if (all(_293 >= int2(0)))
        {
            _376 = all(_293 < cbBLUR._imageSize);
        }
        else
        {
            _376 = false;
        }
        if (_376)
        {
            rw_output.write(float4(_337, 1.0), uint2(uint2(_293)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings11[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source11=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 5> _62 = spvUnsafeArray<float, 5>({ 0.13453471660614013671875, 0.13041670620441436767578125, 0.118803627789020538330078125, 0.10170064866542816162109375, 0.081811659038066864013671875 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _73 = int2(gl_LocalInvocationID.xy);
    int2 _75 = int2(gl_WorkGroupID.xy);
    int _80 = (cbBLUR._imageSize.y + 63) / 64;
    int _83 = _73.x;
    int _86 = _75.y;
    int _87 = _86 * _80;
    int2 _90 = int2((_75.x * 8) + _83, _73.y + (_87 * 8));
    for (int _92 = 0; _92 < 2; _92++)
    {
        int2 _100 = _90 + int2(0, 8 * _92);
        float3 _102;
        _102 = float3(0.0);
        for (int _105 = -4; _105 < 5; )
        {
            int2 _110 = _100 + int2(_105, 0);
            _110.x = clamp(_110.x, 0, cbBLUR._imageSize.x - 1);
            _102 += (r_input_src.read(uint2(uint2(clamp(_110, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _62[abs(_105)]);
            _105++;
            continue;
        }
        int2 _129 = _73 + int2(0, 8 * (_92 & 7));
        OutputCache[uint(_129.x + (_129.y * 8))] = _102;
    }
    if (_86 != 0)
    {
        for (int _140 = 1; _140 < 4; _140++)
        {
            int2 _148 = _90 - int2(0, 8 * _140);
            float3 _150;
            _150 = float3(0.0);
            for (int _153 = -4; _153 < 5; )
            {
                int2 _158 = _148 + int2(_153, 0);
                _158.x = clamp(_158.x, 0, cbBLUR._imageSize.x - 1);
                _150 += (r_input_src.read(uint2(uint2(clamp(_158, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _62[abs(_153)]);
                _153++;
                continue;
            }
            int2 _178 = _73 + int2(0, 8 * ((8 - _140) & 7));
            OutputCache[uint(_178.x + (_178.y * 8))] = _150;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _186;
    _186 = 0;
    int _189;
    for (;;)
    {
        _189 = _80 - 2;
        if (_186 < _189)
        {
            int _193 = _186 + 2;
            int2 _196 = _90 + int2(0, 8 * _193);
            float3 _198;
            _198 = float3(0.0);
            for (int _201 = -4; _201 < 5; )
            {
                int2 _206 = _196 + int2(_201, 0);
                _206.x = clamp(_206.x, 0, cbBLUR._imageSize.x - 1);
                _198 += (r_input_src.read(uint2(uint2(clamp(_206, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _62[abs(_201)]);
                _201++;
                continue;
            }
            int2 _225 = _73 + int2(0, 8 * (_193 & 7));
            OutputCache[uint(_225.x + (_225.y * 8))] = _198;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _234 = _90 + int2(0, 8 * _186);
            float3 _236;
            _236 = float3(0.0);
            for (int _239 = -4; _239 < 5; )
            {
                int2 _246 = clamp(_234 + int2(0, _239), int2(0), cbBLUR._imageSize - int2(1));
                int _247 = _246.y;
                int2 _257 = int2(_83, _247 & 7) + int2(0, 8 * ((int(float(_247) * 0.125) - _87) & 7));
                _236 += (OutputCache[uint(_257.x + (_257.y * 8))] * _62[abs(_239)]);
                _239++;
                continue;
            }
            bool _275;
            if (all(_234 >= int2(0)))
            {
                _275 = all(_234 < cbBLUR._imageSize);
            }
            else
            {
                _275 = false;
            }
            if (_275)
            {
                rw_output.write(float4(_236, 1.0), uint2(uint2(_234)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _186++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _285 = _186; _285 < _80; _285++)
    {
        int _291 = 8 * _285;
        int2 _293 = _90 + int2(0, _291);
        if (_285 >= _189)
        {
            int _297 = _285 + 2;
            int2 _300 = _90 + int2(0, 8 * _297);
            float3 _302;
            _302 = float3(0.0);
            for (int _305 = -4; _305 < 5; )
            {
                int2 _310 = _300 + int2(_305, 0);
                _310.x = clamp(_310.x, 0, cbBLUR._imageSize.x - 1);
                _302 += (r_input_src.read(uint2(uint2(clamp(_310, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _62[abs(_305)]);
                _305++;
                continue;
            }
            int2 _329 = _73 + int2(0, 8 * (_297 & 7));
            OutputCache[uint(_329.x + (_329.y * 8))] = _302;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _337;
        _337 = float3(0.0);
        for (int _340 = -4; _340 < 5; )
        {
            int2 _347 = clamp(_293 + int2(0, _340), int2(0), cbBLUR._imageSize - int2(1));
            int _348 = _347.y;
            int2 _358 = int2(_83, _348 & 7) + int2(0, 8 * ((int(float(_348) * 0.125) - _87) & 7));
            _337 += (OutputCache[uint(_358.x + (_358.y * 8))] * _62[abs(_340)]);
            _340++;
            continue;
        }
        bool _376;
        if (all(_293 >= int2(0)))
        {
            _376 = all(_293 < cbBLUR._imageSize);
        }
        else
        {
            _376 = false;
        }
        if (_376)
        {
            rw_output.write(float4(_337, 1.0), uint2(uint2(_293)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings12[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source12=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 6> _63 = spvUnsafeArray<float, 6>({ 0.24548356235027313232421875, 0.20319886505603790283203125, 0.115233242511749267578125, 0.044758379459381103515625, 0.011902107857167720794677734375, 0.00216561718843877315521240234375 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _74 = int2(gl_LocalInvocationID.xy);
    int2 _76 = int2(gl_WorkGroupID.xy);
    int _81 = (cbBLUR._imageSize.y + 63) / 64;
    int _84 = _74.x;
    int _87 = _76.y;
    int _88 = _87 * _81;
    int2 _91 = int2((_76.x * 8) + _84, _74.y + (_88 * 8));
    for (int _93 = 0; _93 < 2; _93++)
    {
        int2 _101 = _91 + int2(0, 8 * _93);
        float3 _103;
        _103 = float3(0.0);
        for (int _106 = -5; _106 < 6; )
        {
            int2 _111 = _101 + int2(_106, 0);
            _111.x = clamp(_111.x, 0, cbBLUR._imageSize.x - 1);
            _103 += (r_input_src.read(uint2(uint2(clamp(_111, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_106)]);
            _106++;
            continue;
        }
        int2 _130 = _74 + int2(0, 8 * (_93 & 7));
        OutputCache[uint(_130.x + (_130.y * 8))] = _103;
    }
    if (_87 != 0)
    {
        for (int _141 = 1; _141 < 4; _141++)
        {
            int2 _149 = _91 - int2(0, 8 * _141);
            float3 _151;
            _151 = float3(0.0);
            for (int _154 = -5; _154 < 6; )
            {
                int2 _159 = _149 + int2(_154, 0);
                _159.x = clamp(_159.x, 0, cbBLUR._imageSize.x - 1);
                _151 += (r_input_src.read(uint2(uint2(clamp(_159, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_154)]);
                _154++;
                continue;
            }
            int2 _179 = _74 + int2(0, 8 * ((8 - _141) & 7));
            OutputCache[uint(_179.x + (_179.y * 8))] = _151;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _187;
    _187 = 0;
    int _190;
    for (;;)
    {
        _190 = _81 - 2;
        if (_187 < _190)
        {
            int _194 = _187 + 2;
            int2 _197 = _91 + int2(0, 8 * _194);
            float3 _199;
            _199 = float3(0.0);
            for (int _202 = -5; _202 < 6; )
            {
                int2 _207 = _197 + int2(_202, 0);
                _207.x = clamp(_207.x, 0, cbBLUR._imageSize.x - 1);
                _199 += (r_input_src.read(uint2(uint2(clamp(_207, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_202)]);
                _202++;
                continue;
            }
            int2 _226 = _74 + int2(0, 8 * (_194 & 7));
            OutputCache[uint(_226.x + (_226.y * 8))] = _199;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _235 = _91 + int2(0, 8 * _187);
            float3 _237;
            _237 = float3(0.0);
            for (int _240 = -5; _240 < 6; )
            {
                int2 _247 = clamp(_235 + int2(0, _240), int2(0), cbBLUR._imageSize - int2(1));
                int _248 = _247.y;
                int2 _258 = int2(_84, _248 & 7) + int2(0, 8 * ((int(float(_248) * 0.125) - _88) & 7));
                _237 += (OutputCache[uint(_258.x + (_258.y * 8))] * _63[abs(_240)]);
                _240++;
                continue;
            }
            bool _276;
            if (all(_235 >= int2(0)))
            {
                _276 = all(_235 < cbBLUR._imageSize);
            }
            else
            {
                _276 = false;
            }
            if (_276)
            {
                rw_output.write(float4(_237, 1.0), uint2(uint2(_235)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _187++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _286 = _187; _286 < _81; _286++)
    {
        int _292 = 8 * _286;
        int2 _294 = _91 + int2(0, _292);
        if (_286 >= _190)
        {
            int _298 = _286 + 2;
            int2 _301 = _91 + int2(0, 8 * _298);
            float3 _303;
            _303 = float3(0.0);
            for (int _306 = -5; _306 < 6; )
            {
                int2 _311 = _301 + int2(_306, 0);
                _311.x = clamp(_311.x, 0, cbBLUR._imageSize.x - 1);
                _303 += (r_input_src.read(uint2(uint2(clamp(_311, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_306)]);
                _306++;
                continue;
            }
            int2 _330 = _74 + int2(0, 8 * (_298 & 7));
            OutputCache[uint(_330.x + (_330.y * 8))] = _303;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _338;
        _338 = float3(0.0);
        for (int _341 = -5; _341 < 6; )
        {
            int2 _348 = clamp(_294 + int2(0, _341), int2(0), cbBLUR._imageSize - int2(1));
            int _349 = _348.y;
            int2 _359 = int2(_84, _349 & 7) + int2(0, 8 * ((int(float(_349) * 0.125) - _88) & 7));
            _338 += (OutputCache[uint(_359.x + (_359.y * 8))] * _63[abs(_341)]);
            _341++;
            continue;
        }
        bool _377;
        if (all(_294 >= int2(0)))
        {
            _377 = all(_294 < cbBLUR._imageSize);
        }
        else
        {
            _377 = false;
        }
        if (_377)
        {
            rw_output.write(float4(_338, 1.0), uint2(uint2(_294)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings13[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source13=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 6> _63 = spvUnsafeArray<float, 6>({ 0.14910607039928436279296875, 0.13998807966709136962890625, 0.11584515869617462158203125, 0.084499537944793701171875, 0.05432729423046112060546875, 0.0307868905365467071533203125 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _74 = int2(gl_LocalInvocationID.xy);
    int2 _76 = int2(gl_WorkGroupID.xy);
    int _81 = (cbBLUR._imageSize.y + 63) / 64;
    int _84 = _74.x;
    int _87 = _76.y;
    int _88 = _87 * _81;
    int2 _91 = int2((_76.x * 8) + _84, _74.y + (_88 * 8));
    for (int _93 = 0; _93 < 2; _93++)
    {
        int2 _101 = _91 + int2(0, 8 * _93);
        float3 _103;
        _103 = float3(0.0);
        for (int _106 = -5; _106 < 6; )
        {
            int2 _111 = _101 + int2(_106, 0);
            _111.x = clamp(_111.x, 0, cbBLUR._imageSize.x - 1);
            _103 += (r_input_src.read(uint2(uint2(clamp(_111, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_106)]);
            _106++;
            continue;
        }
        int2 _130 = _74 + int2(0, 8 * (_93 & 7));
        OutputCache[uint(_130.x + (_130.y * 8))] = _103;
    }
    if (_87 != 0)
    {
        for (int _141 = 1; _141 < 4; _141++)
        {
            int2 _149 = _91 - int2(0, 8 * _141);
            float3 _151;
            _151 = float3(0.0);
            for (int _154 = -5; _154 < 6; )
            {
                int2 _159 = _149 + int2(_154, 0);
                _159.x = clamp(_159.x, 0, cbBLUR._imageSize.x - 1);
                _151 += (r_input_src.read(uint2(uint2(clamp(_159, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_154)]);
                _154++;
                continue;
            }
            int2 _179 = _74 + int2(0, 8 * ((8 - _141) & 7));
            OutputCache[uint(_179.x + (_179.y * 8))] = _151;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _187;
    _187 = 0;
    int _190;
    for (;;)
    {
        _190 = _81 - 2;
        if (_187 < _190)
        {
            int _194 = _187 + 2;
            int2 _197 = _91 + int2(0, 8 * _194);
            float3 _199;
            _199 = float3(0.0);
            for (int _202 = -5; _202 < 6; )
            {
                int2 _207 = _197 + int2(_202, 0);
                _207.x = clamp(_207.x, 0, cbBLUR._imageSize.x - 1);
                _199 += (r_input_src.read(uint2(uint2(clamp(_207, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_202)]);
                _202++;
                continue;
            }
            int2 _226 = _74 + int2(0, 8 * (_194 & 7));
            OutputCache[uint(_226.x + (_226.y * 8))] = _199;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _235 = _91 + int2(0, 8 * _187);
            float3 _237;
            _237 = float3(0.0);
            for (int _240 = -5; _240 < 6; )
            {
                int2 _247 = clamp(_235 + int2(0, _240), int2(0), cbBLUR._imageSize - int2(1));
                int _248 = _247.y;
                int2 _258 = int2(_84, _248 & 7) + int2(0, 8 * ((int(float(_248) * 0.125) - _88) & 7));
                _237 += (OutputCache[uint(_258.x + (_258.y * 8))] * _63[abs(_240)]);
                _240++;
                continue;
            }
            bool _276;
            if (all(_235 >= int2(0)))
            {
                _276 = all(_235 < cbBLUR._imageSize);
            }
            else
            {
                _276 = false;
            }
            if (_276)
            {
                rw_output.write(float4(_237, 1.0), uint2(uint2(_235)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _187++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _286 = _187; _286 < _81; _286++)
    {
        int _292 = 8 * _286;
        int2 _294 = _91 + int2(0, _292);
        if (_286 >= _190)
        {
            int _298 = _286 + 2;
            int2 _301 = _91 + int2(0, 8 * _298);
            float3 _303;
            _303 = float3(0.0);
            for (int _306 = -5; _306 < 6; )
            {
                int2 _311 = _301 + int2(_306, 0);
                _311.x = clamp(_311.x, 0, cbBLUR._imageSize.x - 1);
                _303 += (r_input_src.read(uint2(uint2(clamp(_311, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_306)]);
                _306++;
                continue;
            }
            int2 _330 = _74 + int2(0, 8 * (_298 & 7));
            OutputCache[uint(_330.x + (_330.y * 8))] = _303;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _338;
        _338 = float3(0.0);
        for (int _341 = -5; _341 < 6; )
        {
            int2 _348 = clamp(_294 + int2(0, _341), int2(0), cbBLUR._imageSize - int2(1));
            int _349 = _348.y;
            int2 _359 = int2(_84, _349 & 7) + int2(0, 8 * ((int(float(_349) * 0.125) - _88) & 7));
            _338 += (OutputCache[uint(_359.x + (_359.y * 8))] * _63[abs(_341)]);
            _341++;
            continue;
        }
        bool _377;
        if (all(_294 >= int2(0)))
        {
            _377 = all(_294 < cbBLUR._imageSize);
        }
        else
        {
            _377 = false;
        }
        if (_377)
        {
            rw_output.write(float4(_338, 1.0), uint2(uint2(_294)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings14[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source14=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 6> _63 = spvUnsafeArray<float, 6>({ 0.1197258532047271728515625, 0.116061128675937652587890625, 0.105726353824138641357421875, 0.0905059874057769775390625, 0.072806261479854583740234375, 0.0550373382866382598876953125 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _74 = int2(gl_LocalInvocationID.xy);
    int2 _76 = int2(gl_WorkGroupID.xy);
    int _81 = (cbBLUR._imageSize.y + 63) / 64;
    int _84 = _74.x;
    int _87 = _76.y;
    int _88 = _87 * _81;
    int2 _91 = int2((_76.x * 8) + _84, _74.y + (_88 * 8));
    for (int _93 = 0; _93 < 2; _93++)
    {
        int2 _101 = _91 + int2(0, 8 * _93);
        float3 _103;
        _103 = float3(0.0);
        for (int _106 = -5; _106 < 6; )
        {
            int2 _111 = _101 + int2(_106, 0);
            _111.x = clamp(_111.x, 0, cbBLUR._imageSize.x - 1);
            _103 += (r_input_src.read(uint2(uint2(clamp(_111, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_106)]);
            _106++;
            continue;
        }
        int2 _130 = _74 + int2(0, 8 * (_93 & 7));
        OutputCache[uint(_130.x + (_130.y * 8))] = _103;
    }
    if (_87 != 0)
    {
        for (int _141 = 1; _141 < 4; _141++)
        {
            int2 _149 = _91 - int2(0, 8 * _141);
            float3 _151;
            _151 = float3(0.0);
            for (int _154 = -5; _154 < 6; )
            {
                int2 _159 = _149 + int2(_154, 0);
                _159.x = clamp(_159.x, 0, cbBLUR._imageSize.x - 1);
                _151 += (r_input_src.read(uint2(uint2(clamp(_159, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_154)]);
                _154++;
                continue;
            }
            int2 _179 = _74 + int2(0, 8 * ((8 - _141) & 7));
            OutputCache[uint(_179.x + (_179.y * 8))] = _151;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _187;
    _187 = 0;
    int _190;
    for (;;)
    {
        _190 = _81 - 2;
        if (_187 < _190)
        {
            int _194 = _187 + 2;
            int2 _197 = _91 + int2(0, 8 * _194);
            float3 _199;
            _199 = float3(0.0);
            for (int _202 = -5; _202 < 6; )
            {
                int2 _207 = _197 + int2(_202, 0);
                _207.x = clamp(_207.x, 0, cbBLUR._imageSize.x - 1);
                _199 += (r_input_src.read(uint2(uint2(clamp(_207, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_202)]);
                _202++;
                continue;
            }
            int2 _226 = _74 + int2(0, 8 * (_194 & 7));
            OutputCache[uint(_226.x + (_226.y * 8))] = _199;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _235 = _91 + int2(0, 8 * _187);
            float3 _237;
            _237 = float3(0.0);
            for (int _240 = -5; _240 < 6; )
            {
                int2 _247 = clamp(_235 + int2(0, _240), int2(0), cbBLUR._imageSize - int2(1));
                int _248 = _247.y;
                int2 _258 = int2(_84, _248 & 7) + int2(0, 8 * ((int(float(_248) * 0.125) - _88) & 7));
                _237 += (OutputCache[uint(_258.x + (_258.y * 8))] * _63[abs(_240)]);
                _240++;
                continue;
            }
            bool _276;
            if (all(_235 >= int2(0)))
            {
                _276 = all(_235 < cbBLUR._imageSize);
            }
            else
            {
                _276 = false;
            }
            if (_276)
            {
                rw_output.write(float4(_237, 1.0), uint2(uint2(_235)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _187++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _286 = _187; _286 < _81; _286++)
    {
        int _292 = 8 * _286;
        int2 _294 = _91 + int2(0, _292);
        if (_286 >= _190)
        {
            int _298 = _286 + 2;
            int2 _301 = _91 + int2(0, 8 * _298);
            float3 _303;
            _303 = float3(0.0);
            for (int _306 = -5; _306 < 6; )
            {
                int2 _311 = _301 + int2(_306, 0);
                _311.x = clamp(_311.x, 0, cbBLUR._imageSize.x - 1);
                _303 += (r_input_src.read(uint2(uint2(clamp(_311, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_306)]);
                _306++;
                continue;
            }
            int2 _330 = _74 + int2(0, 8 * (_298 & 7));
            OutputCache[uint(_330.x + (_330.y * 8))] = _303;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _338;
        _338 = float3(0.0);
        for (int _341 = -5; _341 < 6; )
        {
            int2 _348 = clamp(_294 + int2(0, _341), int2(0), cbBLUR._imageSize - int2(1));
            int _349 = _348.y;
            int2 _359 = int2(_84, _349 & 7) + int2(0, 8 * ((int(float(_349) * 0.125) - _88) & 7));
            _338 += (OutputCache[uint(_359.x + (_359.y * 8))] * _63[abs(_341)]);
            _341++;
            continue;
        }
        bool _377;
        if (all(_294 >= int2(0)))
        {
            _377 = all(_294 < cbBLUR._imageSize);
        }
        else
        {
            _377 = false;
        }
        if (_377)
        {
            rw_output.write(float4(_338, 1.0), uint2(uint2(_294)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings15[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source15=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 7> _63 = spvUnsafeArray<float, 7>({ 0.2453513443470001220703125, 0.20308943092823028564453125, 0.11517117917537689208984375, 0.0447342731058597564697265625, 0.0118956975638866424560546875, 0.0021644509397447109222412109375, 0.0002692934940569102764129638671875 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _74 = int2(gl_LocalInvocationID.xy);
    int2 _76 = int2(gl_WorkGroupID.xy);
    int _81 = (cbBLUR._imageSize.y + 63) / 64;
    int _84 = _74.x;
    int _87 = _76.y;
    int _88 = _87 * _81;
    int2 _91 = int2((_76.x * 8) + _84, _74.y + (_88 * 8));
    for (int _93 = 0; _93 < 2; _93++)
    {
        int2 _101 = _91 + int2(0, 8 * _93);
        float3 _103;
        _103 = float3(0.0);
        for (int _106 = -6; _106 < 7; )
        {
            int2 _111 = _101 + int2(_106, 0);
            _111.x = clamp(_111.x, 0, cbBLUR._imageSize.x - 1);
            _103 += (r_input_src.read(uint2(uint2(clamp(_111, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_106)]);
            _106++;
            continue;
        }
        int2 _130 = _74 + int2(0, 8 * (_93 & 7));
        OutputCache[uint(_130.x + (_130.y * 8))] = _103;
    }
    if (_87 != 0)
    {
        for (int _141 = 1; _141 < 4; _141++)
        {
            int2 _149 = _91 - int2(0, 8 * _141);
            float3 _151;
            _151 = float3(0.0);
            for (int _154 = -6; _154 < 7; )
            {
                int2 _159 = _149 + int2(_154, 0);
                _159.x = clamp(_159.x, 0, cbBLUR._imageSize.x - 1);
                _151 += (r_input_src.read(uint2(uint2(clamp(_159, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_154)]);
                _154++;
                continue;
            }
            int2 _179 = _74 + int2(0, 8 * ((8 - _141) & 7));
            OutputCache[uint(_179.x + (_179.y * 8))] = _151;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _187;
    _187 = 0;
    int _190;
    for (;;)
    {
        _190 = _81 - 2;
        if (_187 < _190)
        {
            int _194 = _187 + 2;
            int2 _197 = _91 + int2(0, 8 * _194);
            float3 _199;
            _199 = float3(0.0);
            for (int _202 = -6; _202 < 7; )
            {
                int2 _207 = _197 + int2(_202, 0);
                _207.x = clamp(_207.x, 0, cbBLUR._imageSize.x - 1);
                _199 += (r_input_src.read(uint2(uint2(clamp(_207, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_202)]);
                _202++;
                continue;
            }
            int2 _226 = _74 + int2(0, 8 * (_194 & 7));
            OutputCache[uint(_226.x + (_226.y * 8))] = _199;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _235 = _91 + int2(0, 8 * _187);
            float3 _237;
            _237 = float3(0.0);
            for (int _240 = -6; _240 < 7; )
            {
                int2 _247 = clamp(_235 + int2(0, _240), int2(0), cbBLUR._imageSize - int2(1));
                int _248 = _247.y;
                int2 _258 = int2(_84, _248 & 7) + int2(0, 8 * ((int(float(_248) * 0.125) - _88) & 7));
                _237 += (OutputCache[uint(_258.x + (_258.y * 8))] * _63[abs(_240)]);
                _240++;
                continue;
            }
            bool _276;
            if (all(_235 >= int2(0)))
            {
                _276 = all(_235 < cbBLUR._imageSize);
            }
            else
            {
                _276 = false;
            }
            if (_276)
            {
                rw_output.write(float4(_237, 1.0), uint2(uint2(_235)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _187++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _286 = _187; _286 < _81; _286++)
    {
        int _292 = 8 * _286;
        int2 _294 = _91 + int2(0, _292);
        if (_286 >= _190)
        {
            int _298 = _286 + 2;
            int2 _301 = _91 + int2(0, 8 * _298);
            float3 _303;
            _303 = float3(0.0);
            for (int _306 = -6; _306 < 7; )
            {
                int2 _311 = _301 + int2(_306, 0);
                _311.x = clamp(_311.x, 0, cbBLUR._imageSize.x - 1);
                _303 += (r_input_src.read(uint2(uint2(clamp(_311, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_306)]);
                _306++;
                continue;
            }
            int2 _330 = _74 + int2(0, 8 * (_298 & 7));
            OutputCache[uint(_330.x + (_330.y * 8))] = _303;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _338;
        _338 = float3(0.0);
        for (int _341 = -6; _341 < 7; )
        {
            int2 _348 = clamp(_294 + int2(0, _341), int2(0), cbBLUR._imageSize - int2(1));
            int _349 = _348.y;
            int2 _359 = int2(_84, _349 & 7) + int2(0, 8 * ((int(float(_349) * 0.125) - _88) & 7));
            _338 += (OutputCache[uint(_359.x + (_359.y * 8))] * _63[abs(_341)]);
            _341++;
            continue;
        }
        bool _377;
        if (all(_294 >= int2(0)))
        {
            _377 = all(_294 < cbBLUR._imageSize);
        }
        else
        {
            _377 = false;
        }
        if (_377)
        {
            rw_output.write(float4(_338, 1.0), uint2(uint2(_294)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings16[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source16=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 7> _63 = spvUnsafeArray<float, 7>({ 0.14465706050395965576171875, 0.13581113517284393310546875, 0.112388588488101959228515625, 0.081978254020214080810546875, 0.0527062825858592987060546875, 0.0298682749271392822265625, 0.0149189345538616180419921875 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _74 = int2(gl_LocalInvocationID.xy);
    int2 _76 = int2(gl_WorkGroupID.xy);
    int _81 = (cbBLUR._imageSize.y + 63) / 64;
    int _84 = _74.x;
    int _87 = _76.y;
    int _88 = _87 * _81;
    int2 _91 = int2((_76.x * 8) + _84, _74.y + (_88 * 8));
    for (int _93 = 0; _93 < 2; _93++)
    {
        int2 _101 = _91 + int2(0, 8 * _93);
        float3 _103;
        _103 = float3(0.0);
        for (int _106 = -6; _106 < 7; )
        {
            int2 _111 = _101 + int2(_106, 0);
            _111.x = clamp(_111.x, 0, cbBLUR._imageSize.x - 1);
            _103 += (r_input_src.read(uint2(uint2(clamp(_111, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_106)]);
            _106++;
            continue;
        }
        int2 _130 = _74 + int2(0, 8 * (_93 & 7));
        OutputCache[uint(_130.x + (_130.y * 8))] = _103;
    }
    if (_87 != 0)
    {
        for (int _141 = 1; _141 < 4; _141++)
        {
            int2 _149 = _91 - int2(0, 8 * _141);
            float3 _151;
            _151 = float3(0.0);
            for (int _154 = -6; _154 < 7; )
            {
                int2 _159 = _149 + int2(_154, 0);
                _159.x = clamp(_159.x, 0, cbBLUR._imageSize.x - 1);
                _151 += (r_input_src.read(uint2(uint2(clamp(_159, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_154)]);
                _154++;
                continue;
            }
            int2 _179 = _74 + int2(0, 8 * ((8 - _141) & 7));
            OutputCache[uint(_179.x + (_179.y * 8))] = _151;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _187;
    _187 = 0;
    int _190;
    for (;;)
    {
        _190 = _81 - 2;
        if (_187 < _190)
        {
            int _194 = _187 + 2;
            int2 _197 = _91 + int2(0, 8 * _194);
            float3 _199;
            _199 = float3(0.0);
            for (int _202 = -6; _202 < 7; )
            {
                int2 _207 = _197 + int2(_202, 0);
                _207.x = clamp(_207.x, 0, cbBLUR._imageSize.x - 1);
                _199 += (r_input_src.read(uint2(uint2(clamp(_207, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_202)]);
                _202++;
                continue;
            }
            int2 _226 = _74 + int2(0, 8 * (_194 & 7));
            OutputCache[uint(_226.x + (_226.y * 8))] = _199;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _235 = _91 + int2(0, 8 * _187);
            float3 _237;
            _237 = float3(0.0);
            for (int _240 = -6; _240 < 7; )
            {
                int2 _247 = clamp(_235 + int2(0, _240), int2(0), cbBLUR._imageSize - int2(1));
                int _248 = _247.y;
                int2 _258 = int2(_84, _248 & 7) + int2(0, 8 * ((int(float(_248) * 0.125) - _88) & 7));
                _237 += (OutputCache[uint(_258.x + (_258.y * 8))] * _63[abs(_240)]);
                _240++;
                continue;
            }
            bool _276;
            if (all(_235 >= int2(0)))
            {
                _276 = all(_235 < cbBLUR._imageSize);
            }
            else
            {
                _276 = false;
            }
            if (_276)
            {
                rw_output.write(float4(_237, 1.0), uint2(uint2(_235)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _187++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _286 = _187; _286 < _81; _286++)
    {
        int _292 = 8 * _286;
        int2 _294 = _91 + int2(0, _292);
        if (_286 >= _190)
        {
            int _298 = _286 + 2;
            int2 _301 = _91 + int2(0, 8 * _298);
            float3 _303;
            _303 = float3(0.0);
            for (int _306 = -6; _306 < 7; )
            {
                int2 _311 = _301 + int2(_306, 0);
                _311.x = clamp(_311.x, 0, cbBLUR._imageSize.x - 1);
                _303 += (r_input_src.read(uint2(uint2(clamp(_311, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_306)]);
                _306++;
                continue;
            }
            int2 _330 = _74 + int2(0, 8 * (_298 & 7));
            OutputCache[uint(_330.x + (_330.y * 8))] = _303;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _338;
        _338 = float3(0.0);
        for (int _341 = -6; _341 < 7; )
        {
            int2 _348 = clamp(_294 + int2(0, _341), int2(0), cbBLUR._imageSize - int2(1));
            int _349 = _348.y;
            int2 _359 = int2(_84, _349 & 7) + int2(0, 8 * ((int(float(_349) * 0.125) - _88) & 7));
            _338 += (OutputCache[uint(_359.x + (_359.y * 8))] * _63[abs(_341)]);
            _341++;
            continue;
        }
        bool _377;
        if (all(_294 >= int2(0)))
        {
            _377 = all(_294 < cbBLUR._imageSize);
        }
        else
        {
            _377 = false;
        }
        if (_377)
        {
            rw_output.write(float4(_338, 1.0), uint2(uint2(_294)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings17[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source17=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 7> _63 = spvUnsafeArray<float, 7>({ 0.111042968928813934326171875, 0.107644021511077880859375, 0.098058752715587615966796875, 0.083942212164402008056640625, 0.0675261318683624267578125, 0.0510458610951900482177734375, 0.036261536180973052978515625 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _74 = int2(gl_LocalInvocationID.xy);
    int2 _76 = int2(gl_WorkGroupID.xy);
    int _81 = (cbBLUR._imageSize.y + 63) / 64;
    int _84 = _74.x;
    int _87 = _76.y;
    int _88 = _87 * _81;
    int2 _91 = int2((_76.x * 8) + _84, _74.y + (_88 * 8));
    for (int _93 = 0; _93 < 2; _93++)
    {
        int2 _101 = _91 + int2(0, 8 * _93);
        float3 _103;
        _103 = float3(0.0);
        for (int _106 = -6; _106 < 7; )
        {
            int2 _111 = _101 + int2(_106, 0);
            _111.x = clamp(_111.x, 0, cbBLUR._imageSize.x - 1);
            _103 += (r_input_src.read(uint2(uint2(clamp(_111, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_106)]);
            _106++;
            continue;
        }
        int2 _130 = _74 + int2(0, 8 * (_93 & 7));
        OutputCache[uint(_130.x + (_130.y * 8))] = _103;
    }
    if (_87 != 0)
    {
        for (int _141 = 1; _141 < 4; _141++)
        {
            int2 _149 = _91 - int2(0, 8 * _141);
            float3 _151;
            _151 = float3(0.0);
            for (int _154 = -6; _154 < 7; )
            {
                int2 _159 = _149 + int2(_154, 0);
                _159.x = clamp(_159.x, 0, cbBLUR._imageSize.x - 1);
                _151 += (r_input_src.read(uint2(uint2(clamp(_159, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_154)]);
                _154++;
                continue;
            }
            int2 _179 = _74 + int2(0, 8 * ((8 - _141) & 7));
            OutputCache[uint(_179.x + (_179.y * 8))] = _151;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _187;
    _187 = 0;
    int _190;
    for (;;)
    {
        _190 = _81 - 2;
        if (_187 < _190)
        {
            int _194 = _187 + 2;
            int2 _197 = _91 + int2(0, 8 * _194);
            float3 _199;
            _199 = float3(0.0);
            for (int _202 = -6; _202 < 7; )
            {
                int2 _207 = _197 + int2(_202, 0);
                _207.x = clamp(_207.x, 0, cbBLUR._imageSize.x - 1);
                _199 += (r_input_src.read(uint2(uint2(clamp(_207, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_202)]);
                _202++;
                continue;
            }
            int2 _226 = _74 + int2(0, 8 * (_194 & 7));
            OutputCache[uint(_226.x + (_226.y * 8))] = _199;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _235 = _91 + int2(0, 8 * _187);
            float3 _237;
            _237 = float3(0.0);
            for (int _240 = -6; _240 < 7; )
            {
                int2 _247 = clamp(_235 + int2(0, _240), int2(0), cbBLUR._imageSize - int2(1));
                int _248 = _247.y;
                int2 _258 = int2(_84, _248 & 7) + int2(0, 8 * ((int(float(_248) * 0.125) - _88) & 7));
                _237 += (OutputCache[uint(_258.x + (_258.y * 8))] * _63[abs(_240)]);
                _240++;
                continue;
            }
            bool _276;
            if (all(_235 >= int2(0)))
            {
                _276 = all(_235 < cbBLUR._imageSize);
            }
            else
            {
                _276 = false;
            }
            if (_276)
            {
                rw_output.write(float4(_237, 1.0), uint2(uint2(_235)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _187++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _286 = _187; _286 < _81; _286++)
    {
        int _292 = 8 * _286;
        int2 _294 = _91 + int2(0, _292);
        if (_286 >= _190)
        {
            int _298 = _286 + 2;
            int2 _301 = _91 + int2(0, 8 * _298);
            float3 _303;
            _303 = float3(0.0);
            for (int _306 = -6; _306 < 7; )
            {
                int2 _311 = _301 + int2(_306, 0);
                _311.x = clamp(_311.x, 0, cbBLUR._imageSize.x - 1);
                _303 += (r_input_src.read(uint2(uint2(clamp(_311, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _63[abs(_306)]);
                _306++;
                continue;
            }
            int2 _330 = _74 + int2(0, 8 * (_298 & 7));
            OutputCache[uint(_330.x + (_330.y * 8))] = _303;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _338;
        _338 = float3(0.0);
        for (int _341 = -6; _341 < 7; )
        {
            int2 _348 = clamp(_294 + int2(0, _341), int2(0), cbBLUR._imageSize - int2(1));
            int _349 = _348.y;
            int2 _359 = int2(_84, _349 & 7) + int2(0, 8 * ((int(float(_349) * 0.125) - _88) & 7));
            _338 += (OutputCache[uint(_359.x + (_359.y * 8))] * _63[abs(_341)]);
            _341++;
            continue;
        }
        bool _377;
        if (all(_294 >= int2(0)))
        {
            _377 = all(_294 < cbBLUR._imageSize);
        }
        else
        {
            _377 = false;
        }
        if (_377)
        {
            rw_output.write(float4(_338, 1.0), uint2(uint2(_294)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings18[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source18=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 8> _64 = spvUnsafeArray<float, 8>({ 0.2453401088714599609375, 0.20308013260364532470703125, 0.11516590416431427001953125, 0.0447322241961956024169921875, 0.0118951536715030670166015625, 0.002164351753890514373779296875, 0.000269281095825135707855224609375, 2.28921999223530292510986328125e-05 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _75 = int2(gl_LocalInvocationID.xy);
    int2 _77 = int2(gl_WorkGroupID.xy);
    int _82 = (cbBLUR._imageSize.y + 63) / 64;
    int _85 = _75.x;
    int _88 = _77.y;
    int _89 = _88 * _82;
    int2 _92 = int2((_77.x * 8) + _85, _75.y + (_89 * 8));
    for (int _94 = 0; _94 < 2; _94++)
    {
        int2 _102 = _92 + int2(0, 8 * _94);
        float3 _104;
        _104 = float3(0.0);
        for (int _107 = -7; _107 < 8; )
        {
            int2 _112 = _102 + int2(_107, 0);
            _112.x = clamp(_112.x, 0, cbBLUR._imageSize.x - 1);
            _104 += (r_input_src.read(uint2(uint2(clamp(_112, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _64[abs(_107)]);
            _107++;
            continue;
        }
        int2 _131 = _75 + int2(0, 8 * (_94 & 7));
        OutputCache[uint(_131.x + (_131.y * 8))] = _104;
    }
    if (_88 != 0)
    {
        for (int _142 = 1; _142 < 4; _142++)
        {
            int2 _150 = _92 - int2(0, 8 * _142);
            float3 _152;
            _152 = float3(0.0);
            for (int _155 = -7; _155 < 8; )
            {
                int2 _160 = _150 + int2(_155, 0);
                _160.x = clamp(_160.x, 0, cbBLUR._imageSize.x - 1);
                _152 += (r_input_src.read(uint2(uint2(clamp(_160, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _64[abs(_155)]);
                _155++;
                continue;
            }
            int2 _180 = _75 + int2(0, 8 * ((8 - _142) & 7));
            OutputCache[uint(_180.x + (_180.y * 8))] = _152;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _188;
    _188 = 0;
    int _191;
    for (;;)
    {
        _191 = _82 - 2;
        if (_188 < _191)
        {
            int _195 = _188 + 2;
            int2 _198 = _92 + int2(0, 8 * _195);
            float3 _200;
            _200 = float3(0.0);
            for (int _203 = -7; _203 < 8; )
            {
                int2 _208 = _198 + int2(_203, 0);
                _208.x = clamp(_208.x, 0, cbBLUR._imageSize.x - 1);
                _200 += (r_input_src.read(uint2(uint2(clamp(_208, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _64[abs(_203)]);
                _203++;
                continue;
            }
            int2 _227 = _75 + int2(0, 8 * (_195 & 7));
            OutputCache[uint(_227.x + (_227.y * 8))] = _200;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _236 = _92 + int2(0, 8 * _188);
            float3 _238;
            _238 = float3(0.0);
            for (int _241 = -7; _241 < 8; )
            {
                int2 _248 = clamp(_236 + int2(0, _241), int2(0), cbBLUR._imageSize - int2(1));
                int _249 = _248.y;
                int2 _259 = int2(_85, _249 & 7) + int2(0, 8 * ((int(float(_249) * 0.125) - _89) & 7));
                _238 += (OutputCache[uint(_259.x + (_259.y * 8))] * _64[abs(_241)]);
                _241++;
                continue;
            }
            bool _277;
            if (all(_236 >= int2(0)))
            {
                _277 = all(_236 < cbBLUR._imageSize);
            }
            else
            {
                _277 = false;
            }
            if (_277)
            {
                rw_output.write(float4(_238, 1.0), uint2(uint2(_236)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _188++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _287 = _188; _287 < _82; _287++)
    {
        int _293 = 8 * _287;
        int2 _295 = _92 + int2(0, _293);
        if (_287 >= _191)
        {
            int _299 = _287 + 2;
            int2 _302 = _92 + int2(0, 8 * _299);
            float3 _304;
            _304 = float3(0.0);
            for (int _307 = -7; _307 < 8; )
            {
                int2 _312 = _302 + int2(_307, 0);
                _312.x = clamp(_312.x, 0, cbBLUR._imageSize.x - 1);
                _304 += (r_input_src.read(uint2(uint2(clamp(_312, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _64[abs(_307)]);
                _307++;
                continue;
            }
            int2 _331 = _75 + int2(0, 8 * (_299 & 7));
            OutputCache[uint(_331.x + (_331.y * 8))] = _304;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _339;
        _339 = float3(0.0);
        for (int _342 = -7; _342 < 8; )
        {
            int2 _349 = clamp(_295 + int2(0, _342), int2(0), cbBLUR._imageSize - int2(1));
            int _350 = _349.y;
            int2 _360 = int2(_85, _350 & 7) + int2(0, 8 * ((int(float(_350) * 0.125) - _89) & 7));
            _339 += (OutputCache[uint(_360.x + (_360.y * 8))] * _64[abs(_342)]);
            _342++;
            continue;
        }
        bool _378;
        if (all(_295 >= int2(0)))
        {
            _378 = all(_295 < cbBLUR._imageSize);
        }
        else
        {
            _378 = false;
        }
        if (_378)
        {
            rw_output.write(float4(_339, 1.0), uint2(uint2(_295)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings19[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source19=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 8> _64 = spvUnsafeArray<float, 8>({ 0.14278145134449005126953125, 0.1340502202510833740234375, 0.1109313666820526123046875, 0.08091533184051513671875, 0.052022896707057952880859375, 0.02948100678622722625732421875, 0.01472549699246883392333984375, 0.0064829476177692413330078125 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _75 = int2(gl_LocalInvocationID.xy);
    int2 _77 = int2(gl_WorkGroupID.xy);
    int _82 = (cbBLUR._imageSize.y + 63) / 64;
    int _85 = _75.x;
    int _88 = _77.y;
    int _89 = _88 * _82;
    int2 _92 = int2((_77.x * 8) + _85, _75.y + (_89 * 8));
    for (int _94 = 0; _94 < 2; _94++)
    {
        int2 _102 = _92 + int2(0, 8 * _94);
        float3 _104;
        _104 = float3(0.0);
        for (int _107 = -7; _107 < 8; )
        {
            int2 _112 = _102 + int2(_107, 0);
            _112.x = clamp(_112.x, 0, cbBLUR._imageSize.x - 1);
            _104 += (r_input_src.read(uint2(uint2(clamp(_112, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _64[abs(_107)]);
            _107++;
            continue;
        }
        int2 _131 = _75 + int2(0, 8 * (_94 & 7));
        OutputCache[uint(_131.x + (_131.y * 8))] = _104;
    }
    if (_88 != 0)
    {
        for (int _142 = 1; _142 < 4; _142++)
        {
            int2 _150 = _92 - int2(0, 8 * _142);
            float3 _152;
            _152 = float3(0.0);
            for (int _155 = -7; _155 < 8; )
            {
                int2 _160 = _150 + int2(_155, 0);
                _160.x = clamp(_160.x, 0, cbBLUR._imageSize.x - 1);
                _152 += (r_input_src.read(uint2(uint2(clamp(_160, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _64[abs(_155)]);
                _155++;
                continue;
            }
            int2 _180 = _75 + int2(0, 8 * ((8 - _142) & 7));
            OutputCache[uint(_180.x + (_180.y * 8))] = _152;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _188;
    _188 = 0;
    int _191;
    for (;;)
    {
        _191 = _82 - 2;
        if (_188 < _191)
        {
            int _195 = _188 + 2;
            int2 _198 = _92 + int2(0, 8 * _195);
            float3 _200;
            _200 = float3(0.0);
            for (int _203 = -7; _203 < 8; )
            {
                int2 _208 = _198 + int2(_203, 0);
                _208.x = clamp(_208.x, 0, cbBLUR._imageSize.x - 1);
                _200 += (r_input_src.read(uint2(uint2(clamp(_208, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _64[abs(_203)]);
                _203++;
                continue;
            }
            int2 _227 = _75 + int2(0, 8 * (_195 & 7));
            OutputCache[uint(_227.x + (_227.y * 8))] = _200;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _236 = _92 + int2(0, 8 * _188);
            float3 _238;
            _238 = float3(0.0);
            for (int _241 = -7; _241 < 8; )
            {
                int2 _248 = clamp(_236 + int2(0, _241), int2(0), cbBLUR._imageSize - int2(1));
                int _249 = _248.y;
                int2 _259 = int2(_85, _249 & 7) + int2(0, 8 * ((int(float(_249) * 0.125) - _89) & 7));
                _238 += (OutputCache[uint(_259.x + (_259.y * 8))] * _64[abs(_241)]);
                _241++;
                continue;
            }
            bool _277;
            if (all(_236 >= int2(0)))
            {
                _277 = all(_236 < cbBLUR._imageSize);
            }
            else
            {
                _277 = false;
            }
            if (_277)
            {
                rw_output.write(float4(_238, 1.0), uint2(uint2(_236)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _188++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _287 = _188; _287 < _82; _287++)
    {
        int _293 = 8 * _287;
        int2 _295 = _92 + int2(0, _293);
        if (_287 >= _191)
        {
            int _299 = _287 + 2;
            int2 _302 = _92 + int2(0, 8 * _299);
            float3 _304;
            _304 = float3(0.0);
            for (int _307 = -7; _307 < 8; )
            {
                int2 _312 = _302 + int2(_307, 0);
                _312.x = clamp(_312.x, 0, cbBLUR._imageSize.x - 1);
                _304 += (r_input_src.read(uint2(uint2(clamp(_312, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _64[abs(_307)]);
                _307++;
                continue;
            }
            int2 _331 = _75 + int2(0, 8 * (_299 & 7));
            OutputCache[uint(_331.x + (_331.y * 8))] = _304;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _339;
        _339 = float3(0.0);
        for (int _342 = -7; _342 < 8; )
        {
            int2 _349 = clamp(_295 + int2(0, _342), int2(0), cbBLUR._imageSize - int2(1));
            int _350 = _349.y;
            int2 _360 = int2(_85, _350 & 7) + int2(0, 8 * ((int(float(_350) * 0.125) - _89) & 7));
            _339 += (OutputCache[uint(_360.x + (_360.y * 8))] * _64[abs(_342)]);
            _342++;
            continue;
        }
        bool _378;
        if (all(_295 >= int2(0)))
        {
            _378 = all(_295 < cbBLUR._imageSize);
        }
        else
        {
            _378 = false;
        }
        if (_378)
        {
            rw_output.write(float4(_339, 1.0), uint2(uint2(_295)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings20[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source20=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 8> _64 = spvUnsafeArray<float, 8>({ 0.105915330350399017333984375, 0.10267333686351776123046875, 0.093530692160129547119140625, 0.08006601035594940185546875, 0.0644079744815826416015625, 0.0486887134611606597900390625, 0.034587085247039794921875, 0.02308853156864643096923828125 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _75 = int2(gl_LocalInvocationID.xy);
    int2 _77 = int2(gl_WorkGroupID.xy);
    int _82 = (cbBLUR._imageSize.y + 63) / 64;
    int _85 = _75.x;
    int _88 = _77.y;
    int _89 = _88 * _82;
    int2 _92 = int2((_77.x * 8) + _85, _75.y + (_89 * 8));
    for (int _94 = 0; _94 < 2; _94++)
    {
        int2 _102 = _92 + int2(0, 8 * _94);
        float3 _104;
        _104 = float3(0.0);
        for (int _107 = -7; _107 < 8; )
        {
            int2 _112 = _102 + int2(_107, 0);
            _112.x = clamp(_112.x, 0, cbBLUR._imageSize.x - 1);
            _104 += (r_input_src.read(uint2(uint2(clamp(_112, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _64[abs(_107)]);
            _107++;
            continue;
        }
        int2 _131 = _75 + int2(0, 8 * (_94 & 7));
        OutputCache[uint(_131.x + (_131.y * 8))] = _104;
    }
    if (_88 != 0)
    {
        for (int _142 = 1; _142 < 4; _142++)
        {
            int2 _150 = _92 - int2(0, 8 * _142);
            float3 _152;
            _152 = float3(0.0);
            for (int _155 = -7; _155 < 8; )
            {
                int2 _160 = _150 + int2(_155, 0);
                _160.x = clamp(_160.x, 0, cbBLUR._imageSize.x - 1);
                _152 += (r_input_src.read(uint2(uint2(clamp(_160, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _64[abs(_155)]);
                _155++;
                continue;
            }
            int2 _180 = _75 + int2(0, 8 * ((8 - _142) & 7));
            OutputCache[uint(_180.x + (_180.y * 8))] = _152;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _188;
    _188 = 0;
    int _191;
    for (;;)
    {
        _191 = _82 - 2;
        if (_188 < _191)
        {
            int _195 = _188 + 2;
            int2 _198 = _92 + int2(0, 8 * _195);
            float3 _200;
            _200 = float3(0.0);
            for (int _203 = -7; _203 < 8; )
            {
                int2 _208 = _198 + int2(_203, 0);
                _208.x = clamp(_208.x, 0, cbBLUR._imageSize.x - 1);
                _200 += (r_input_src.read(uint2(uint2(clamp(_208, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _64[abs(_203)]);
                _203++;
                continue;
            }
            int2 _227 = _75 + int2(0, 8 * (_195 & 7));
            OutputCache[uint(_227.x + (_227.y * 8))] = _200;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _236 = _92 + int2(0, 8 * _188);
            float3 _238;
            _238 = float3(0.0);
            for (int _241 = -7; _241 < 8; )
            {
                int2 _248 = clamp(_236 + int2(0, _241), int2(0), cbBLUR._imageSize - int2(1));
                int _249 = _248.y;
                int2 _259 = int2(_85, _249 & 7) + int2(0, 8 * ((int(float(_249) * 0.125) - _89) & 7));
                _238 += (OutputCache[uint(_259.x + (_259.y * 8))] * _64[abs(_241)]);
                _241++;
                continue;
            }
            bool _277;
            if (all(_236 >= int2(0)))
            {
                _277 = all(_236 < cbBLUR._imageSize);
            }
            else
            {
                _277 = false;
            }
            if (_277)
            {
                rw_output.write(float4(_238, 1.0), uint2(uint2(_236)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _188++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _287 = _188; _287 < _82; _287++)
    {
        int _293 = 8 * _287;
        int2 _295 = _92 + int2(0, _293);
        if (_287 >= _191)
        {
            int _299 = _287 + 2;
            int2 _302 = _92 + int2(0, 8 * _299);
            float3 _304;
            _304 = float3(0.0);
            for (int _307 = -7; _307 < 8; )
            {
                int2 _312 = _302 + int2(_307, 0);
                _312.x = clamp(_312.x, 0, cbBLUR._imageSize.x - 1);
                _304 += (r_input_src.read(uint2(uint2(clamp(_312, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _64[abs(_307)]);
                _307++;
                continue;
            }
            int2 _331 = _75 + int2(0, 8 * (_299 & 7));
            OutputCache[uint(_331.x + (_331.y * 8))] = _304;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _339;
        _339 = float3(0.0);
        for (int _342 = -7; _342 < 8; )
        {
            int2 _349 = clamp(_295 + int2(0, _342), int2(0), cbBLUR._imageSize - int2(1));
            int _350 = _349.y;
            int2 _360 = int2(_85, _350 & 7) + int2(0, 8 * ((int(float(_350) * 0.125) - _89) & 7));
            _339 += (OutputCache[uint(_360.x + (_360.y * 8))] * _64[abs(_342)]);
            _342++;
            continue;
        }
        bool _378;
        if (all(_295 >= int2(0)))
        {
            _378 = all(_295 < cbBLUR._imageSize);
        }
        else
        {
            _378 = false;
        }
        if (_378)
        {
            rw_output.write(float4(_339, 1.0), uint2(uint2(_295)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings21[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source21=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 9> _66 = spvUnsafeArray<float, 9>({ 0.24533946812152862548828125, 0.20307959616184234619140625, 0.115165598690509796142578125, 0.0447321049869060516357421875, 0.01189512200653553009033203125, 0.002164346165955066680908203125, 0.000269280397333204746246337890625, 2.28921999223530292510986328125e-05, 1.3287000228956458158791065216064e-06 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _77 = int2(gl_LocalInvocationID.xy);
    int2 _79 = int2(gl_WorkGroupID.xy);
    int _84 = (cbBLUR._imageSize.y + 63) / 64;
    int _87 = _77.x;
    int _90 = _79.y;
    int _91 = _90 * _84;
    int2 _94 = int2((_79.x * 8) + _87, _77.y + (_91 * 8));
    for (int _96 = 0; _96 < 3; _96++)
    {
        int2 _104 = _94 + int2(0, 8 * _96);
        float3 _106;
        _106 = float3(0.0);
        for (int _109 = -8; _109 < 9; )
        {
            int2 _114 = _104 + int2(_109, 0);
            _114.x = clamp(_114.x, 0, cbBLUR._imageSize.x - 1);
            _106 += (r_input_src.read(uint2(uint2(clamp(_114, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _66[abs(_109)]);
            _109++;
            continue;
        }
        int2 _133 = _77 + int2(0, 8 * (_96 & 7));
        OutputCache[uint(_133.x + (_133.y * 8))] = _106;
    }
    if (_90 != 0)
    {
        for (int _144 = 1; _144 < 6; _144++)
        {
            int2 _152 = _94 - int2(0, 8 * _144);
            float3 _154;
            _154 = float3(0.0);
            for (int _157 = -8; _157 < 9; )
            {
                int2 _162 = _152 + int2(_157, 0);
                _162.x = clamp(_162.x, 0, cbBLUR._imageSize.x - 1);
                _154 += (r_input_src.read(uint2(uint2(clamp(_162, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _66[abs(_157)]);
                _157++;
                continue;
            }
            int2 _182 = _77 + int2(0, 8 * ((8 - _144) & 7));
            OutputCache[uint(_182.x + (_182.y * 8))] = _154;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _190;
    _190 = 0;
    int _193;
    for (;;)
    {
        _193 = _84 - 3;
        if (_190 < _193)
        {
            int _197 = _190 + 3;
            int2 _200 = _94 + int2(0, 8 * _197);
            float3 _202;
            _202 = float3(0.0);
            for (int _205 = -8; _205 < 9; )
            {
                int2 _210 = _200 + int2(_205, 0);
                _210.x = clamp(_210.x, 0, cbBLUR._imageSize.x - 1);
                _202 += (r_input_src.read(uint2(uint2(clamp(_210, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _66[abs(_205)]);
                _205++;
                continue;
            }
            int2 _229 = _77 + int2(0, 8 * (_197 & 7));
            OutputCache[uint(_229.x + (_229.y * 8))] = _202;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _238 = _94 + int2(0, 8 * _190);
            float3 _240;
            _240 = float3(0.0);
            for (int _243 = -8; _243 < 9; )
            {
                int2 _250 = clamp(_238 + int2(0, _243), int2(0), cbBLUR._imageSize - int2(1));
                int _251 = _250.y;
                int2 _261 = int2(_87, _251 & 7) + int2(0, 8 * ((int(float(_251) * 0.125) - _91) & 7));
                _240 += (OutputCache[uint(_261.x + (_261.y * 8))] * _66[abs(_243)]);
                _243++;
                continue;
            }
            bool _279;
            if (all(_238 >= int2(0)))
            {
                _279 = all(_238 < cbBLUR._imageSize);
            }
            else
            {
                _279 = false;
            }
            if (_279)
            {
                rw_output.write(float4(_240, 1.0), uint2(uint2(_238)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _190++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _289 = _190; _289 < _84; _289++)
    {
        int _295 = 8 * _289;
        int2 _297 = _94 + int2(0, _295);
        if (_289 >= _193)
        {
            int _301 = _289 + 3;
            int2 _304 = _94 + int2(0, 8 * _301);
            float3 _306;
            _306 = float3(0.0);
            for (int _309 = -8; _309 < 9; )
            {
                int2 _314 = _304 + int2(_309, 0);
                _314.x = clamp(_314.x, 0, cbBLUR._imageSize.x - 1);
                _306 += (r_input_src.read(uint2(uint2(clamp(_314, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _66[abs(_309)]);
                _309++;
                continue;
            }
            int2 _333 = _77 + int2(0, 8 * (_301 & 7));
            OutputCache[uint(_333.x + (_333.y * 8))] = _306;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _341;
        _341 = float3(0.0);
        for (int _344 = -8; _344 < 9; )
        {
            int2 _351 = clamp(_297 + int2(0, _344), int2(0), cbBLUR._imageSize - int2(1));
            int _352 = _351.y;
            int2 _362 = int2(_87, _352 & 7) + int2(0, 8 * ((int(float(_352) * 0.125) - _91) & 7));
            _341 += (OutputCache[uint(_362.x + (_362.y * 8))] * _66[abs(_344)]);
            _344++;
            continue;
        }
        bool _380;
        if (all(_297 >= int2(0)))
        {
            _380 = all(_297 < cbBLUR._imageSize);
        }
        else
        {
            _380 = false;
        }
        if (_380)
        {
            rw_output.write(float4(_341, 1.0), uint2(uint2(_297)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings22[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source22=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 9> _66 = spvUnsafeArray<float, 9>({ 0.1420666873455047607421875, 0.133379161357879638671875, 0.110376037657260894775390625, 0.080510266125202178955078125, 0.051762469112873077392578125, 0.0293334238231182098388671875, 0.01465178094804286956787109375, 0.0064504933543503284454345703125, 0.0025030211545526981353759765625 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _77 = int2(gl_LocalInvocationID.xy);
    int2 _79 = int2(gl_WorkGroupID.xy);
    int _84 = (cbBLUR._imageSize.y + 63) / 64;
    int _87 = _77.x;
    int _90 = _79.y;
    int _91 = _90 * _84;
    int2 _94 = int2((_79.x * 8) + _87, _77.y + (_91 * 8));
    for (int _96 = 0; _96 < 3; _96++)
    {
        int2 _104 = _94 + int2(0, 8 * _96);
        float3 _106;
        _106 = float3(0.0);
        for (int _109 = -8; _109 < 9; )
        {
            int2 _114 = _104 + int2(_109, 0);
            _114.x = clamp(_114.x, 0, cbBLUR._imageSize.x - 1);
            _106 += (r_input_src.read(uint2(uint2(clamp(_114, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _66[abs(_109)]);
            _109++;
            continue;
        }
        int2 _133 = _77 + int2(0, 8 * (_96 & 7));
        OutputCache[uint(_133.x + (_133.y * 8))] = _106;
    }
    if (_90 != 0)
    {
        for (int _144 = 1; _144 < 6; _144++)
        {
            int2 _152 = _94 - int2(0, 8 * _144);
            float3 _154;
            _154 = float3(0.0);
            for (int _157 = -8; _157 < 9; )
            {
                int2 _162 = _152 + int2(_157, 0);
                _162.x = clamp(_162.x, 0, cbBLUR._imageSize.x - 1);
                _154 += (r_input_src.read(uint2(uint2(clamp(_162, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _66[abs(_157)]);
                _157++;
                continue;
            }
            int2 _182 = _77 + int2(0, 8 * ((8 - _144) & 7));
            OutputCache[uint(_182.x + (_182.y * 8))] = _154;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _190;
    _190 = 0;
    int _193;
    for (;;)
    {
        _193 = _84 - 3;
        if (_190 < _193)
        {
            int _197 = _190 + 3;
            int2 _200 = _94 + int2(0, 8 * _197);
            float3 _202;
            _202 = float3(0.0);
            for (int _205 = -8; _205 < 9; )
            {
                int2 _210 = _200 + int2(_205, 0);
                _210.x = clamp(_210.x, 0, cbBLUR._imageSize.x - 1);
                _202 += (r_input_src.read(uint2(uint2(clamp(_210, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _66[abs(_205)]);
                _205++;
                continue;
            }
            int2 _229 = _77 + int2(0, 8 * (_197 & 7));
            OutputCache[uint(_229.x + (_229.y * 8))] = _202;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _238 = _94 + int2(0, 8 * _190);
            float3 _240;
            _240 = float3(0.0);
            for (int _243 = -8; _243 < 9; )
            {
                int2 _250 = clamp(_238 + int2(0, _243), int2(0), cbBLUR._imageSize - int2(1));
                int _251 = _250.y;
                int2 _261 = int2(_87, _251 & 7) + int2(0, 8 * ((int(float(_251) * 0.125) - _91) & 7));
                _240 += (OutputCache[uint(_261.x + (_261.y * 8))] * _66[abs(_243)]);
                _243++;
                continue;
            }
            bool _279;
            if (all(_238 >= int2(0)))
            {
                _279 = all(_238 < cbBLUR._imageSize);
            }
            else
            {
                _279 = false;
            }
            if (_279)
            {
                rw_output.write(float4(_240, 1.0), uint2(uint2(_238)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _190++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _289 = _190; _289 < _84; _289++)
    {
        int _295 = 8 * _289;
        int2 _297 = _94 + int2(0, _295);
        if (_289 >= _193)
        {
            int _301 = _289 + 3;
            int2 _304 = _94 + int2(0, 8 * _301);
            float3 _306;
            _306 = float3(0.0);
            for (int _309 = -8; _309 < 9; )
            {
                int2 _314 = _304 + int2(_309, 0);
                _314.x = clamp(_314.x, 0, cbBLUR._imageSize.x - 1);
                _306 += (r_input_src.read(uint2(uint2(clamp(_314, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _66[abs(_309)]);
                _309++;
                continue;
            }
            int2 _333 = _77 + int2(0, 8 * (_301 & 7));
            OutputCache[uint(_333.x + (_333.y * 8))] = _306;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _341;
        _341 = float3(0.0);
        for (int _344 = -8; _344 < 9; )
        {
            int2 _351 = clamp(_297 + int2(0, _344), int2(0), cbBLUR._imageSize - int2(1));
            int _352 = _351.y;
            int2 _362 = int2(_87, _352 & 7) + int2(0, 8 * ((int(float(_352) * 0.125) - _91) & 7));
            _341 += (OutputCache[uint(_362.x + (_362.y * 8))] * _66[abs(_344)]);
            _344++;
            continue;
        }
        bool _380;
        if (all(_297 >= int2(0)))
        {
            _380 = all(_297 < cbBLUR._imageSize);
        }
        else
        {
            _380 = false;
        }
        if (_380)
        {
            rw_output.write(float4(_341, 1.0), uint2(uint2(_297)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings23[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source23=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 9> _66 = spvUnsafeArray<float, 9>({ 0.1029336452484130859375, 0.0997829139232635498046875, 0.0908976495265960693359375, 0.077812016010284423828125, 0.062594778835773468017578125, 0.047318048775196075439453125, 0.0336134023964405059814453125, 0.0224385522305965423583984375, 0.01407581381499767303466796875 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _77 = int2(gl_LocalInvocationID.xy);
    int2 _79 = int2(gl_WorkGroupID.xy);
    int _84 = (cbBLUR._imageSize.y + 63) / 64;
    int _87 = _77.x;
    int _90 = _79.y;
    int _91 = _90 * _84;
    int2 _94 = int2((_79.x * 8) + _87, _77.y + (_91 * 8));
    for (int _96 = 0; _96 < 3; _96++)
    {
        int2 _104 = _94 + int2(0, 8 * _96);
        float3 _106;
        _106 = float3(0.0);
        for (int _109 = -8; _109 < 9; )
        {
            int2 _114 = _104 + int2(_109, 0);
            _114.x = clamp(_114.x, 0, cbBLUR._imageSize.x - 1);
            _106 += (r_input_src.read(uint2(uint2(clamp(_114, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _66[abs(_109)]);
            _109++;
            continue;
        }
        int2 _133 = _77 + int2(0, 8 * (_96 & 7));
        OutputCache[uint(_133.x + (_133.y * 8))] = _106;
    }
    if (_90 != 0)
    {
        for (int _144 = 1; _144 < 6; _144++)
        {
            int2 _152 = _94 - int2(0, 8 * _144);
            float3 _154;
            _154 = float3(0.0);
            for (int _157 = -8; _157 < 9; )
            {
                int2 _162 = _152 + int2(_157, 0);
                _162.x = clamp(_162.x, 0, cbBLUR._imageSize.x - 1);
                _154 += (r_input_src.read(uint2(uint2(clamp(_162, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _66[abs(_157)]);
                _157++;
                continue;
            }
            int2 _182 = _77 + int2(0, 8 * ((8 - _144) & 7));
            OutputCache[uint(_182.x + (_182.y * 8))] = _154;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _190;
    _190 = 0;
    int _193;
    for (;;)
    {
        _193 = _84 - 3;
        if (_190 < _193)
        {
            int _197 = _190 + 3;
            int2 _200 = _94 + int2(0, 8 * _197);
            float3 _202;
            _202 = float3(0.0);
            for (int _205 = -8; _205 < 9; )
            {
                int2 _210 = _200 + int2(_205, 0);
                _210.x = clamp(_210.x, 0, cbBLUR._imageSize.x - 1);
                _202 += (r_input_src.read(uint2(uint2(clamp(_210, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _66[abs(_205)]);
                _205++;
                continue;
            }
            int2 _229 = _77 + int2(0, 8 * (_197 & 7));
            OutputCache[uint(_229.x + (_229.y * 8))] = _202;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _238 = _94 + int2(0, 8 * _190);
            float3 _240;
            _240 = float3(0.0);
            for (int _243 = -8; _243 < 9; )
            {
                int2 _250 = clamp(_238 + int2(0, _243), int2(0), cbBLUR._imageSize - int2(1));
                int _251 = _250.y;
                int2 _261 = int2(_87, _251 & 7) + int2(0, 8 * ((int(float(_251) * 0.125) - _91) & 7));
                _240 += (OutputCache[uint(_261.x + (_261.y * 8))] * _66[abs(_243)]);
                _243++;
                continue;
            }
            bool _279;
            if (all(_238 >= int2(0)))
            {
                _279 = all(_238 < cbBLUR._imageSize);
            }
            else
            {
                _279 = false;
            }
            if (_279)
            {
                rw_output.write(float4(_240, 1.0), uint2(uint2(_238)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _190++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _289 = _190; _289 < _84; _289++)
    {
        int _295 = 8 * _289;
        int2 _297 = _94 + int2(0, _295);
        if (_289 >= _193)
        {
            int _301 = _289 + 3;
            int2 _304 = _94 + int2(0, 8 * _301);
            float3 _306;
            _306 = float3(0.0);
            for (int _309 = -8; _309 < 9; )
            {
                int2 _314 = _304 + int2(_309, 0);
                _314.x = clamp(_314.x, 0, cbBLUR._imageSize.x - 1);
                _306 += (r_input_src.read(uint2(uint2(clamp(_314, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _66[abs(_309)]);
                _309++;
                continue;
            }
            int2 _333 = _77 + int2(0, 8 * (_301 & 7));
            OutputCache[uint(_333.x + (_333.y * 8))] = _306;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _341;
        _341 = float3(0.0);
        for (int _344 = -8; _344 < 9; )
        {
            int2 _351 = clamp(_297 + int2(0, _344), int2(0), cbBLUR._imageSize - int2(1));
            int _352 = _351.y;
            int2 _362 = int2(_87, _352 & 7) + int2(0, 8 * ((int(float(_352) * 0.125) - _91) & 7));
            _341 += (OutputCache[uint(_362.x + (_362.y * 8))] * _66[abs(_344)]);
            _344++;
            continue;
        }
        bool _380;
        if (all(_297 >= int2(0)))
        {
            _380 = all(_297 < cbBLUR._imageSize);
        }
        else
        {
            _380 = false;
        }
        if (_380)
        {
            rw_output.write(float4(_341, 1.0), uint2(uint2(_297)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings24[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source24=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 10> _67 = spvUnsafeArray<float, 10>({ 0.24533943831920623779296875, 0.20307956635951995849609375, 0.11516559123992919921875, 0.044732101261615753173828125, 0.011895120143890380859375, 0.0021643457002937793731689453125, 0.000269280397333204746246337890625, 2.28921999223530292510986328125e-05, 1.3287000228956458158791065216064e-06, 5.2600000799429835751652717590332e-08 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _78 = int2(gl_LocalInvocationID.xy);
    int2 _80 = int2(gl_WorkGroupID.xy);
    int _85 = (cbBLUR._imageSize.y + 63) / 64;
    int _88 = _78.x;
    int _91 = _80.y;
    int _92 = _91 * _85;
    int2 _95 = int2((_80.x * 8) + _88, _78.y + (_92 * 8));
    for (int _97 = 0; _97 < 3; _97++)
    {
        int2 _105 = _95 + int2(0, 8 * _97);
        float3 _107;
        _107 = float3(0.0);
        for (int _110 = -9; _110 < 10; )
        {
            int2 _115 = _105 + int2(_110, 0);
            _115.x = clamp(_115.x, 0, cbBLUR._imageSize.x - 1);
            _107 += (r_input_src.read(uint2(uint2(clamp(_115, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _67[abs(_110)]);
            _110++;
            continue;
        }
        int2 _134 = _78 + int2(0, 8 * (_97 & 7));
        OutputCache[uint(_134.x + (_134.y * 8))] = _107;
    }
    if (_91 != 0)
    {
        for (int _145 = 1; _145 < 6; _145++)
        {
            int2 _153 = _95 - int2(0, 8 * _145);
            float3 _155;
            _155 = float3(0.0);
            for (int _158 = -9; _158 < 10; )
            {
                int2 _163 = _153 + int2(_158, 0);
                _163.x = clamp(_163.x, 0, cbBLUR._imageSize.x - 1);
                _155 += (r_input_src.read(uint2(uint2(clamp(_163, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _67[abs(_158)]);
                _158++;
                continue;
            }
            int2 _183 = _78 + int2(0, 8 * ((8 - _145) & 7));
            OutputCache[uint(_183.x + (_183.y * 8))] = _155;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _191;
    _191 = 0;
    int _194;
    for (;;)
    {
        _194 = _85 - 3;
        if (_191 < _194)
        {
            int _198 = _191 + 3;
            int2 _201 = _95 + int2(0, 8 * _198);
            float3 _203;
            _203 = float3(0.0);
            for (int _206 = -9; _206 < 10; )
            {
                int2 _211 = _201 + int2(_206, 0);
                _211.x = clamp(_211.x, 0, cbBLUR._imageSize.x - 1);
                _203 += (r_input_src.read(uint2(uint2(clamp(_211, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _67[abs(_206)]);
                _206++;
                continue;
            }
            int2 _230 = _78 + int2(0, 8 * (_198 & 7));
            OutputCache[uint(_230.x + (_230.y * 8))] = _203;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _239 = _95 + int2(0, 8 * _191);
            float3 _241;
            _241 = float3(0.0);
            for (int _244 = -9; _244 < 10; )
            {
                int2 _251 = clamp(_239 + int2(0, _244), int2(0), cbBLUR._imageSize - int2(1));
                int _252 = _251.y;
                int2 _262 = int2(_88, _252 & 7) + int2(0, 8 * ((int(float(_252) * 0.125) - _92) & 7));
                _241 += (OutputCache[uint(_262.x + (_262.y * 8))] * _67[abs(_244)]);
                _244++;
                continue;
            }
            bool _280;
            if (all(_239 >= int2(0)))
            {
                _280 = all(_239 < cbBLUR._imageSize);
            }
            else
            {
                _280 = false;
            }
            if (_280)
            {
                rw_output.write(float4(_241, 1.0), uint2(uint2(_239)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _191++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _290 = _191; _290 < _85; _290++)
    {
        int _296 = 8 * _290;
        int2 _298 = _95 + int2(0, _296);
        if (_290 >= _194)
        {
            int _302 = _290 + 3;
            int2 _305 = _95 + int2(0, 8 * _302);
            float3 _307;
            _307 = float3(0.0);
            for (int _310 = -9; _310 < 10; )
            {
                int2 _315 = _305 + int2(_310, 0);
                _315.x = clamp(_315.x, 0, cbBLUR._imageSize.x - 1);
                _307 += (r_input_src.read(uint2(uint2(clamp(_315, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _67[abs(_310)]);
                _310++;
                continue;
            }
            int2 _334 = _78 + int2(0, 8 * (_302 & 7));
            OutputCache[uint(_334.x + (_334.y * 8))] = _307;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _342;
        _342 = float3(0.0);
        for (int _345 = -9; _345 < 10; )
        {
            int2 _352 = clamp(_298 + int2(0, _345), int2(0), cbBLUR._imageSize - int2(1));
            int _353 = _352.y;
            int2 _363 = int2(_88, _353 & 7) + int2(0, 8 * ((int(float(_353) * 0.125) - _92) & 7));
            _342 += (OutputCache[uint(_363.x + (_363.y * 8))] * _67[abs(_345)]);
            _345++;
            continue;
        }
        bool _381;
        if (all(_298 >= int2(0)))
        {
            _381 = all(_298 < cbBLUR._imageSize);
        }
        else
        {
            _381 = false;
        }
        if (_381)
        {
            rw_output.write(float4(_342, 1.0), uint2(uint2(_298)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings25[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source25=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 10> _67 = spvUnsafeArray<float, 10>({ 0.14182387292385101318359375, 0.1331512033939361572265625, 0.110187388956546783447265625, 0.0803726613521575927734375, 0.0516739971935749053955078125, 0.02928328700363636016845703125, 0.014626738615334033966064453125, 0.0064394683577120304107666015625, 0.002498743124306201934814453125, 0.0008545857854187488555908203125 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _78 = int2(gl_LocalInvocationID.xy);
    int2 _80 = int2(gl_WorkGroupID.xy);
    int _85 = (cbBLUR._imageSize.y + 63) / 64;
    int _88 = _78.x;
    int _91 = _80.y;
    int _92 = _91 * _85;
    int2 _95 = int2((_80.x * 8) + _88, _78.y + (_92 * 8));
    for (int _97 = 0; _97 < 3; _97++)
    {
        int2 _105 = _95 + int2(0, 8 * _97);
        float3 _107;
        _107 = float3(0.0);
        for (int _110 = -9; _110 < 10; )
        {
            int2 _115 = _105 + int2(_110, 0);
            _115.x = clamp(_115.x, 0, cbBLUR._imageSize.x - 1);
            _107 += (r_input_src.read(uint2(uint2(clamp(_115, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _67[abs(_110)]);
            _110++;
            continue;
        }
        int2 _134 = _78 + int2(0, 8 * (_97 & 7));
        OutputCache[uint(_134.x + (_134.y * 8))] = _107;
    }
    if (_91 != 0)
    {
        for (int _145 = 1; _145 < 6; _145++)
        {
            int2 _153 = _95 - int2(0, 8 * _145);
            float3 _155;
            _155 = float3(0.0);
            for (int _158 = -9; _158 < 10; )
            {
                int2 _163 = _153 + int2(_158, 0);
                _163.x = clamp(_163.x, 0, cbBLUR._imageSize.x - 1);
                _155 += (r_input_src.read(uint2(uint2(clamp(_163, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _67[abs(_158)]);
                _158++;
                continue;
            }
            int2 _183 = _78 + int2(0, 8 * ((8 - _145) & 7));
            OutputCache[uint(_183.x + (_183.y * 8))] = _155;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _191;
    _191 = 0;
    int _194;
    for (;;)
    {
        _194 = _85 - 3;
        if (_191 < _194)
        {
            int _198 = _191 + 3;
            int2 _201 = _95 + int2(0, 8 * _198);
            float3 _203;
            _203 = float3(0.0);
            for (int _206 = -9; _206 < 10; )
            {
                int2 _211 = _201 + int2(_206, 0);
                _211.x = clamp(_211.x, 0, cbBLUR._imageSize.x - 1);
                _203 += (r_input_src.read(uint2(uint2(clamp(_211, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _67[abs(_206)]);
                _206++;
                continue;
            }
            int2 _230 = _78 + int2(0, 8 * (_198 & 7));
            OutputCache[uint(_230.x + (_230.y * 8))] = _203;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _239 = _95 + int2(0, 8 * _191);
            float3 _241;
            _241 = float3(0.0);
            for (int _244 = -9; _244 < 10; )
            {
                int2 _251 = clamp(_239 + int2(0, _244), int2(0), cbBLUR._imageSize - int2(1));
                int _252 = _251.y;
                int2 _262 = int2(_88, _252 & 7) + int2(0, 8 * ((int(float(_252) * 0.125) - _92) & 7));
                _241 += (OutputCache[uint(_262.x + (_262.y * 8))] * _67[abs(_244)]);
                _244++;
                continue;
            }
            bool _280;
            if (all(_239 >= int2(0)))
            {
                _280 = all(_239 < cbBLUR._imageSize);
            }
            else
            {
                _280 = false;
            }
            if (_280)
            {
                rw_output.write(float4(_241, 1.0), uint2(uint2(_239)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _191++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _290 = _191; _290 < _85; _290++)
    {
        int _296 = 8 * _290;
        int2 _298 = _95 + int2(0, _296);
        if (_290 >= _194)
        {
            int _302 = _290 + 3;
            int2 _305 = _95 + int2(0, 8 * _302);
            float3 _307;
            _307 = float3(0.0);
            for (int _310 = -9; _310 < 10; )
            {
                int2 _315 = _305 + int2(_310, 0);
                _315.x = clamp(_315.x, 0, cbBLUR._imageSize.x - 1);
                _307 += (r_input_src.read(uint2(uint2(clamp(_315, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _67[abs(_310)]);
                _310++;
                continue;
            }
            int2 _334 = _78 + int2(0, 8 * (_302 & 7));
            OutputCache[uint(_334.x + (_334.y * 8))] = _307;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _342;
        _342 = float3(0.0);
        for (int _345 = -9; _345 < 10; )
        {
            int2 _352 = clamp(_298 + int2(0, _345), int2(0), cbBLUR._imageSize - int2(1));
            int _353 = _352.y;
            int2 _363 = int2(_88, _353 & 7) + int2(0, 8 * ((int(float(_353) * 0.125) - _92) & 7));
            _342 += (OutputCache[uint(_363.x + (_363.y * 8))] * _67[abs(_345)]);
            _345++;
            continue;
        }
        bool _381;
        if (all(_298 >= int2(0)))
        {
            _381 = all(_298 < cbBLUR._imageSize);
        }
        else
        {
            _381 = false;
        }
        if (_381)
        {
            rw_output.write(float4(_342, 1.0), uint2(uint2(_298)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings26[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source26=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 10> _67 = spvUnsafeArray<float, 10>({ 0.101253338158130645751953125, 0.098154045641422271728515625, 0.089413821697235107421875, 0.076541803777217864990234375, 0.061572976410388946533203125, 0.0465456210076808929443359375, 0.0330646932125091552734375, 0.022072263062000274658203125, 0.013846038840711116790771484375, 0.008162067271769046783447265625 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _78 = int2(gl_LocalInvocationID.xy);
    int2 _80 = int2(gl_WorkGroupID.xy);
    int _85 = (cbBLUR._imageSize.y + 63) / 64;
    int _88 = _78.x;
    int _91 = _80.y;
    int _92 = _91 * _85;
    int2 _95 = int2((_80.x * 8) + _88, _78.y + (_92 * 8));
    for (int _97 = 0; _97 < 3; _97++)
    {
        int2 _105 = _95 + int2(0, 8 * _97);
        float3 _107;
        _107 = float3(0.0);
        for (int _110 = -9; _110 < 10; )
        {
            int2 _115 = _105 + int2(_110, 0);
            _115.x = clamp(_115.x, 0, cbBLUR._imageSize.x - 1);
            _107 += (r_input_src.read(uint2(uint2(clamp(_115, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _67[abs(_110)]);
            _110++;
            continue;
        }
        int2 _134 = _78 + int2(0, 8 * (_97 & 7));
        OutputCache[uint(_134.x + (_134.y * 8))] = _107;
    }
    if (_91 != 0)
    {
        for (int _145 = 1; _145 < 6; _145++)
        {
            int2 _153 = _95 - int2(0, 8 * _145);
            float3 _155;
            _155 = float3(0.0);
            for (int _158 = -9; _158 < 10; )
            {
                int2 _163 = _153 + int2(_158, 0);
                _163.x = clamp(_163.x, 0, cbBLUR._imageSize.x - 1);
                _155 += (r_input_src.read(uint2(uint2(clamp(_163, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _67[abs(_158)]);
                _158++;
                continue;
            }
            int2 _183 = _78 + int2(0, 8 * ((8 - _145) & 7));
            OutputCache[uint(_183.x + (_183.y * 8))] = _155;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _191;
    _191 = 0;
    int _194;
    for (;;)
    {
        _194 = _85 - 3;
        if (_191 < _194)
        {
            int _198 = _191 + 3;
            int2 _201 = _95 + int2(0, 8 * _198);
            float3 _203;
            _203 = float3(0.0);
            for (int _206 = -9; _206 < 10; )
            {
                int2 _211 = _201 + int2(_206, 0);
                _211.x = clamp(_211.x, 0, cbBLUR._imageSize.x - 1);
                _203 += (r_input_src.read(uint2(uint2(clamp(_211, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _67[abs(_206)]);
                _206++;
                continue;
            }
            int2 _230 = _78 + int2(0, 8 * (_198 & 7));
            OutputCache[uint(_230.x + (_230.y * 8))] = _203;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _239 = _95 + int2(0, 8 * _191);
            float3 _241;
            _241 = float3(0.0);
            for (int _244 = -9; _244 < 10; )
            {
                int2 _251 = clamp(_239 + int2(0, _244), int2(0), cbBLUR._imageSize - int2(1));
                int _252 = _251.y;
                int2 _262 = int2(_88, _252 & 7) + int2(0, 8 * ((int(float(_252) * 0.125) - _92) & 7));
                _241 += (OutputCache[uint(_262.x + (_262.y * 8))] * _67[abs(_244)]);
                _244++;
                continue;
            }
            bool _280;
            if (all(_239 >= int2(0)))
            {
                _280 = all(_239 < cbBLUR._imageSize);
            }
            else
            {
                _280 = false;
            }
            if (_280)
            {
                rw_output.write(float4(_241, 1.0), uint2(uint2(_239)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _191++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _290 = _191; _290 < _85; _290++)
    {
        int _296 = 8 * _290;
        int2 _298 = _95 + int2(0, _296);
        if (_290 >= _194)
        {
            int _302 = _290 + 3;
            int2 _305 = _95 + int2(0, 8 * _302);
            float3 _307;
            _307 = float3(0.0);
            for (int _310 = -9; _310 < 10; )
            {
                int2 _315 = _305 + int2(_310, 0);
                _315.x = clamp(_315.x, 0, cbBLUR._imageSize.x - 1);
                _307 += (r_input_src.read(uint2(uint2(clamp(_315, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _67[abs(_310)]);
                _310++;
                continue;
            }
            int2 _334 = _78 + int2(0, 8 * (_302 & 7));
            OutputCache[uint(_334.x + (_334.y * 8))] = _307;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _342;
        _342 = float3(0.0);
        for (int _345 = -9; _345 < 10; )
        {
            int2 _352 = clamp(_298 + int2(0, _345), int2(0), cbBLUR._imageSize - int2(1));
            int _353 = _352.y;
            int2 _363 = int2(_88, _353 & 7) + int2(0, 8 * ((int(float(_353) * 0.125) - _92) & 7));
            _342 += (OutputCache[uint(_363.x + (_363.y * 8))] * _67[abs(_345)]);
            _345++;
            continue;
        }
        bool _381;
        if (all(_298 >= int2(0)))
        {
            _381 = all(_298 < cbBLUR._imageSize);
        }
        else
        {
            _381 = false;
        }
        if (_381)
        {
            rw_output.write(float4(_342, 1.0), uint2(uint2(_298)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings27[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source27=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 11> _68 = spvUnsafeArray<float, 11>({ 0.24533943831920623779296875, 0.20307956635951995849609375, 0.11516559123992919921875, 0.044732101261615753173828125, 0.011895120143890380859375, 0.0021643457002937793731689453125, 0.000269280397333204746246337890625, 2.28921999223530292510986328125e-05, 1.3287000228956458158791065216064e-06, 5.2600000799429835751652717590332e-08, 1.4000000048142169362108688801527e-09 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _79 = int2(gl_LocalInvocationID.xy);
    int2 _81 = int2(gl_WorkGroupID.xy);
    int _86 = (cbBLUR._imageSize.y + 63) / 64;
    int _89 = _79.x;
    int _92 = _81.y;
    int _93 = _92 * _86;
    int2 _96 = int2((_81.x * 8) + _89, _79.y + (_93 * 8));
    for (int _98 = 0; _98 < 3; _98++)
    {
        int2 _106 = _96 + int2(0, 8 * _98);
        float3 _108;
        _108 = float3(0.0);
        for (int _111 = -10; _111 < 11; )
        {
            int2 _116 = _106 + int2(_111, 0);
            _116.x = clamp(_116.x, 0, cbBLUR._imageSize.x - 1);
            _108 += (r_input_src.read(uint2(uint2(clamp(_116, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _68[abs(_111)]);
            _111++;
            continue;
        }
        int2 _135 = _79 + int2(0, 8 * (_98 & 7));
        OutputCache[uint(_135.x + (_135.y * 8))] = _108;
    }
    if (_92 != 0)
    {
        for (int _146 = 1; _146 < 6; _146++)
        {
            int2 _154 = _96 - int2(0, 8 * _146);
            float3 _156;
            _156 = float3(0.0);
            for (int _159 = -10; _159 < 11; )
            {
                int2 _164 = _154 + int2(_159, 0);
                _164.x = clamp(_164.x, 0, cbBLUR._imageSize.x - 1);
                _156 += (r_input_src.read(uint2(uint2(clamp(_164, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _68[abs(_159)]);
                _159++;
                continue;
            }
            int2 _184 = _79 + int2(0, 8 * ((8 - _146) & 7));
            OutputCache[uint(_184.x + (_184.y * 8))] = _156;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _192;
    _192 = 0;
    int _195;
    for (;;)
    {
        _195 = _86 - 3;
        if (_192 < _195)
        {
            int _199 = _192 + 3;
            int2 _202 = _96 + int2(0, 8 * _199);
            float3 _204;
            _204 = float3(0.0);
            for (int _207 = -10; _207 < 11; )
            {
                int2 _212 = _202 + int2(_207, 0);
                _212.x = clamp(_212.x, 0, cbBLUR._imageSize.x - 1);
                _204 += (r_input_src.read(uint2(uint2(clamp(_212, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _68[abs(_207)]);
                _207++;
                continue;
            }
            int2 _231 = _79 + int2(0, 8 * (_199 & 7));
            OutputCache[uint(_231.x + (_231.y * 8))] = _204;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _240 = _96 + int2(0, 8 * _192);
            float3 _242;
            _242 = float3(0.0);
            for (int _245 = -10; _245 < 11; )
            {
                int2 _252 = clamp(_240 + int2(0, _245), int2(0), cbBLUR._imageSize - int2(1));
                int _253 = _252.y;
                int2 _263 = int2(_89, _253 & 7) + int2(0, 8 * ((int(float(_253) * 0.125) - _93) & 7));
                _242 += (OutputCache[uint(_263.x + (_263.y * 8))] * _68[abs(_245)]);
                _245++;
                continue;
            }
            bool _281;
            if (all(_240 >= int2(0)))
            {
                _281 = all(_240 < cbBLUR._imageSize);
            }
            else
            {
                _281 = false;
            }
            if (_281)
            {
                rw_output.write(float4(_242, 1.0), uint2(uint2(_240)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _192++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _291 = _192; _291 < _86; _291++)
    {
        int _297 = 8 * _291;
        int2 _299 = _96 + int2(0, _297);
        if (_291 >= _195)
        {
            int _303 = _291 + 3;
            int2 _306 = _96 + int2(0, 8 * _303);
            float3 _308;
            _308 = float3(0.0);
            for (int _311 = -10; _311 < 11; )
            {
                int2 _316 = _306 + int2(_311, 0);
                _316.x = clamp(_316.x, 0, cbBLUR._imageSize.x - 1);
                _308 += (r_input_src.read(uint2(uint2(clamp(_316, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _68[abs(_311)]);
                _311++;
                continue;
            }
            int2 _335 = _79 + int2(0, 8 * (_303 & 7));
            OutputCache[uint(_335.x + (_335.y * 8))] = _308;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _343;
        _343 = float3(0.0);
        for (int _346 = -10; _346 < 11; )
        {
            int2 _353 = clamp(_299 + int2(0, _346), int2(0), cbBLUR._imageSize - int2(1));
            int _354 = _353.y;
            int2 _364 = int2(_89, _354 & 7) + int2(0, 8 * ((int(float(_354) * 0.125) - _93) & 7));
            _343 += (OutputCache[uint(_364.x + (_364.y * 8))] * _68[abs(_346)]);
            _346++;
            continue;
        }
        bool _382;
        if (all(_299 >= int2(0)))
        {
            _382 = all(_299 < cbBLUR._imageSize);
        }
        else
        {
            _382 = false;
        }
        if (_382)
        {
            rw_output.write(float4(_343, 1.0), uint2(uint2(_299)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings28[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source28=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 11> _68 = spvUnsafeArray<float, 11>({ 0.1417508423328399658203125, 0.1330826282501220703125, 0.11013065278530120849609375, 0.080331273376941680908203125, 0.0516473911702632904052734375, 0.0292682088911533355712890625, 0.014619206078350543975830078125, 0.00643615238368511199951171875, 0.0024974565021693706512451171875, 0.0008541456772945821285247802734375, 0.00025746668688952922821044921875 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _79 = int2(gl_LocalInvocationID.xy);
    int2 _81 = int2(gl_WorkGroupID.xy);
    int _86 = (cbBLUR._imageSize.y + 63) / 64;
    int _89 = _79.x;
    int _92 = _81.y;
    int _93 = _92 * _86;
    int2 _96 = int2((_81.x * 8) + _89, _79.y + (_93 * 8));
    for (int _98 = 0; _98 < 3; _98++)
    {
        int2 _106 = _96 + int2(0, 8 * _98);
        float3 _108;
        _108 = float3(0.0);
        for (int _111 = -10; _111 < 11; )
        {
            int2 _116 = _106 + int2(_111, 0);
            _116.x = clamp(_116.x, 0, cbBLUR._imageSize.x - 1);
            _108 += (r_input_src.read(uint2(uint2(clamp(_116, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _68[abs(_111)]);
            _111++;
            continue;
        }
        int2 _135 = _79 + int2(0, 8 * (_98 & 7));
        OutputCache[uint(_135.x + (_135.y * 8))] = _108;
    }
    if (_92 != 0)
    {
        for (int _146 = 1; _146 < 6; _146++)
        {
            int2 _154 = _96 - int2(0, 8 * _146);
            float3 _156;
            _156 = float3(0.0);
            for (int _159 = -10; _159 < 11; )
            {
                int2 _164 = _154 + int2(_159, 0);
                _164.x = clamp(_164.x, 0, cbBLUR._imageSize.x - 1);
                _156 += (r_input_src.read(uint2(uint2(clamp(_164, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _68[abs(_159)]);
                _159++;
                continue;
            }
            int2 _184 = _79 + int2(0, 8 * ((8 - _146) & 7));
            OutputCache[uint(_184.x + (_184.y * 8))] = _156;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _192;
    _192 = 0;
    int _195;
    for (;;)
    {
        _195 = _86 - 3;
        if (_192 < _195)
        {
            int _199 = _192 + 3;
            int2 _202 = _96 + int2(0, 8 * _199);
            float3 _204;
            _204 = float3(0.0);
            for (int _207 = -10; _207 < 11; )
            {
                int2 _212 = _202 + int2(_207, 0);
                _212.x = clamp(_212.x, 0, cbBLUR._imageSize.x - 1);
                _204 += (r_input_src.read(uint2(uint2(clamp(_212, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _68[abs(_207)]);
                _207++;
                continue;
            }
            int2 _231 = _79 + int2(0, 8 * (_199 & 7));
            OutputCache[uint(_231.x + (_231.y * 8))] = _204;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _240 = _96 + int2(0, 8 * _192);
            float3 _242;
            _242 = float3(0.0);
            for (int _245 = -10; _245 < 11; )
            {
                int2 _252 = clamp(_240 + int2(0, _245), int2(0), cbBLUR._imageSize - int2(1));
                int _253 = _252.y;
                int2 _263 = int2(_89, _253 & 7) + int2(0, 8 * ((int(float(_253) * 0.125) - _93) & 7));
                _242 += (OutputCache[uint(_263.x + (_263.y * 8))] * _68[abs(_245)]);
                _245++;
                continue;
            }
            bool _281;
            if (all(_240 >= int2(0)))
            {
                _281 = all(_240 < cbBLUR._imageSize);
            }
            else
            {
                _281 = false;
            }
            if (_281)
            {
                rw_output.write(float4(_242, 1.0), uint2(uint2(_240)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _192++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _291 = _192; _291 < _86; _291++)
    {
        int _297 = 8 * _291;
        int2 _299 = _96 + int2(0, _297);
        if (_291 >= _195)
        {
            int _303 = _291 + 3;
            int2 _306 = _96 + int2(0, 8 * _303);
            float3 _308;
            _308 = float3(0.0);
            for (int _311 = -10; _311 < 11; )
            {
                int2 _316 = _306 + int2(_311, 0);
                _316.x = clamp(_316.x, 0, cbBLUR._imageSize.x - 1);
                _308 += (r_input_src.read(uint2(uint2(clamp(_316, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _68[abs(_311)]);
                _311++;
                continue;
            }
            int2 _335 = _79 + int2(0, 8 * (_303 & 7));
            OutputCache[uint(_335.x + (_335.y * 8))] = _308;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _343;
        _343 = float3(0.0);
        for (int _346 = -10; _346 < 11; )
        {
            int2 _353 = clamp(_299 + int2(0, _346), int2(0), cbBLUR._imageSize - int2(1));
            int _354 = _353.y;
            int2 _364 = int2(_89, _354 & 7) + int2(0, 8 * ((int(float(_354) * 0.125) - _93) & 7));
            _343 += (OutputCache[uint(_364.x + (_364.y * 8))] * _68[abs(_346)]);
            _346++;
            continue;
        }
        bool _382;
        if (all(_299 >= int2(0)))
        {
            _382 = all(_299 < cbBLUR._imageSize);
        }
        else
        {
            _382 = false;
        }
        if (_382)
        {
            rw_output.write(float4(_343, 1.0), uint2(uint2(_299)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Binding bindings29[]={{"cbBLUR","buffer",0},{"r_input_src","texture",0},{"rw_output","texture",1}};
inline constexpr const char*source29=R"FFX_IMAGE(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

struct type_cbBLUR
{
    int2 _imageSize;
};

constant spvUnsafeArray<float, 11> _68 = spvUnsafeArray<float, 11>({ 0.1003459393978118896484375, 0.097274415194988250732421875, 0.088612519204616546630859375, 0.075855858623981475830078125, 0.0610211789608001708984375, 0.0461284928023815155029296875, 0.032768376171588897705078125, 0.0218744575977325439453125, 0.013721955008804798126220703125, 0.008088921196758747100830078125, 0.004480852745473384857177734375 });

kernel void CS(constant type_cbBLUR& cbBLUR [[buffer(0)]], texture2d<float> r_input_src [[texture(0)]], texture2d<float, access::write> rw_output [[texture(1)]], uint3 gl_LocalInvocationID [[thread_position_in_threadgroup]], uint3 gl_WorkGroupID [[threadgroup_position_in_grid]])
{
    threadgroup spvUnsafeArray<float3, 512> OutputCache;
    int2 _79 = int2(gl_LocalInvocationID.xy);
    int2 _81 = int2(gl_WorkGroupID.xy);
    int _86 = (cbBLUR._imageSize.y + 63) / 64;
    int _89 = _79.x;
    int _92 = _81.y;
    int _93 = _92 * _86;
    int2 _96 = int2((_81.x * 8) + _89, _79.y + (_93 * 8));
    for (int _98 = 0; _98 < 3; _98++)
    {
        int2 _106 = _96 + int2(0, 8 * _98);
        float3 _108;
        _108 = float3(0.0);
        for (int _111 = -10; _111 < 11; )
        {
            int2 _116 = _106 + int2(_111, 0);
            _116.x = clamp(_116.x, 0, cbBLUR._imageSize.x - 1);
            _108 += (r_input_src.read(uint2(uint2(clamp(_116, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _68[abs(_111)]);
            _111++;
            continue;
        }
        int2 _135 = _79 + int2(0, 8 * (_98 & 7));
        OutputCache[uint(_135.x + (_135.y * 8))] = _108;
    }
    if (_92 != 0)
    {
        for (int _146 = 1; _146 < 6; _146++)
        {
            int2 _154 = _96 - int2(0, 8 * _146);
            float3 _156;
            _156 = float3(0.0);
            for (int _159 = -10; _159 < 11; )
            {
                int2 _164 = _154 + int2(_159, 0);
                _164.x = clamp(_164.x, 0, cbBLUR._imageSize.x - 1);
                _156 += (r_input_src.read(uint2(uint2(clamp(_164, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _68[abs(_159)]);
                _159++;
                continue;
            }
            int2 _184 = _79 + int2(0, 8 * ((8 - _146) & 7));
            OutputCache[uint(_184.x + (_184.y * 8))] = _156;
        }
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    int _192;
    _192 = 0;
    int _195;
    for (;;)
    {
        _195 = _86 - 3;
        if (_192 < _195)
        {
            int _199 = _192 + 3;
            int2 _202 = _96 + int2(0, 8 * _199);
            float3 _204;
            _204 = float3(0.0);
            for (int _207 = -10; _207 < 11; )
            {
                int2 _212 = _202 + int2(_207, 0);
                _212.x = clamp(_212.x, 0, cbBLUR._imageSize.x - 1);
                _204 += (r_input_src.read(uint2(uint2(clamp(_212, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _68[abs(_207)]);
                _207++;
                continue;
            }
            int2 _231 = _79 + int2(0, 8 * (_199 & 7));
            OutputCache[uint(_231.x + (_231.y * 8))] = _204;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            int2 _240 = _96 + int2(0, 8 * _192);
            float3 _242;
            _242 = float3(0.0);
            for (int _245 = -10; _245 < 11; )
            {
                int2 _252 = clamp(_240 + int2(0, _245), int2(0), cbBLUR._imageSize - int2(1));
                int _253 = _252.y;
                int2 _263 = int2(_89, _253 & 7) + int2(0, 8 * ((int(float(_253) * 0.125) - _93) & 7));
                _242 += (OutputCache[uint(_263.x + (_263.y * 8))] * _68[abs(_245)]);
                _245++;
                continue;
            }
            bool _281;
            if (all(_240 >= int2(0)))
            {
                _281 = all(_240 < cbBLUR._imageSize);
            }
            else
            {
                _281 = false;
            }
            if (_281)
            {
                rw_output.write(float4(_242, 1.0), uint2(uint2(_240)));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);
            _192++;
            continue;
        }
        else
        {
            break;
        }
    }
    for (int _291 = _192; _291 < _86; _291++)
    {
        int _297 = 8 * _291;
        int2 _299 = _96 + int2(0, _297);
        if (_291 >= _195)
        {
            int _303 = _291 + 3;
            int2 _306 = _96 + int2(0, 8 * _303);
            float3 _308;
            _308 = float3(0.0);
            for (int _311 = -10; _311 < 11; )
            {
                int2 _316 = _306 + int2(_311, 0);
                _316.x = clamp(_316.x, 0, cbBLUR._imageSize.x - 1);
                _308 += (r_input_src.read(uint2(uint2(clamp(_316, int2(0), cbBLUR._imageSize - int2(1)))), 0u).xyz * _68[abs(_311)]);
                _311++;
                continue;
            }
            int2 _335 = _79 + int2(0, 8 * (_303 & 7));
            OutputCache[uint(_335.x + (_335.y * 8))] = _308;
            threadgroup_barrier(mem_flags::mem_threadgroup);
        }
        float3 _343;
        _343 = float3(0.0);
        for (int _346 = -10; _346 < 11; )
        {
            int2 _353 = clamp(_299 + int2(0, _346), int2(0), cbBLUR._imageSize - int2(1));
            int _354 = _353.y;
            int2 _364 = int2(_89, _354 & 7) + int2(0, 8 * ((int(float(_354) * 0.125) - _93) & 7));
            _343 += (OutputCache[uint(_364.x + (_364.y * 8))] * _68[abs(_346)]);
            _346++;
            continue;
        }
        bool _382;
        if (all(_299 >= int2(0)))
        {
            _382 = all(_299 < cbBLUR._imageSize);
        }
        else
        {
            _382 = false;
        }
        if (_382)
        {
            rw_output.write(float4(_343, 1.0), uint2(uint2(_299)));
        }
    }
}

)FFX_IMAGE";
inline constexpr Shader shaders[]={{"3-0","CS",source0,bindings0,sizeof(bindings0)/sizeof(Binding),3,0,8,8,1},{"3-1","CS",source1,bindings1,sizeof(bindings1)/sizeof(Binding),3,1,8,8,1},{"3-2","CS",source2,bindings2,sizeof(bindings2)/sizeof(Binding),3,2,8,8,1},{"5-0","CS",source3,bindings3,sizeof(bindings3)/sizeof(Binding),5,0,8,8,1},{"5-1","CS",source4,bindings4,sizeof(bindings4)/sizeof(Binding),5,1,8,8,1},{"5-2","CS",source5,bindings5,sizeof(bindings5)/sizeof(Binding),5,2,8,8,1},{"7-0","CS",source6,bindings6,sizeof(bindings6)/sizeof(Binding),7,0,8,8,1},{"7-1","CS",source7,bindings7,sizeof(bindings7)/sizeof(Binding),7,1,8,8,1},{"7-2","CS",source8,bindings8,sizeof(bindings8)/sizeof(Binding),7,2,8,8,1},{"9-0","CS",source9,bindings9,sizeof(bindings9)/sizeof(Binding),9,0,8,8,1},{"9-1","CS",source10,bindings10,sizeof(bindings10)/sizeof(Binding),9,1,8,8,1},{"9-2","CS",source11,bindings11,sizeof(bindings11)/sizeof(Binding),9,2,8,8,1},{"11-0","CS",source12,bindings12,sizeof(bindings12)/sizeof(Binding),11,0,8,8,1},{"11-1","CS",source13,bindings13,sizeof(bindings13)/sizeof(Binding),11,1,8,8,1},{"11-2","CS",source14,bindings14,sizeof(bindings14)/sizeof(Binding),11,2,8,8,1},{"13-0","CS",source15,bindings15,sizeof(bindings15)/sizeof(Binding),13,0,8,8,1},{"13-1","CS",source16,bindings16,sizeof(bindings16)/sizeof(Binding),13,1,8,8,1},{"13-2","CS",source17,bindings17,sizeof(bindings17)/sizeof(Binding),13,2,8,8,1},{"15-0","CS",source18,bindings18,sizeof(bindings18)/sizeof(Binding),15,0,8,8,1},{"15-1","CS",source19,bindings19,sizeof(bindings19)/sizeof(Binding),15,1,8,8,1},{"15-2","CS",source20,bindings20,sizeof(bindings20)/sizeof(Binding),15,2,8,8,1},{"17-0","CS",source21,bindings21,sizeof(bindings21)/sizeof(Binding),17,0,8,8,1},{"17-1","CS",source22,bindings22,sizeof(bindings22)/sizeof(Binding),17,1,8,8,1},{"17-2","CS",source23,bindings23,sizeof(bindings23)/sizeof(Binding),17,2,8,8,1},{"19-0","CS",source24,bindings24,sizeof(bindings24)/sizeof(Binding),19,0,8,8,1},{"19-1","CS",source25,bindings25,sizeof(bindings25)/sizeof(Binding),19,1,8,8,1},{"19-2","CS",source26,bindings26,sizeof(bindings26)/sizeof(Binding),19,2,8,8,1},{"21-0","CS",source27,bindings27,sizeof(bindings27)/sizeof(Binding),21,0,8,8,1},{"21-1","CS",source28,bindings28,sizeof(bindings28)/sizeof(Binding),21,1,8,8,1},{"21-2","CS",source29,bindings29,sizeof(bindings29)/sizeof(Binding),21,2,8,8,1}};
}
