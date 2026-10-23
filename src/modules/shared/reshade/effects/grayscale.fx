// Copyright (c) MacLauncher contributors. MIT license.
#include "common.fxh"
uniform float Strength < ui_label = "Grayscale strength"; ui_min = 0.0; ui_max = 1.0; > = 1.0;
float4 Grayscale(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    float4 colour = tex2D(SourceSampler, uv);
    float brightness = dot(colour.rgb, float3(0.2126, 0.7152, 0.0722));
    return float4(lerp(colour.rgb, brightness.xxx, Strength), colour.a);
}
technique Grayscale { pass { VertexShader = FullscreenVS; PixelShader = Grayscale; } }
