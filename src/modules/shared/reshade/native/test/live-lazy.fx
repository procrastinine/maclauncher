// Copyright (c) MacLauncher contributors. MIT license.
// Full-screen, discarding, blended and final passes for the copy-chain check.
texture Color : COLOR;
sampler ColorSampler { Texture = Color; };
void PostProcessVS(in uint id : SV_VertexID, out float4 position : SV_Position, out float2 texcoord : TEXCOORD) {
    texcoord.x = (id == 2) ? 2.0 : 0.0; texcoord.y = (id == 1) ? 2.0 : 0.0;
    position = float4(texcoord * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}
float4 InvertPS(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    float4 c = tex2D(ColorSampler, uv); return float4(1.0 - c.rgb, c.a);
}
float4 MarkPS(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    if (uv.x < 0.5) discard; return float4(0.0, 1.0, 0.0, 1.0);
}
float4 TintPS(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target { return float4(0.0, 0.0, 0.25, 0.0); }
technique Lazy {
    pass Invert { VertexShader = PostProcessVS; PixelShader = InvertPS; }
    pass Mark { VertexShader = PostProcessVS; PixelShader = MarkPS; }
    pass Tint { VertexShader = PostProcessVS; PixelShader = TintPS; BlendEnable = true; SrcBlend = ONE; DestBlend = ONE; SrcBlendAlpha = ZERO; DestBlendAlpha = ONE; }
    pass Restore { VertexShader = PostProcessVS; PixelShader = InvertPS; }
}
