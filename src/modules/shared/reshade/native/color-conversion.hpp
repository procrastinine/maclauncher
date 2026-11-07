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
// Nonretaining producer buffers still need these exact resources until their
// encoded conversion completes or the unsubmitted buffer is destroyed. The
// lease never owns its command buffer, so an abandoned capture cannot cycle.
inline void retainColorConversion(id<MTLCommandBuffer>commands,std::shared_ptr<void>owner,id<MTLTexture>input,id<MTLTexture>output,id<MTLTexture>alpha,id<MTLRenderPipelineState>pipeline){
    if(commands.retainedReferences)return;
    struct Flight {std::shared_ptr<void>owner;id<MTLTexture>input,output,alpha;id<MTLRenderPipelineState>pipeline;};
    auto flight=std::make_shared<Flight>(Flight{std::move(owner),input,output,alpha,pipeline});
    [commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)flight;}];
}
// One GPU pass performs transfer/range/primaries conversion, optional tone
// mapping, alpha handling and final quantization dither. The caller owns
// submission and completion; nonretaining commands get a finite resource
// lease. Preparation never advances history.
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
