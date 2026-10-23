texture Color : COLOR;
sampler ColorSampler { Texture = Color; };
float4 VS(uint id : SV_VertexID, out float2 uv : TEXCOORD) : SV_Position {
    uv = float2((id << 1) & 2, id & 2);
    return float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 PS(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    return float4(step(0.5, tex2D(ColorSampler, uv).rgb), 1);
}
technique Threshold { pass { VertexShader = VS; PixelShader = PS; } }
