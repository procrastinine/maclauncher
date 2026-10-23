/**
 * Copyright (C) 2013 Jorge Jimenez (jorge@iryoku.com)
 * Copyright (C) 2013 Jose I. Echevarria (joseignacioechevarria@gmail.com)
 * Copyright (C) 2013 Belen Masia (bmasia@unizar.es)
 * Copyright (C) 2013 Fernando Navarro (fernandn@microsoft.com)
 * Copyright (C) 2013 Diego Gutierrez (diegog@unizar.es)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to
 * do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software. As clarification, there
 * is no requirement that the copyright notice and permission be included in
 * binary distributions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// SweetFX / SMAA integration derived from CeeJayDK/SweetFX (MIT),
// Copyright (c) 2014 CeeJayDK.
// Source: 93ddf39b357f5da534ed6d34ba4ec8cc7dcfa361/Shaders/SweetFX/SMAA.fx
// Unchanged SMAA.fxh SHA256: ee18b0f376585338cdb477a0900757cebac86d3c476ef99955348b55818c8310
// Uses original color-edge math and lookup images. No scene depth or predication.
// Cleared zero-edge pixels produce zero blend weights, so running all pixels
// replaces only the optional stencil optimization, not the color algorithm.
#define SMAA_RT_METRICS float4(BUFFER_RCP_WIDTH, BUFFER_RCP_HEIGHT, BUFFER_WIDTH, BUFFER_HEIGHT)
#define SMAA_CUSTOM_SL 1
#define SMAA_THRESHOLD 0.10
#define SMAA_MAX_SEARCH_STEPS 32
#define SMAA_MAX_SEARCH_STEPS_DIAG 16
#define SMAA_CORNER_ROUNDING 25
#define SMAA_PREDICATION 0
#define SMAATexture2D(tex) sampler tex
#define SMAATexturePass2D(tex) tex
#define SMAASampleLevelZero(tex, coord) tex2Dlod(tex, float4(coord, 0.0, 0.0))
#define SMAASampleLevelZeroPoint(tex, coord) SMAASampleLevelZero(tex, coord)
#define SMAASampleLevelZeroOffset(tex, coord, offset) tex2Dlod(tex, float4(coord + offset * SMAA_RT_METRICS.xy, 0.0, 0.0))
#define SMAASample(tex, coord) tex2D(tex, coord)
#define SMAASamplePoint(tex, coord) SMAASample(tex, coord)
#define SMAASampleOffset(tex, coord, offset) tex2D(tex, coord + offset * SMAA_RT_METRICS.xy)
#define SMAA_BRANCH [branch]
#define SMAA_FLATTEN [flatten]
#include "SMAA.fxh"
#include "ReShade.fxh"

texture edgesTex { Width = BUFFER_WIDTH; Height = BUFFER_HEIGHT; Format = RG8; };
texture blendTex { Width = BUFFER_WIDTH; Height = BUFFER_HEIGHT; Format = RGBA8; };
texture areaTex < source = "AreaTex.png"; > { Width = 160; Height = 560; Format = RG8; };
texture searchTex < source = "SearchTex.png"; > { Width = 64; Height = 16; Format = R8; };
sampler colorGamma { Texture = ReShade::BackBufferTex; AddressU = Clamp; AddressV = Clamp; MinFilter = Linear; MagFilter = Linear; MipFilter = Point; SRGBTexture = false; };
sampler colorLinear { Texture = ReShade::BackBufferTex; AddressU = Clamp; AddressV = Clamp; MinFilter = Linear; MagFilter = Linear; MipFilter = Point; SRGBTexture = true; };
sampler edgesSampler { Texture = edgesTex; AddressU = Clamp; AddressV = Clamp; MinFilter = Linear; MagFilter = Linear; MipFilter = Linear; };
sampler blendSampler { Texture = blendTex; AddressU = Clamp; AddressV = Clamp; MinFilter = Linear; MagFilter = Linear; MipFilter = Linear; };
sampler areaSampler { Texture = areaTex; AddressU = Clamp; AddressV = Clamp; MinFilter = Linear; MagFilter = Linear; MipFilter = Linear; };
sampler searchSampler { Texture = searchTex; AddressU = Clamp; AddressV = Clamp; MinFilter = Point; MagFilter = Point; MipFilter = Point; };
void EdgeVS(uint id : SV_VertexID, out float4 pos : SV_Position, out float2 uv : TEXCOORD0, out float4 offset[3] : TEXCOORD1) {
 PostProcessVS(id, pos, uv); SMAAEdgeDetectionVS(uv, offset);
}
void WeightVS(uint id : SV_VertexID, out float4 pos : SV_Position, out float2 uv : TEXCOORD0, out float2 pixel : TEXCOORD1, out float4 offset[3] : TEXCOORD2) {
 PostProcessVS(id, pos, uv); SMAABlendingWeightCalculationVS(uv, pixel, offset);
}
void BlendVS(uint id : SV_VertexID, out float4 pos : SV_Position, out float2 uv : TEXCOORD0, out float4 offset : TEXCOORD1) {
 PostProcessVS(id, pos, uv); SMAANeighborhoodBlendingVS(uv, offset);
}
float2 EdgePS(float4 pos : SV_Position, float2 uv : TEXCOORD0, float4 offset[3] : TEXCOORD1) : SV_Target {
 return SMAAColorEdgeDetectionPS(uv, offset, colorGamma);
}
float4 WeightPS(float4 pos : SV_Position, float2 uv : TEXCOORD0, float2 pixel : TEXCOORD1, float4 offset[3] : TEXCOORD2) : SV_Target {
 return SMAABlendingWeightCalculationPS(uv, pixel, offset, edgesSampler, areaSampler, searchSampler, 0.0);
}
float3 BlendPS(float4 pos : SV_Position, float2 uv : TEXCOORD0, float4 offset : TEXCOORD1) : SV_Target {
 return SMAANeighborhoodBlendingPS(uv, offset, colorLinear, blendSampler).rgb;
}
technique SMAAColor {
 pass { VertexShader = EdgeVS; PixelShader = EdgePS; RenderTarget = edgesTex; ClearRenderTargets = true; }
 pass { VertexShader = WeightVS; PixelShader = WeightPS; RenderTarget = blendTex; ClearRenderTargets = true; }
 pass { VertexShader = BlendVS; PixelShader = BlendPS; SRGBWriteEnable = true; }
}
