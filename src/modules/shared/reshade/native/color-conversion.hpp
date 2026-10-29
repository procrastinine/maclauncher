#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "color-contract.hpp"
#include "effect-node.hpp"
namespace macfx {
enum class ColorToneMap { Preserve, Clip, Reinhard, PBRNeutral };
struct ColorConversion {
    ImageColorDescription source,target;
    ColorToneMap toneMap=ColorToneMap::Preserve;
    float headroom=1,exposure=0;
    unsigned ditherBits=0;
    uint64_t frameId=0;
    id<MTLTexture>alphaSource=nil;
    unsigned outputX=0,outputY=0,outputWidth=0,outputHeight=0;
    bool flipY=false;
};
// One GPU pass performs transfer/range/primaries conversion, optional tone
// mapping, alpha handling and final quantization dither. The caller owns all
// textures, submission and completion. Preparation never advances history.
class ColorEncoder {
    struct Impl;std::shared_ptr<Impl> impl;
public:
    explicit ColorEncoder(id<MTLDevice>);~ColorEncoder();
    ShaderResult prepare(MTLPixelFormat);
    ShaderResult encode(id<MTLCommandBuffer>,id<MTLTexture>,id<MTLTexture>,const ColorConversion&);
    // Same-extent data attachments can retain auxiliary alpha by exact texel
    // load while RGB follows the usual color transform. Existing ABI unchanged.
    ShaderResult encode(id<MTLCommandBuffer>,id<MTLTexture>,id<MTLTexture>,const ColorConversion&,bool exactAlphaTexels);
};
}
