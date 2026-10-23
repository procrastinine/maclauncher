// Copyright (c) MacLauncher contributors. MIT license.
#include "common.fxh"
uniform float Strength < ui_label = "CRT strength"; ui_min = 0.0; ui_max = 1.0; > = 1.0;
uniform float SimulatedHeight < ui_label = "Simulated content height"; ui_tooltip = "One scanline per content pixel row. Set the original canvas height, or 0 for the render-target height."; ui_min = 0.0; ui_max = 2160.0; ui_step = 1.0; > = 240.0;
uniform float BeamWidth < ui_label = "Scanline beam width"; ui_min = 0.2; ui_max = 1.0; ui_step = 0.05; > = 0.65;
uniform float ScanlineDepth < ui_label = "Scanline darkness"; ui_min = 0.0; ui_max = 0.8; ui_step = 0.05; > = 0.6;
uniform float Softness < ui_label = "Pixel softness"; ui_tooltip = "Blur radius in simulated content pixels, independent of window size."; ui_min = 0.0; ui_max = 1.5; ui_step = 0.05; > = 0.65;
uniform float Glow < ui_label = "Phosphor glow"; ui_min = 0.0; ui_max = 0.8; ui_step = 0.05; > = 0.2;
uniform float Curvature < ui_label = "Screen curvature"; ui_min = 0.0; ui_max = 0.3; ui_step = 0.01; > = 0.075;
uniform float CornerRadius < ui_label = "Rounded corners"; ui_min = 0.0; ui_max = 0.3; ui_step = 0.01; > = 0.08;
uniform float Vignette < ui_label = "Edge shading"; ui_min = 0.0; ui_max = 1.0; ui_step = 0.05; > = 0.45;
uniform float EdgeFade < ui_label = "Screen edge fade"; ui_min = 0.0; ui_max = 0.25; ui_step = 0.01; > = 0.06;
float3 CRTLight(float2 uv) {
    float3 colour = tex2D(SourceSampler, saturate(uv)).rgb;
    return colour * colour;
}
float4 CRT(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    float4 original = tex2D(SourceSampler, uv);
    float2 screen = uv * 2.0 - 1.0;
    float2 lens = screen * (1.0 + Curvature * screen.yx * screen.yx);
    float2 source = lens * 0.5 + 0.5;
    // Anchor beams to content rows before lens distortion, independent of resize.
    float rows = SimulatedHeight > 0.0 ? SimulatedHeight : BUFFER_HEIGHT;
    float2 pixel = float2(BUFFER_HEIGHT / float(BUFFER_WIDTH), 1.0) / max(rows, 1.0);
    float2 radius = pixel * Softness * float2(1.0, 0.65);
    // Filter the complete image continuously: artwork and HUD can use different
    // pixel grids. Sampling a forced low-resolution grid would discard HUD detail.
    float3 light = CRTLight(source) * 4.0;
    light += (CRTLight(source + float2(radius.x, 0.0)) + CRTLight(source - float2(radius.x, 0.0))
        + CRTLight(source + float2(0.0, radius.y)) + CRTLight(source - float2(0.0, radius.y))) * 2.0;
    light += CRTLight(source + radius) + CRTLight(source - radius)
        + CRTLight(source + float2(radius.x, -radius.y)) + CRTLight(source + float2(-radius.x, radius.y));
    light *= 1.0 / 16.0;
    float2 haloRadius = pixel * 1.5;
    float3 halo = (light * 4.0 + CRTLight(source + float2(haloRadius.x, 0.0))
        + CRTLight(source - float2(haloRadius.x, 0.0)) + CRTLight(source + float2(0.0, haloRadius.y))
        + CRTLight(source - float2(0.0, haloRadius.y))) * 0.125;
    light += max(halo - 0.08, 0.0) * Glow;
    float phase = abs(frac(source.y * rows) - 0.5);
    float beam = exp2(-4.0 * phase * phase / (BeamWidth * BeamWidth));
    // Fade a pattern that cannot be resolved rather than aliasing into moire.
    float resolved = saturate(2.0 - 2.0 * rows / BUFFER_HEIGHT);
    light *= 1.0 - ScanlineDepth * resolved * (1.0 - beam);
    float3 colour = sqrt(max(light, 0.0));
    colour *= 1.08 * (1.0 - Vignette * saturate(dot(screen, screen) * 0.5));
    float corner = max(0.001, CornerRadius);
    float2 edge = abs(lens) - (1.0 - corner);
    float distance = length(max(edge, 0.0)) + min(max(edge.x, edge.y), 0.0) - corner;
    float mask = 1.0 - smoothstep(-max(EdgeFade, 3.0 / BUFFER_HEIGHT), 0.0, distance);
    return float4(lerp(original.rgb, colour * mask, Strength), original.a);
}
technique CRT { pass { VertexShader = FullscreenVS; PixelShader = CRT; } }
