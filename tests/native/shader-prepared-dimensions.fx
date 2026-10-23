// Copyright (c) MacLauncher contributors. MIT license.
#include "ReShade.fxh"
float4 Dimensions(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    float4 source = tex2D(ReShade::BackBuffer, uv);
    float reciprocal = (BUFFER_RCP_WIDTH * BUFFER_WIDTH + BUFFER_RCP_HEIGHT * BUFFER_HEIGHT) * 0.25;
    return float4(BUFFER_WIDTH / 255.0, BUFFER_HEIGHT / 255.0, reciprocal, source.a);
}
technique Dimensions { pass { VertexShader = PostProcessVS; PixelShader = Dimensions; } }
