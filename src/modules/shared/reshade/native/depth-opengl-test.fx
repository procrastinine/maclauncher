texture SceneColor : COLOR;
texture SceneDepth : DEPTH;
sampler ColorSampler { Texture = SceneColor; MinFilter = POINT; MagFilter = POINT; MipFilter = POINT; };
sampler DepthSampler { Texture = SceneDepth; MinFilter = POINT; MagFilter = POINT; MipFilter = POINT; };
void Vertex(uint id : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD)
{
    uv = float2((id << 1) & 2, id & 2);
    position = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 Pixel(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target
{
    float d = tex2D(DepthSampler, uv).r;
    return float4(d, d, d, tex2D(ColorSampler, uv).a);
}
technique DepthCopy { pass { VertexShader = Vertex; PixelShader = Pixel; } }
