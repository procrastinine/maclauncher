// Copyright (c) MacLauncher contributors. MIT license.
#include "common.fxh"
uniform float Strength < ui_label = "Sharpening strength"; ui_min = 0.0; ui_max = 1.0; > = 0.2;
float4 Sharpen(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    float4 colour = tex2D(SourceSampler, uv);
    float2 pixel = float2(1.0 / BUFFER_WIDTH, 1.0 / BUFFER_HEIGHT);
    float3 neighbours = tex2D(SourceSampler, uv + float2(pixel.x, 0)).rgb
      + tex2D(SourceSampler, uv - float2(pixel.x, 0)).rgb
      + tex2D(SourceSampler, uv + float2(0, pixel.y)).rgb
      + tex2D(SourceSampler, uv - float2(0, pixel.y)).rgb;
    return float4(saturate(colour.rgb + Strength * (colour.rgb - neighbours * 0.25)), colour.a);
}
technique Sharpen { pass { VertexShader = FullscreenVS; PixelShader = Sharpen; } }
