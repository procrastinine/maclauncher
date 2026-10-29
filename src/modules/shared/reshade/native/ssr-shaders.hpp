// Original Godot 4.4 SSR kernels. MIT; see ssr-MIT.txt.
#pragma once
#include <cstddef>
namespace macfx::ssr_shaders {
struct Binding{const char*name;const char*kind;unsigned index;};
struct Shader{const char*name;const char*entry;const char*source;const Binding*bindings;size_t count;unsigned x,y,z;};
inline constexpr Binding bindings0[]={{"params","buffer",0},{"dest_ssr","texture",0},{"dest_depth","texture",1},{"dest_normal","texture",2},{"source_ssr","texture",3},{"source_depth","texture",4},{"source_normal","texture",5},{"source_ssrSmplr","sampler",0},{"source_depthSmplr","sampler",1},{"source_normalSmplr","sampler",2}};
inline constexpr const char*source0=R"SSR_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct Params
{
    int2 screen_size;
    float camera_z_near;
    float camera_z_far;
    uint orthogonal;
    uint filtered;
    uint pad[2];
};

constant bool sc_multiview_tmp [[function_constant(0)]];
constant bool sc_multiview = is_function_constant_defined(sc_multiview_tmp) ? sc_multiview_tmp : false;
constant bool _258 = (!sc_multiview);
constant uint3 gl_WorkGroupSize [[maybe_unused]] = uint3(8u, 8u, 1u);
constant float _416 = {};

kernel void main0(constant Params& params [[buffer(0)]], texture2d<float, access::write> dest_ssr [[texture(0)]], texture2d<float, access::write> dest_depth [[texture(1)]], texture2d<float, access::write> dest_normal [[texture(2)]], texture2d<float> source_ssr [[texture(3)]], texture2d<float> source_depth [[texture(4)]], texture2d<float> source_normal [[texture(5)]], sampler source_ssrSmplr [[sampler(0)]], sampler source_depthSmplr [[sampler(1)]], sampler source_normalSmplr [[sampler(2)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    do
    {
        int2 _18 = int2(gl_GlobalInvocationID.xy);
        if (any(_18 >= params.screen_size))
        {
            break;
        }
        float4 _367;
        float _370;
        float4 _372;
        if (params.filtered != 0u)
        {
            float4 _364;
            float _365;
            float4 _366;
            _366 = float4(0.0);
            _365 = 0.0;
            _364 = float4(0.0);
            float4 _97;
            float4 _415;
            float _397;
            for (int _363 = 0; _363 < 4; _366 = _415, _365 = _397, _364 = _97, _363++)
            {
                int2 _67 = _18 << int2(1);
                int2 _376;
                if ((_363 & 1) != int(0u))
                {
                    int2 _336 = _67;
                    _336.x = _67.x + 1;
                    _376 = _336;
                }
                else
                {
                    _376 = _67;
                }
                int2 _377;
                if ((_363 & 2) != int(0u))
                {
                    int2 _339 = _376;
                    _339.y = _376.y + 1;
                    _377 = _339;
                }
                else
                {
                    _377 = _376;
                }
                _97 = _364 + source_ssr.read(uint2(_377), 0);
                float4 _103 = source_depth.read(uint2(_377), 0);
                float _104 = _103.x;
                float _382;
                if (_366.w > 0.5)
                {
                    _382 = 1.0 - _366.w;
                }
                else
                {
                    _382 = _366.w;
                }
                _415 = float4(_366.xyz + fast::normalize((source_normal.read(uint2(_377), 0).xyz * 2.0) - float3(1.0)), _366.w + (_382 * 2.007874011993408203125));
                if (sc_multiview)
                {
                    _397 = _365 + _104;
                }
                else
                {
                    float _157 = (_104 * 2.0) - 1.0;
                    float _385;
                    if (params.orthogonal != 0u)
                    {
                        float _175 = params.camera_z_far - params.camera_z_near;
                        _385 = ((_157 + ((params.camera_z_far + params.camera_z_near) / _175)) * _175) * 0.5;
                    }
                    else
                    {
                        _385 = ((2.0 * params.camera_z_near) * params.camera_z_far) / ((params.camera_z_far + params.camera_z_near) - (_157 * (params.camera_z_far - params.camera_z_near)));
                    }
                    _397 = _365 - _385;
                }
            }
            float4 _412 = float4((fast::normalize(_366.xyz * float3(0.25)) * 0.5) + float3(0.5), _416);
            _412.w = _366.w * 0.124509803950786590576171875;
            _372 = _412;
            _370 = _365 * 0.25;
            _367 = _364 * float4(0.25);
        }
        else
        {
            int2 _244 = _18 << int2(1);
            float4 _252 = source_depth.read(uint2(_244), 0);
            float _253 = _252.x;
            float _371;
            if (_258)
            {
                float _263 = (_253 * 2.0) - 1.0;
                float _362;
                if (params.orthogonal != 0u)
                {
                    _362 = ((_263 * (params.camera_z_far - params.camera_z_near)) - (params.camera_z_far + params.camera_z_near)) * (-0.5);
                }
                else
                {
                    _362 = ((2.0 * params.camera_z_near) * params.camera_z_far) / ((params.camera_z_far + params.camera_z_near) + (_263 * (params.camera_z_far - params.camera_z_near)));
                }
                _371 = -_362;
            }
            else
            {
                _371 = _253;
            }
            _372 = source_normal.read(uint2(_244), 0);
            _370 = _371;
            _367 = source_ssr.read(uint2(_244), 0);
        }
        dest_ssr.write(_367, uint2(_18));
        dest_depth.write(float4(_370), uint2(_18));
        dest_normal.write(_372, uint2(_18));
        break;
    } while(false);
}

)SSR_GPU";
inline constexpr Binding bindings1[]={{"scene_data","buffer",0},{"params","buffer",1},{"source_depth","texture",0},{"source_normal_roughness","texture",1},{"ssr_image","texture",2},{"source_diffuse","texture",3},{"source_metallic","texture",4},{"source_metallicSmplr","sampler",0}};
inline constexpr const char*source1=R"SSR_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

constant bool sc_multiview_tmp [[function_constant(0)]];
constant bool sc_multiview = is_function_constant_defined(sc_multiview_tmp) ? sc_multiview_tmp : false;

struct Params
{
    float4 proj_info;
    int2 screen_size;
    float camera_z_near;
    float camera_z_far;
    int num_steps;
    float depth_tolerance;
    float distance_fade;
    float curve_fade_in;
    uint orthogonal;
    float filter_mipmap_levels;
    uint use_half_res;
    uint view_index;
};

struct SceneData
{
    float4x4 projection[2];
    float4x4 inv_projection[2];
    float4 eye_offset[2];
};

constant uint3 gl_WorkGroupSize [[maybe_unused]] = uint3(8u, 8u, 1u);
constant float4 _1136 = {};

kernel void main0(constant SceneData& scene_data [[buffer(0)]], constant Params& params [[buffer(1)]], texture2d<float> source_depth [[texture(0)]], texture2d<float> source_normal_roughness [[texture(1)]], texture2d<float, access::write> ssr_image [[texture(2)]], texture2d<float> source_diffuse [[texture(3)]], texture2d<float> source_metallic [[texture(4)]], sampler source_metallicSmplr [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    do
    {
        int2 _181 = int2(gl_GlobalInvocationID.xy);
        if (any(_181 >= params.screen_size))
        {
            break;
        }
        float2 _194 = float2(params.screen_size);
        float2 _196 = float2(1.0) / _194;
        float4 _212 = source_depth.read(uint2(_181));
        float _213 = _212.x;
        float2 _219 = ((float2(_181) * _196) + (_196 * 0.5)) * _194;
        float3 _1048;
        do
        {
            if (sc_multiview)
            {
                float4 _851 = scene_data.inv_projection[params.view_index] * float4(((_219 * 2.0) / _194) - float2(1.0), (_213 * 2.0) - 1.0, 1.0);
                float3 _857 = _851.xyz / float3(_851.w);
                float4 _991;
                _991.x = _857.x;
                _991.y = _857.y;
                _991.z = _857.z;
                _1048 = _991.xyz;
                break;
            }
            else
            {
                if (params.orthogonal != 0u)
                {
                    _1048 = float3(-((_219 * params.proj_info.xy) + params.proj_info.zw), _213);
                    break;
                }
                else
                {
                    _1048 = float3(((_219 * params.proj_info.xy) + params.proj_info.zw) * _213, _213);
                    break;
                }
                break; // unreachable workaround
            }
            break; // unreachable workaround
        } while(false);
        float4 _230 = source_normal_roughness.read(uint2(_181));
        float _240 = _230.w;
        float _1049;
        if (_240 > 0.5)
        {
            _1049 = 1.0 - _240;
        }
        else
        {
            _1049 = _240;
        }
        float _249 = _1049 * 2.007874011993408203125;
        if (_249 > 0.60000002384185791015625)
        {
            ssr_image.write(float4(0.0), uint2(_181));
            break;
        }
        float3 _264 = fast::normalize(fast::normalize((_230.xyz * 2.0) - float3(1.0)));
        _264.y = -_264.y;
        float3 _1052;
        if (sc_multiview)
        {
            _1052 = fast::normalize(_1048 + scene_data.eye_offset[params.view_index].xyz);
        }
        else
        {
            float3 _1051;
            if (params.orthogonal != 0u)
            {
                _1051 = float3(0.0, 0.0, -1.0);
            }
            else
            {
                _1051 = fast::normalize(_1048);
            }
            _1052 = _1051;
        }
        float3 _299 = fast::normalize(reflect(_1052, _264));
        if (dot(_299, _264) < 0.001000000047497451305389404296875)
        {
            ssr_image.write(float4(0.0), uint2(_181));
            break;
        }
        float _314 = _299.z;
        float _323 = -params.camera_z_near;
        float _1055;
        if ((_1048.z + (_314 * params.camera_z_far)) > _323)
        {
            _1055 = (_323 - _1048.z) / _314;
        }
        else
        {
            _1055 = params.camera_z_far;
        }
        float3 _346 = _1048 + (_299 * _1055);
        float4 _917 = scene_data.projection[params.view_index] * float4(_1048, 1.0);
        float _919 = _917.w;
        float3 _923 = _917.xyz / float3(_919);
        float4 _1006;
        _1006.x = _923.x;
        _1006.y = _923.y;
        float2 _934 = (_1006.xy * 0.5) + float2(0.5);
        float _936 = _934.x;
        float4 _1012;
        _1012.x = _936;
        float _938 = _934.y;
        _1012.y = _938;
        float4 _955 = scene_data.projection[params.view_index] * float4(_346, 1.0);
        float _957 = _955.w;
        float3 _961 = _955.xyz / float3(_957);
        float4 _1018;
        _1018.x = _961.x;
        _1018.y = _961.y;
        float2 _972 = (_1018.xy * 0.5) + float2(0.5);
        float4 _1024;
        _1024.x = _972.x;
        _1024.y = _972.y;
        float2 _364 = _1024.xy - _1012.xy;
        float _366 = 1.0 / _919;
        float _368 = 1.0 / _957;
        float _373 = _1048.z * _366;
        float2 _382 = _1012.xy / _196;
        float _403 = _364.x;
        float _413 = _364.y;
        float _444 = fast::min(fast::min(1.0, (0.9900000095367431640625 * (1.0 - _936)) / fast::max(9.9999997473787516355514526367188e-06, _403)), fast::min(1.0, (0.9900000095367431640625 * (1.0 - _938)) / fast::max(9.9999997473787516355514526367188e-06, _413))) * fast::min(fast::min(1.0, (0.9900000095367431640625 * _936) / fast::max(9.9999997473787516355514526367188e-06, -_403)), fast::min(1.0, (0.9900000095367431640625 * _938) / fast::max(9.9999997473787516355514526367188e-06, -_413)));
        float2 _447 = (_364 / _196) * _444;
        float2 _456 = fast::normalize(_447);
        float _460 = 1.0 / length(_447);
        float _477 = 1.0 / fast::max(abs(_456.x), abs(_456.y));
        float2 _480 = _456 * _477;
        float _483 = ((((_346.z * _368) - _373) * _444) * _460) * _477;
        float _486 = (((_368 - _366) * _444) * _460) * _477;
        float2 _503 = _382 + _480;
        bool _509 = all(int2(_503 - float2(0.5)) == _181);
        float _1060;
        float _1062;
        if (_509)
        {
            _1062 = _366 + _486;
            _1060 = _373 + _483;
        }
        else
        {
            _1062 = _366;
            _1060 = _373;
        }
        float2 _1057;
        float _1071;
        _1071 = 0.0;
        _1057 = select(_382, _503, bool2(_509));
        float2 _540;
        float _543;
        float _546;
        float _587;
        float _639;
        bool _1074;
        float2 _1080;
        int _1056 = 0;
        float _1059 = _1060;
        float _1061 = _1062;
        float _1064 = _1048.z;
        int _536;
        for (;;)
        {
            _536 = params.num_steps;
            if (_1056 < _536)
            {
                _540 = _1057 + _480;
                _543 = _1059 + _483;
                _546 = _1061 + _486;
                int2 _551 = int2(_540 - float2(0.5));
                float4 _555 = source_depth.read(uint2(_551));
                float _556 = _555.x;
                float _1068;
                if (sc_multiview)
                {
                    _1068 = -(((2.0 * params.camera_z_near) * params.camera_z_far) / ((params.camera_z_far + params.camera_z_near) - (((_556 * 2.0) - 1.0) * (params.camera_z_far - params.camera_z_near))));
                }
                else
                {
                    _1068 = _556;
                }
                _587 = _543 / _546;
                if (_1068 > _587)
                {
                    float3 _604 = fast::normalize((source_normal_roughness.read(uint2(_551)).xyz * 2.0) - float3(1.0));
                    _604.y = -_604.y;
                    if (dot(_299, _604) < 0.001000000047497451305389404296875)
                    {
                        bool _623 = _1068 <= (fast::max(_587, _1064) + params.depth_tolerance);
                        bool _633;
                        if (_623)
                        {
                            _633 = (-_1068) < (params.camera_z_far * 0.949999988079071044921875);
                        }
                        else
                        {
                            _633 = _623;
                        }
                        _1080 = _540;
                        _1074 = _633;
                        break;
                    }
                }
                _639 = _1071 + 1.0;
                _1071 = _639;
                _1064 = _587;
                _1061 = _546;
                _1059 = _543;
                _1057 = _540;
                _1056++;
                continue;
            }
            else
            {
                _1080 = _1057;
                _1074 = false;
                break;
            }
        }
        if (_1074)
        {
            float _655 = float(params.screen_size.x + params.screen_size.y);
            if (any(bool4(_1080 < float2(0.0), _1080 > _194)))
            {
                ssr_image.write(float4(0.0), uint2(_181));
                break;
            }
            float2 _692 = select(_194 - _1080, _1080, _1080 < (_194 * 0.5));
            float _710 = (_1071 + 1.0) / float(_536);
            float _1087;
            if (params.curve_fade_in == 0.0)
            {
                _1087 = 1.0;
            }
            else
            {
                _1087 = powr(fast::clamp(_710, 0.0, 1.0), params.curve_fade_in);
            }
            float _735 = powr(fast::clamp(1.0 - _710, 0.0, 1.0), params.distance_fade) * _1087;
            float _762 = mix(0.039999999105930328369140625, 1.0, source_metallic.read(uint2((_181 << int2(1))), 0).w);
            float _769 = fast::clamp(1.0 - dot(_264, -_1052), 0.0, 1.0);
            float _773 = _769 * _769;
            ssr_image.write(float4(source_diffuse.read(uint2(int2(_1080 - float2(0.5)))).xyz * (_762 + ((1.0 - _762) * ((_773 * _773) * _769))), (((_735 > 0.999000012874603271484375) ? 1.0 : _735) * smoothstep(0.0, 0.00250000017695128917694091796875 * (_655 * _655), _692.x * _692.y)) * smoothstep(0.4000000059604644775390625, 0.699999988079071044921875, 1.0 - _249)), uint2(_181));
        }
        else
        {
            ssr_image.write(float4(0.0), uint2(_181));
        }
        break;
    } while(false);
}

)SSR_GPU";
inline constexpr Binding bindings2[]={{"scene_data","buffer",0},{"params","buffer",1},{"source_depth","texture",0},{"source_normal_roughness","texture",1},{"blur_radius_image","texture",2},{"ssr_image","texture",3},{"source_diffuse","texture",4},{"source_metallic","texture",5},{"source_metallicSmplr","sampler",0}};
inline constexpr const char*source2=R"SSR_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

constant bool sc_multiview_tmp [[function_constant(0)]];
constant bool sc_multiview = is_function_constant_defined(sc_multiview_tmp) ? sc_multiview_tmp : false;

struct Params
{
    float4 proj_info;
    int2 screen_size;
    float camera_z_near;
    float camera_z_far;
    int num_steps;
    float depth_tolerance;
    float distance_fade;
    float curve_fade_in;
    uint orthogonal;
    float filter_mipmap_levels;
    uint use_half_res;
    uint view_index;
};

struct SceneData
{
    float4x4 projection[2];
    float4x4 inv_projection[2];
    float4 eye_offset[2];
};

constant uint3 gl_WorkGroupSize [[maybe_unused]] = uint3(8u, 8u, 1u);
constant float4 _1199 = {};

kernel void main0(constant SceneData& scene_data [[buffer(0)]], constant Params& params [[buffer(1)]], texture2d<float> source_depth [[texture(0)]], texture2d<float> source_normal_roughness [[texture(1)]], texture2d<float, access::write> blur_radius_image [[texture(2)]], texture2d<float, access::write> ssr_image [[texture(3)]], texture2d<float> source_diffuse [[texture(4)]], texture2d<float> source_metallic [[texture(5)]], sampler source_metallicSmplr [[sampler(0)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    do
    {
        int2 _181 = int2(gl_GlobalInvocationID.xy);
        if (any(_181 >= params.screen_size))
        {
            break;
        }
        float2 _194 = float2(params.screen_size);
        float2 _196 = float2(1.0) / _194;
        float4 _212 = source_depth.read(uint2(_181));
        float _213 = _212.x;
        float2 _219 = ((float2(_181) * _196) + (_196 * 0.5)) * _194;
        float3 _1108;
        do
        {
            if (sc_multiview)
            {
                float4 _911 = scene_data.inv_projection[params.view_index] * float4(((_219 * 2.0) / _194) - float2(1.0), (_213 * 2.0) - 1.0, 1.0);
                float3 _917 = _911.xyz / float3(_911.w);
                float4 _1051;
                _1051.x = _917.x;
                _1051.y = _917.y;
                _1051.z = _917.z;
                _1108 = _1051.xyz;
                break;
            }
            else
            {
                if (params.orthogonal != 0u)
                {
                    _1108 = float3(-((_219 * params.proj_info.xy) + params.proj_info.zw), _213);
                    break;
                }
                else
                {
                    _1108 = float3(((_219 * params.proj_info.xy) + params.proj_info.zw) * _213, _213);
                    break;
                }
                break; // unreachable workaround
            }
            break; // unreachable workaround
        } while(false);
        float4 _230 = source_normal_roughness.read(uint2(_181));
        float _240 = _230.w;
        float _1109;
        if (_240 > 0.5)
        {
            _1109 = 1.0 - _240;
        }
        else
        {
            _1109 = _240;
        }
        float _249 = _1109 * 2.007874011993408203125;
        if (_249 > 0.60000002384185791015625)
        {
            blur_radius_image.write(float4(0.0), uint2(_181));
            ssr_image.write(float4(0.0), uint2(_181));
            break;
        }
        float3 _269 = fast::normalize(fast::normalize((_230.xyz * 2.0) - float3(1.0)));
        _269.y = -_269.y;
        float3 _1112;
        if (sc_multiview)
        {
            _1112 = fast::normalize(_1108 + scene_data.eye_offset[params.view_index].xyz);
        }
        else
        {
            float3 _1111;
            if (params.orthogonal != 0u)
            {
                _1111 = float3(0.0, 0.0, -1.0);
            }
            else
            {
                _1111 = fast::normalize(_1108);
            }
            _1112 = _1111;
        }
        float3 _304 = fast::normalize(reflect(_1112, _269));
        if (dot(_304, _269) < 0.001000000047497451305389404296875)
        {
            ssr_image.write(float4(0.0), uint2(_181));
            break;
        }
        float _319 = _304.z;
        float _328 = -params.camera_z_near;
        float _1115;
        if ((_1108.z + (_319 * params.camera_z_far)) > _328)
        {
            _1115 = (_328 - _1108.z) / _319;
        }
        else
        {
            _1115 = params.camera_z_far;
        }
        float3 _351 = _1108 + (_304 * _1115);
        float4 _977 = scene_data.projection[params.view_index] * float4(_1108, 1.0);
        float _979 = _977.w;
        float3 _983 = _977.xyz / float3(_979);
        float4 _1066;
        _1066.x = _983.x;
        _1066.y = _983.y;
        float2 _994 = (_1066.xy * 0.5) + float2(0.5);
        float _996 = _994.x;
        float4 _1072;
        _1072.x = _996;
        float _998 = _994.y;
        _1072.y = _998;
        float4 _1015 = scene_data.projection[params.view_index] * float4(_351, 1.0);
        float _1017 = _1015.w;
        float3 _1021 = _1015.xyz / float3(_1017);
        float4 _1078;
        _1078.x = _1021.x;
        _1078.y = _1021.y;
        float2 _1032 = (_1078.xy * 0.5) + float2(0.5);
        float4 _1084;
        _1084.x = _1032.x;
        _1084.y = _1032.y;
        float2 _369 = _1084.xy - _1072.xy;
        float _371 = 1.0 / _979;
        float _373 = 1.0 / _1017;
        float _378 = _1108.z * _371;
        float2 _387 = _1072.xy / _196;
        float _408 = _369.x;
        float _418 = _369.y;
        float _449 = fast::min(fast::min(1.0, (0.9900000095367431640625 * (1.0 - _996)) / fast::max(9.9999997473787516355514526367188e-06, _408)), fast::min(1.0, (0.9900000095367431640625 * (1.0 - _998)) / fast::max(9.9999997473787516355514526367188e-06, _418))) * fast::min(fast::min(1.0, (0.9900000095367431640625 * _996) / fast::max(9.9999997473787516355514526367188e-06, -_408)), fast::min(1.0, (0.9900000095367431640625 * _998) / fast::max(9.9999997473787516355514526367188e-06, -_418)));
        float2 _452 = (_369 / _196) * _449;
        float2 _461 = fast::normalize(_452);
        float _465 = 1.0 / length(_452);
        float _482 = 1.0 / fast::max(abs(_461.x), abs(_461.y));
        float2 _485 = _461 * _482;
        float _488 = ((((_351.z * _373) - _378) * _449) * _465) * _482;
        float _491 = (((_373 - _371) * _449) * _465) * _482;
        float2 _508 = _387 + _485;
        bool _514 = all(int2(_508 - float2(0.5)) == _181);
        float _1120;
        float _1122;
        if (_514)
        {
            _1122 = _371 + _491;
            _1120 = _378 + _488;
        }
        else
        {
            _1122 = _371;
            _1120 = _378;
        }
        float2 _1117;
        float _1131;
        _1131 = 0.0;
        _1117 = select(_387, _508, bool2(_514));
        float2 _545;
        float _548;
        float _551;
        float _592;
        float _644;
        bool _1134;
        float2 _1140;
        int _1116 = 0;
        float _1119 = _1120;
        float _1121 = _1122;
        float _1124 = _1108.z;
        int _541;
        for (;;)
        {
            _541 = params.num_steps;
            if (_1116 < _541)
            {
                _545 = _1117 + _485;
                _548 = _1119 + _488;
                _551 = _1121 + _491;
                int2 _556 = int2(_545 - float2(0.5));
                float4 _560 = source_depth.read(uint2(_556));
                float _561 = _560.x;
                float _1128;
                if (sc_multiview)
                {
                    _1128 = -(((2.0 * params.camera_z_near) * params.camera_z_far) / ((params.camera_z_far + params.camera_z_near) - (((_561 * 2.0) - 1.0) * (params.camera_z_far - params.camera_z_near))));
                }
                else
                {
                    _1128 = _561;
                }
                _592 = _548 / _551;
                if (_1128 > _592)
                {
                    float3 _609 = fast::normalize((source_normal_roughness.read(uint2(_556)).xyz * 2.0) - float3(1.0));
                    _609.y = -_609.y;
                    if (dot(_304, _609) < 0.001000000047497451305389404296875)
                    {
                        bool _628 = _1128 <= (fast::max(_592, _1124) + params.depth_tolerance);
                        bool _638;
                        if (_628)
                        {
                            _638 = (-_1128) < (params.camera_z_far * 0.949999988079071044921875);
                        }
                        else
                        {
                            _638 = _628;
                        }
                        _1140 = _545;
                        _1134 = _638;
                        break;
                    }
                }
                _644 = _1131 + 1.0;
                _1131 = _644;
                _1124 = _592;
                _1121 = _551;
                _1119 = _548;
                _1117 = _545;
                _1116++;
                continue;
            }
            else
            {
                _1140 = _1117;
                _1134 = false;
                break;
            }
        }
        if (_1134)
        {
            float _660 = float(params.screen_size.x + params.screen_size.y);
            if (any(bool4(_1140 < float2(0.0), _1140 > _194)))
            {
                ssr_image.write(float4(0.0), uint2(_181));
                break;
            }
            float2 _697 = select(_194 - _1140, _1140, _1140 < (_194 * 0.5));
            float _715 = (_1131 + 1.0) / float(_541);
            float _1147;
            if (params.curve_fade_in == 0.0)
            {
                _1147 = 1.0;
            }
            else
            {
                _1147 = powr(fast::clamp(_715, 0.0, 1.0), params.curve_fade_in);
            }
            float _740 = powr(fast::clamp(1.0 - _715, 0.0, 1.0), params.distance_fade) * _1147;
            float _767 = mix(0.039999999105930328369140625, 1.0, source_metallic.read(uint2((_181 << int2(1))), 0).w);
            float _774 = fast::clamp(1.0 - dot(_269, -_1112), 0.0, 1.0);
            float _778 = _774 * _774;
            ssr_image.write(float4(source_diffuse.read(uint2(int2(_1140 - float2(0.5)))).xyz * (_767 + ((1.0 - _767) * ((_778 * _778) * _774))), (((_740 > 0.999000012874603271484375) ? 1.0 : _740) * smoothstep(0.0, 0.00250000017695128917694091796875 * (_660 * _660), _697.x * _697.y)) * smoothstep(0.4000000059604644775390625, 0.699999988079071044921875, 1.0 - _249)), uint2(_181));
            float _1183;
            if (_249 > 0.001000000047497451305389404296875)
            {
                float _829 = length(_1140 - _387);
                float _835 = (2.0 * tan(fast::min(_249, 0.999000012874603271484375) * 1.57079637050628662109375)) * _829;
                float _847 = 4.0 * _829;
                _1183 = (_835 * (sqrt((_835 * _835) + (_847 * _829)) - _835)) / _847;
            }
            else
            {
                _1183 = 0.0;
            }
            blur_radius_image.write(float4(_1183 * 0.0039215688593685626983642578125), uint2(_181));
        }
        else
        {
            blur_radius_image.write(float4(0.0), uint2(_181));
            ssr_image.write(float4(0.0), uint2(_181));
        }
        break;
    } while(false);
}

)SSR_GPU";
inline constexpr Binding bindings3[]={{"scene_data","buffer",0},{"params","buffer",1},{"source_depth","texture",0},{"source_normal","texture",1},{"source_radius","texture",2},{"source_ssr","texture",3},{"dest_ssr","texture",4},{"dest_radius","texture",5}};
inline constexpr const char*source3=R"SSR_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

constant bool sc_multiview_tmp [[function_constant(0)]];
constant bool sc_multiview = is_function_constant_defined(sc_multiview_tmp) ? sc_multiview_tmp : false;

struct Params
{
    float4 proj_info;
    uint orthogonal;
    float edge_tolerance;
    int increment;
    uint view_index;
    int2 screen_size;
    uint vertical;
    uint steps;
};

struct SceneData
{
    float4x4 projection[2];
    float4x4 inv_projection[2];
    float4 eye_offset[2];
};

struct ResType
{
    float _m0;
    float _m1;
};

constant uint3 gl_WorkGroupSize [[maybe_unused]] = uint3(8u, 8u, 1u);
constant float4 _1158 = {};

constant spvUnsafeArray<float, 16> _183 = spvUnsafeArray<float, 16>({ 0.1847392022609710693359375, 0.16595853865146636962890625, 0.1203136444091796875, 0.070387549698352813720703125, 0.033229254186153411865234375, 0.01265781931579113006591796875, 0.00389030412770807743072509765625, 0.0009646503604017198085784912109375, 0.00019297086691949516534805297851562, 3.1139938073465600609779357910156e-05, 4.0533091123506892472505569458008e-06, 4.2552281342977948952466249465942e-07, 3.602517750778133631683886051178e-08, 2.4592561320702088778489269316196e-09, 1.353494538669508528982987627387e-10, 0.0 });

kernel void main0(constant SceneData& scene_data [[buffer(0)]], constant Params& params [[buffer(1)]], texture2d<float> source_depth [[texture(0)]], texture2d<float> source_normal [[texture(1)]], texture2d<float> source_radius [[texture(2)]], texture2d<float> source_ssr [[texture(3)]], texture2d<float, access::write> dest_ssr [[texture(4)]], texture2d<float, access::write> dest_radius [[texture(5)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    do
    {
        int2 _340 = int2(gl_GlobalInvocationID.xy);
        if (any(_340 >= params.screen_size))
        {
            break;
        }
        int2 _373 = int2(params.increment, 0);
        float4 _377 = source_depth.read(uint2(_340));
        float _378 = _377.x;
        float2 _383 = float2(_340) + float2(0.5);
        float3 _1083;
        do
        {
            if (sc_multiview)
            {
                float4 _512 = scene_data.inv_projection[params.view_index] * float4(((_383 * 2.0) / float2(params.screen_size)) - float2(1.0), (_378 * 2.0) - 1.0, 1.0);
                float3 _518 = _512.xyz / float3(_512.w);
                float4 _1038;
                _1038.x = _518.x;
                _1038.y = _518.y;
                _1038.z = _518.z;
                _1083 = _1038.xyz;
                break;
            }
            else
            {
                if (params.orthogonal != 0u)
                {
                    _1083 = float3(-((_383 * params.proj_info.xy) + params.proj_info.zw), _378);
                    break;
                }
                else
                {
                    _1083 = float3(((_383 * params.proj_info.xy) + params.proj_info.zw) * _378, _378);
                    break;
                }
                break; // unreachable workaround
            }
            break; // unreachable workaround
        } while(false);
        float3 _397 = fast::normalize((source_normal.read(uint2(_340)).xyz * 2.0) - float3(1.0));
        _397.y = -_397.y;
        float4 _1094;
        float _1097;
        float _1100;
        _1100 = 0.1847392022609710693359375;
        _1097 = source_radius.read(uint2(_340)).x * 0.1847392022609710693359375;
        _1094 = source_ssr.read(uint2(_340)) * 0.1847392022609710693359375;
        float4 _1139;
        float _1140;
        float _1141;
        for (int _1087 = 1; uint(_1087) < params.steps; _1100 = _1141, _1097 = _1140, _1094 = _1139, _1087++)
        {
            float _593 = float(_1087 * params.increment);
            int2 _599 = _340 + (_373 * int2(_1087));
            float4 _602 = source_depth.read(uint2(_599));
            float _603 = _602.x;
            float2 _607 = float2(_599) + float2(0.5);
            float3 _1090;
            do
            {
                if (sc_multiview)
                {
                    float4 _710 = scene_data.inv_projection[params.view_index] * float4(((_607 * 2.0) / float2(params.screen_size)) - float2(1.0), (_603 * 2.0) - 1.0, 1.0);
                    float3 _716 = _710.xyz / float3(_710.w);
                    float4 _1056;
                    _1056.x = _716.x;
                    _1056.y = _716.y;
                    _1056.z = _716.z;
                    _1090 = _1056.xyz;
                    break;
                }
                else
                {
                    if (params.orthogonal != 0u)
                    {
                        _1090 = float3(-((_607 * params.proj_info.xy) + params.proj_info.zw), _603);
                        break;
                    }
                    else
                    {
                        _1090 = float3(((_607 * params.proj_info.xy) + params.proj_info.zw) * _603, _603);
                        break;
                    }
                    break; // unreachable workaround
                }
                break; // unreachable workaround
            } while(false);
            float3 _617 = fast::normalize((source_normal.read(uint2(_599)).xyz * 2.0) - float3(1.0));
            _617.y = -_617.y;
            float4 _624 = source_radius.read(uint2(_599));
            float _625 = _624.x;
            float _628 = round(_625 * 255.0);
            if ((1.0 - abs(dot(_397, _617))) > params.edge_tolerance)
            {
                break;
            }
            if (abs(dot(_397, fast::normalize(_1090 - _1083))) > params.edge_tolerance)
            {
                break;
            }
            if (_593 < _628)
            {
                float _1091;
                do
                {
                    ResType _777;
                    _777._m0 = modf(fast::max(0.0, (_593 / _628) * 15.0), _777._m1);
                    int _781 = int(_777._m1);
                    if (_781 >= 16)
                    {
                        _1091 = 0.0;
                        break;
                    }
                    _1091 = mix(_183[_781], _183[_781 + 1], _777._m0);
                    break;
                } while(false);
                _1141 = _1100 + _1091;
                _1140 = _1097 + (_625 * _1091);
                _1139 = _1094 + (source_ssr.read(uint2(_599)) * _1091);
            }
            else
            {
                _1141 = _1100;
                _1140 = _1097;
                _1139 = _1094;
            }
        }
        int2 _423 = -_373;
        float4 _1119;
        float _1122;
        float _1125;
        _1125 = _1100;
        _1122 = _1097;
        _1119 = _1094;
        float4 _1146;
        float _1147;
        float _1148;
        for (int _1107 = 1; uint(_1107) < params.steps; _1125 = _1148, _1122 = _1147, _1119 = _1146, _1107++)
        {
            float _824 = float(_1107 * params.increment);
            int2 _830 = _340 + (_423 * int2(_1107));
            float4 _833 = source_depth.read(uint2(_830));
            float _834 = _833.x;
            float2 _838 = float2(_830) + float2(0.5);
            float3 _1115;
            do
            {
                if (sc_multiview)
                {
                    float4 _941 = scene_data.inv_projection[params.view_index] * float4(((_838 * 2.0) / float2(params.screen_size)) - float2(1.0), (_834 * 2.0) - 1.0, 1.0);
                    float3 _947 = _941.xyz / float3(_941.w);
                    float4 _1074;
                    _1074.x = _947.x;
                    _1074.y = _947.y;
                    _1074.z = _947.z;
                    _1115 = _1074.xyz;
                    break;
                }
                else
                {
                    if (params.orthogonal != 0u)
                    {
                        _1115 = float3(-((_838 * params.proj_info.xy) + params.proj_info.zw), _834);
                        break;
                    }
                    else
                    {
                        _1115 = float3(((_838 * params.proj_info.xy) + params.proj_info.zw) * _834, _834);
                        break;
                    }
                    break; // unreachable workaround
                }
                break; // unreachable workaround
            } while(false);
            float3 _848 = fast::normalize((source_normal.read(uint2(_830)).xyz * 2.0) - float3(1.0));
            _848.y = -_848.y;
            float4 _855 = source_radius.read(uint2(_830));
            float _856 = _855.x;
            float _859 = round(_856 * 255.0);
            if ((1.0 - abs(dot(_397, _848))) > params.edge_tolerance)
            {
                break;
            }
            if (abs(dot(_397, fast::normalize(_1115 - _1083))) > params.edge_tolerance)
            {
                break;
            }
            if (_824 < _859)
            {
                float _1116;
                do
                {
                    ResType _1008;
                    _1008._m0 = modf(fast::max(0.0, (_824 / _859) * 15.0), _1008._m1);
                    int _1012 = int(_1008._m1);
                    if (_1012 >= 16)
                    {
                        _1116 = 0.0;
                        break;
                    }
                    _1116 = mix(_183[_1012], _183[_1012 + 1], _1008._m0);
                    break;
                } while(false);
                _1148 = _1125 + _1116;
                _1147 = _1122 + (_856 * _1116);
                _1146 = _1119 + (source_ssr.read(uint2(_830)) * _1116);
            }
            else
            {
                _1148 = _1125;
                _1147 = _1122;
                _1146 = _1119;
            }
        }
        float4 _1132;
        float _1133;
        if (_1125 > 0.0)
        {
            _1133 = _1122 / _1125;
            _1132 = _1119 / float4(_1125);
        }
        else
        {
            _1133 = 0.0;
            _1132 = float4(0.0);
        }
        dest_ssr.write(_1132, uint2(_340));
        dest_radius.write(float4(_1133), uint2(_340));
        break;
    } while(false);
}

)SSR_GPU";
inline constexpr Binding bindings4[]={{"scene_data","buffer",0},{"params","buffer",1},{"source_depth","texture",0},{"source_normal","texture",1},{"source_radius","texture",2},{"source_ssr","texture",3},{"dest_ssr","texture",4}};
inline constexpr const char*source4=R"SSR_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

constant bool sc_multiview_tmp [[function_constant(0)]];
constant bool sc_multiview = is_function_constant_defined(sc_multiview_tmp) ? sc_multiview_tmp : false;

struct Params
{
    float4 proj_info;
    uint orthogonal;
    float edge_tolerance;
    int increment;
    uint view_index;
    int2 screen_size;
    uint vertical;
    uint steps;
};

struct SceneData
{
    float4x4 projection[2];
    float4x4 inv_projection[2];
    float4 eye_offset[2];
};

struct ResType
{
    float _m0;
    float _m1;
};

constant uint3 gl_WorkGroupSize [[maybe_unused]] = uint3(8u, 8u, 1u);
constant float4 _1126 = {};

constant spvUnsafeArray<float, 16> _183 = spvUnsafeArray<float, 16>({ 0.1847392022609710693359375, 0.16595853865146636962890625, 0.1203136444091796875, 0.070387549698352813720703125, 0.033229254186153411865234375, 0.01265781931579113006591796875, 0.00389030412770807743072509765625, 0.0009646503604017198085784912109375, 0.00019297086691949516534805297851562, 3.1139938073465600609779357910156e-05, 4.0533091123506892472505569458008e-06, 4.2552281342977948952466249465942e-07, 3.602517750778133631683886051178e-08, 2.4592561320702088778489269316196e-09, 1.353494538669508528982987627387e-10, 0.0 });

kernel void main0(constant SceneData& scene_data [[buffer(0)]], constant Params& params [[buffer(1)]], texture2d<float> source_depth [[texture(0)]], texture2d<float> source_normal [[texture(1)]], texture2d<float> source_radius [[texture(2)]], texture2d<float> source_ssr [[texture(3)]], texture2d<float, access::write> dest_ssr [[texture(4)]], uint3 gl_GlobalInvocationID [[thread_position_in_grid]])
{
    do
    {
        int2 _335 = int2(gl_GlobalInvocationID.xy);
        if (any(_335 >= params.screen_size))
        {
            break;
        }
        int2 _368 = int2(0, params.increment);
        float4 _372 = source_depth.read(uint2(_335));
        float _373 = _372.x;
        float2 _378 = float2(_335) + float2(0.5);
        float3 _1063;
        do
        {
            if (sc_multiview)
            {
                float4 _502 = scene_data.inv_projection[params.view_index] * float4(((_378 * 2.0) / float2(params.screen_size)) - float2(1.0), (_373 * 2.0) - 1.0, 1.0);
                float3 _508 = _502.xyz / float3(_502.w);
                float4 _1018;
                _1018.x = _508.x;
                _1018.y = _508.y;
                _1018.z = _508.z;
                _1063 = _1018.xyz;
                break;
            }
            else
            {
                if (params.orthogonal != 0u)
                {
                    _1063 = float3(-((_378 * params.proj_info.xy) + params.proj_info.zw), _373);
                    break;
                }
                else
                {
                    _1063 = float3(((_378 * params.proj_info.xy) + params.proj_info.zw) * _373, _373);
                    break;
                }
                break; // unreachable workaround
            }
            break; // unreachable workaround
        } while(false);
        float3 _392 = fast::normalize((source_normal.read(uint2(_335)).xyz * 2.0) - float3(1.0));
        _392.y = -_392.y;
        float4 _1073;
        float _1076;
        _1076 = 0.1847392022609710693359375;
        _1073 = source_ssr.read(uint2(_335)) * 0.1847392022609710693359375;
        float4 _1109;
        float _1110;
        for (int _1066 = 1; uint(_1066) < params.steps; _1076 = _1110, _1073 = _1109, _1066++)
        {
            float _583 = float(_1066 * params.increment);
            int2 _589 = _335 + (_368 * int2(_1066));
            float4 _592 = source_depth.read(uint2(_589));
            float _593 = _592.x;
            float2 _597 = float2(_589) + float2(0.5);
            float3 _1069;
            do
            {
                if (sc_multiview)
                {
                    float4 _695 = scene_data.inv_projection[params.view_index] * float4(((_597 * 2.0) / float2(params.screen_size)) - float2(1.0), (_593 * 2.0) - 1.0, 1.0);
                    float3 _701 = _695.xyz / float3(_695.w);
                    float4 _1036;
                    _1036.x = _701.x;
                    _1036.y = _701.y;
                    _1036.z = _701.z;
                    _1069 = _1036.xyz;
                    break;
                }
                else
                {
                    if (params.orthogonal != 0u)
                    {
                        _1069 = float3(-((_597 * params.proj_info.xy) + params.proj_info.zw), _593);
                        break;
                    }
                    else
                    {
                        _1069 = float3(((_597 * params.proj_info.xy) + params.proj_info.zw) * _593, _593);
                        break;
                    }
                    break; // unreachable workaround
                }
                break; // unreachable workaround
            } while(false);
            float3 _607 = fast::normalize((source_normal.read(uint2(_589)).xyz * 2.0) - float3(1.0));
            _607.y = -_607.y;
            float _618 = round(source_radius.read(uint2(_589)).x * 255.0);
            if ((1.0 - abs(dot(_392, _607))) > params.edge_tolerance)
            {
                break;
            }
            if (abs(dot(_392, fast::normalize(_1069 - _1063))) > params.edge_tolerance)
            {
                break;
            }
            if (_583 < _618)
            {
                float _1070;
                do
                {
                    ResType _762;
                    _762._m0 = modf(fast::max(0.0, (_583 / _618) * 15.0), _762._m1);
                    int _766 = int(_762._m1);
                    if (_766 >= 16)
                    {
                        _1070 = 0.0;
                        break;
                    }
                    _1070 = mix(_183[_766], _183[_766 + 1], _762._m0);
                    break;
                } while(false);
                _1110 = _1076 + _1070;
                _1109 = _1073 + (source_ssr.read(uint2(_589)) * _1070);
            }
            else
            {
                _1110 = _1076;
                _1109 = _1073;
            }
        }
        int2 _418 = -_368;
        float4 _1094;
        float _1097;
        _1097 = _1076;
        _1094 = _1073;
        float4 _1115;
        float _1116;
        for (int _1082 = 1; uint(_1082) < params.steps; _1097 = _1116, _1094 = _1115, _1082++)
        {
            float _809 = float(_1082 * params.increment);
            int2 _815 = _335 + (_418 * int2(_1082));
            float4 _818 = source_depth.read(uint2(_815));
            float _819 = _818.x;
            float2 _823 = float2(_815) + float2(0.5);
            float3 _1090;
            do
            {
                if (sc_multiview)
                {
                    float4 _921 = scene_data.inv_projection[params.view_index] * float4(((_823 * 2.0) / float2(params.screen_size)) - float2(1.0), (_819 * 2.0) - 1.0, 1.0);
                    float3 _927 = _921.xyz / float3(_921.w);
                    float4 _1054;
                    _1054.x = _927.x;
                    _1054.y = _927.y;
                    _1054.z = _927.z;
                    _1090 = _1054.xyz;
                    break;
                }
                else
                {
                    if (params.orthogonal != 0u)
                    {
                        _1090 = float3(-((_823 * params.proj_info.xy) + params.proj_info.zw), _819);
                        break;
                    }
                    else
                    {
                        _1090 = float3(((_823 * params.proj_info.xy) + params.proj_info.zw) * _819, _819);
                        break;
                    }
                    break; // unreachable workaround
                }
                break; // unreachable workaround
            } while(false);
            float3 _833 = fast::normalize((source_normal.read(uint2(_815)).xyz * 2.0) - float3(1.0));
            _833.y = -_833.y;
            float _844 = round(source_radius.read(uint2(_815)).x * 255.0);
            if ((1.0 - abs(dot(_392, _833))) > params.edge_tolerance)
            {
                break;
            }
            if (abs(dot(_392, fast::normalize(_1090 - _1063))) > params.edge_tolerance)
            {
                break;
            }
            if (_809 < _844)
            {
                float _1091;
                do
                {
                    ResType _988;
                    _988._m0 = modf(fast::max(0.0, (_809 / _844) * 15.0), _988._m1);
                    int _992 = int(_988._m1);
                    if (_992 >= 16)
                    {
                        _1091 = 0.0;
                        break;
                    }
                    _1091 = mix(_183[_992], _183[_992 + 1], _988._m0);
                    break;
                } while(false);
                _1116 = _1097 + _1091;
                _1115 = _1094 + (source_ssr.read(uint2(_815)) * _1091);
            }
            else
            {
                _1116 = _1097;
                _1115 = _1094;
            }
        }
        float4 _1103;
        if (_1097 > 0.0)
        {
            _1103 = _1094 / float4(_1097);
        }
        else
        {
            _1103 = float4(0.0);
        }
        dest_ssr.write(_1103, uint2(_335));
        break;
    } while(false);
}

)SSR_GPU";
inline constexpr const Binding*bindings5=nullptr;
inline constexpr const char*source5=R"SSR_GPU(#pragma clang diagnostic ignored "-Wmissing-prototypes"
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

constant spvUnsafeArray<float2, 3> _19 = spvUnsafeArray<float2, 3>({ float2(-1.0), float2(-1.0, 3.0), float2(3.0, -1.0) });

struct main0_out
{
    float2 uv_interp [[user(locn0)]];
    float4 gl_Position [[position]];
};

vertex main0_out main0(uint gl_VertexIndex [[vertex_id]])
{
    main0_out out = {};
    out.gl_Position = float4(_19[int(gl_VertexIndex)], 0.0, 1.0);
    out.uv_interp = fast::clamp(out.gl_Position.xy, float2(0.0), float2(1.0)) * 2.0;
    return out;
}

)SSR_GPU";
inline constexpr Binding bindings6[]={{"specular","texture",0},{"ssr","texture",1},{"specularSmplr","sampler",0},{"ssrSmplr","sampler",1}};
inline constexpr const char*source6=R"SSR_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct main0_out
{
    float4 frag_color [[color(0)]];
};

struct main0_in
{
    float2 uv_interp [[user(locn0)]];
};

fragment main0_out main0(main0_in in [[stage_in]], texture2d<float> specular [[texture(0)]], texture2d<float> ssr [[texture(1)]], sampler specularSmplr [[sampler(0)]], sampler ssrSmplr [[sampler(1)]])
{
    main0_out out = {};
    float4 _20 = specular.sample(specularSmplr, in.uv_interp);
    out.frag_color.x = _20.x;
    out.frag_color.y = _20.y;
    out.frag_color.z = _20.z;
    out.frag_color.w = 0.0;
    float4 _42 = ssr.sample(ssrSmplr, in.uv_interp);
    float4 _43 = out.frag_color;
    float3 _51 = mix(_43.xyz, _42.xyz, float3(_42.w));
    out.frag_color.x = _51.x;
    out.frag_color.y = _51.y;
    out.frag_color.z = _51.z;
    return out;
}

)SSR_GPU";
inline constexpr Binding bindings7[]={{"specular","texture",0},{"ssr","texture",1},{"diffuse","texture",2},{"specularSmplr","sampler",0},{"ssrSmplr","sampler",1},{"diffuseSmplr","sampler",2}};
inline constexpr const char*source7=R"SSR_GPU(#include <metal_stdlib>
#include <simd/simd.h>

using namespace metal;

struct main0_out
{
    float4 frag_color [[color(0)]];
};

struct main0_in
{
    float2 uv_interp [[user(locn0)]];
};

fragment main0_out main0(main0_in in [[stage_in]], texture2d<float> specular [[texture(0)]], texture2d<float> ssr [[texture(1)]], texture2d<float> diffuse [[texture(2)]], sampler specularSmplr [[sampler(0)]], sampler ssrSmplr [[sampler(1)]], sampler diffuseSmplr [[sampler(2)]])
{
    main0_out out = {};
    float4 _20 = specular.sample(specularSmplr, in.uv_interp);
    out.frag_color.x = _20.x;
    out.frag_color.y = _20.y;
    out.frag_color.z = _20.z;
    out.frag_color.w = 0.0;
    float4 _42 = ssr.sample(ssrSmplr, in.uv_interp);
    float4 _43 = out.frag_color;
    float3 _51 = mix(_43.xyz, _42.xyz, float3(_42.w));
    out.frag_color.x = _51.x;
    out.frag_color.y = _51.y;
    out.frag_color.z = _51.z;
    out.frag_color += diffuse.sample(diffuseSmplr, in.uv_interp);
    return out;
}

)SSR_GPU";
inline constexpr Shader shaders[]={{"scale","main0",source0,bindings0,10,8,8,1},{"main","main0",source1,bindings1,8,8,8,1},{"main_rough","main0",source2,bindings2,9,8,8,1},{"filter_h","main0",source3,bindings3,8,8,8,1},{"filter_v","main0",source4,bindings4,7,8,8,1},{"merge_vertex","main0",source5,bindings5,0,0,0,0},{"merge_specular","main0",source6,bindings6,4,0,0,0},{"merge_full","main0",source7,bindings7,6,0,0,0}};
}
