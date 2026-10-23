// Copyright (c) MacLauncher contributors. MIT license.
texture Source : COLOR;
sampler SourceSampler { Texture = Source; };
void FullscreenVS(uint id : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD) {
    uv = float2((id << 1) & 2, id & 2);
    position = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
