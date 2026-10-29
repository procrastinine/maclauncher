// Copyright (c) MacLauncher contributors. MIT license.
texture Color : COLOR;
sampler ColorSampler { Texture = Color; };
void VS(uint id : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD) {
    uv = float2((id << 1) & 2, id & 2); position = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 Gray(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    float4 c = tex2D(ColorSampler, uv); return float4(dot(c.rgb, float3(0.2126, 0.7152, 0.0722)).xxx, c.a);
}
float4 Sharpen(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    float4 c = tex2D(ColorSampler, uv); float2 p = float2(1.0 / 32.0, 1.0 / 24.0);
    float3 blur = (tex2D(ColorSampler, uv + float2(p.x, 0)).rgb + tex2D(ColorSampler, uv - float2(p.x, 0)).rgb
        + tex2D(ColorSampler, uv + float2(0, p.y)).rgb + tex2D(ColorSampler, uv - float2(0, p.y)).rgb) * 0.25;
    return float4(saturate(c.rgb + (c.rgb - blur) * 0.5), c.a);
}
technique Sharpen { pass { VertexShader = VS; PixelShader = Sharpen; } }
