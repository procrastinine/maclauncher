// Copyright (c) MacLauncher contributors. MIT license.
uniform float Strength = 1.0;
texture Color : COLOR;
sampler ColorSampler { Texture = Color; };
void VS(uint id : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD) {
    uv = float2((id << 1) & 2, id & 2); position = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 PS(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    float4 c = tex2D(ColorSampler, uv); float gray = dot(c.rgb, float3(0.2126, 0.7152, 0.0722));
    return float4(lerp(c.rgb, gray.xxx, Strength), c.a);
}
technique Strength { pass { VertexShader = VS; PixelShader = PS; } }
