// Copyright (c) MacLauncher contributors. MIT license.
#include "common.fxh"
uniform float Saturation < ui_label = "Saturation"; ui_min = 0.0; ui_max = 2.0; > = 1.2;
float4 Colour(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    float4 colour = tex2D(SourceSampler, uv);
    float luminance = dot(colour.rgb, float3(0.2126, 0.7152, 0.0722));
    return float4(saturate(lerp(luminance.xxx, colour.rgb, Saturation)), colour.a);
}
technique Colour { pass { VertexShader = FullscreenVS; PixelShader = Colour; } }
