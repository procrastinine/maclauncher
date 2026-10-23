texture Color : COLOR;
texture Depth : DEPTH;
sampler ColorSampler { Texture = Color; };
sampler DepthSampler { Texture = Depth; };
float4 VS(uint id : SV_VertexID, out float2 uv : TEXCOORD) : SV_Position {
    uv = float2((id << 1) & 2, id & 2);
    return float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 PS(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    return float4(tex2D(ColorSampler, uv).rgb * tex2D(DepthSampler, uv).r, 1);
}
technique DepthColor { pass { VertexShader = VS; PixelShader = PS; } }
