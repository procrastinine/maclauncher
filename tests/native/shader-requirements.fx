#include "ReShade.fxh"
// A declared but unused depth image must not make the colour-only technique
// require depth. Requirements follow the compiled pass bindings.
texture SceneDepth : DEPTH;
sampler SceneDepthSampler { Texture = SceneDepth; };
float4 Colour(float4 position : SV_Position,float2 uv : TEXCOORD) : SV_Target {
    return tex2D(ReShade::BackBuffer,uv);
}
float4 Depth(float4 position : SV_Position,float2 uv : TEXCOORD) : SV_Target {
    return tex2D(SceneDepthSampler,uv);
}
technique ColourOnly { pass { VertexShader=PostProcessVS;PixelShader=Colour; } }
technique DepthOnly { pass { VertexShader=PostProcessVS;PixelShader=Depth; } }
