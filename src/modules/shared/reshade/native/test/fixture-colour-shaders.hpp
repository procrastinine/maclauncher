#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#include <cassert>

namespace fixture {
inline NSString *colourShaderPath(NSString *directory,bool prefix=false){
    return [directory stringByAppendingPathComponent:prefix?@"prefix.fx":@"suffix.fx"];
}
// Real FX inputs are consumed by the dylib's ordinary shader factory. Defining
// makeShaderNode in a fixture cannot override a two-level dylib's own calls.
inline void writeColourShaders(NSString *directory){
    NSString *source=[NSString stringWithUTF8String:R"FX(uniform float Gain = 0.2;
texture Color : COLOR;
sampler ColorSampler { Texture = Color; };
void VS(uint id : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD) {
    uv = float2((id << 1) & 2, id & 2);
    position = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 PS(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    float4 color = tex2D(ColorSampler, uv); color.CHANNEL = Gain; return color;
}
technique Colour { pass { VertexShader = VS; PixelShader = PS; } }
)FX"];
    for(unsigned index=0;index<2;++index){
        const bool prefix=index!=0;
        NSString *shader=[source stringByReplacingOccurrencesOfString:@"CHANNEL" withString:prefix?@"r":@"b"];
        assert([shader writeToFile:colourShaderPath(directory,prefix) atomically:NO encoding:NSUTF8StringEncoding error:nil]);
    }
    // The legacy live-control phase selects the same source through its
    // immutable revision directory, exactly like ordinary live FX inputs.
    NSString *revision=[@"" stringByPaddingToLength:64 withString:@"b" startingAtIndex:0];
    NSString *live=[directory stringByAppendingPathComponent:revision];
    assert([NSFileManager.defaultManager createDirectoryAtPath:live withIntermediateDirectories:YES attributes:nil error:nil]);
    assert([NSFileManager.defaultManager copyItemAtPath:colourShaderPath(directory) toPath:[live stringByAppendingPathComponent:@"effect.prepared.fx"] error:nil]);
}
}
