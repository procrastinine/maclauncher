// Copyright (c) MacLauncher contributors. MIT license.
// LMS daltonization algorithm: daltonize.org; numerical reference by IDDQD/crosire.
//! INPUT_POLICY srgb-sdr
#include "ReShade.fxh"

uniform int Type <
    ui_label = "Color vision";
    ui_type = "combo";
    ui_items = "Protanopia\0Deuteranopia\0Tritanopia\0";
    ui_min = 0; ui_max = 2; ui_step = 1;
> = 0;
uniform float Strength <
    ui_label = "Strength";
    ui_type = "slider";
    ui_min = 0.0; ui_max = 1.0; ui_step = 0.01;
> = 1.0;

float4 DaltonizePixel(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target
{
    float4 pixel = tex2D(ReShade::BackBuffer, uv);
    if (Strength <= 0.0) return pixel;
    float3 lms = float3(
        dot(pixel.rgb, float3(17.8824, 43.5161, 4.11935)),
        dot(pixel.rgb, float3(3.45565, 27.1554, 3.86714)),
        dot(pixel.rgb, float3(0.0299566, 0.184309, 1.46709)));
    float3 simulated = lms;
    if (Type == 0) simulated.x = dot(lms.yz, float2(2.02344, -2.52581));
    else if (Type == 1) simulated.y = dot(lms.xz, float2(0.494207, 1.24827));
    else simulated.z = dot(lms.xy, float2(-0.395913, 0.801109));
    float3 difference = pixel.rgb - float3(
        dot(simulated, float3(0.0809444479, -0.130504409, 0.116721066)),
        dot(simulated, float3(-0.0102485335, 0.0540193266, -0.113614708)),
        dot(simulated, float3(-0.000365296938, -0.00412161469, 0.693511405)));
    float3 redistribution = float3(0.0, difference.g + 0.7 * difference.r, difference.b + 0.7 * difference.r);
    return float4(pixel.rgb + Strength * redistribution, pixel.a);
}

technique Daltonize
{
    pass
    {
        VertexShader = PostProcessVS;
        PixelShader = DaltonizePixel;
    }
}
