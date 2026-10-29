#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "color-conversion.hpp"
#include "generation-provider.hpp"
#include "image-admission.hpp"
#include <stdexcept>
namespace macfx {
class ColorIslandBusy:public TransientBusy{public:using TransientBusy::TransientBusy;};
// A provider's color boundary is local to that provider. The enclosing graph
// keeps its source description and precision, including independent HDR rows.
class ColorIsland {
    struct Impl;std::unique_ptr<Impl>impl;
public:
    struct Images {id<MTLTexture>input;std::vector<id<MTLTexture>>outputs;std::shared_ptr<void>lease;};
    ColorIsland(id<MTLDevice>,const ImageColorDescription&,bool sdr=true,float referenceWhite=0,std::optional<ColorPrimaries>providerPrimaries={});
    // A prepared linear provider domain, with an inverse conversion back to
    // the enclosing image's unchanged color description.
    ColorIsland(id<MTLDevice>,const ImageColorDescription&,const ImageColorDescription&linearProvider);
    ~ColorIsland();
    const ImageColorDescription&providerColor()const;
    MTLPixelFormat providerFormat()const;
    bool mapsToDisplay()const;
    ShaderResult prepare(MTLPixelFormat outputFormat);
    Images acquire(id<MTLCommandBuffer>,unsigned width,unsigned height,unsigned outputWidth,unsigned outputHeight,unsigned count=1);
    Images acquire(id<MTLCommandBuffer>,unsigned width,unsigned height,unsigned outputWidth,unsigned outputHeight,unsigned count,bool inputRequired);
    Images acquire(id<MTLCommandBuffer>,unsigned,unsigned,unsigned,unsigned,unsigned,bool inputRequired,bool retainCapacity);
    Images prepareImages(unsigned,unsigned,unsigned,unsigned,unsigned);
    Images prepareImages(unsigned,unsigned,unsigned,unsigned,unsigned,bool inputRequired);
    ShaderResult enter(id<MTLCommandBuffer>,id<MTLTexture>,const Images&,uint64_t frameId);
    ShaderResult enter(id<MTLCommandBuffer>,id<MTLTexture>,const Images&,uint64_t frameId,bool displayMapped);
    ShaderResult leave(id<MTLCommandBuffer>,id<MTLTexture>,id<MTLTexture>,uint64_t frameId,id<MTLTexture>alphaSource=nil);
};
std::shared_ptr<GenerationEncoder> makeColorIslandGenerationEncoder(id<MTLDevice>,std::shared_ptr<GenerationEncoder>,const ImageColorDescription&,bool sdr);
std::shared_ptr<GenerationEncoder> makeColorIslandGenerationEncoder(id<MTLDevice>,std::shared_ptr<GenerationEncoder>,const ImageColorDescription&,bool sdr,unsigned outputCapacity);
bool sameImageColorDescription(const ImageColorDescription&,const ImageColorDescription&)noexcept;
bool imageColorNeedsSDRIsland(const ImageColorDescription&)noexcept;
bool imageColorIsHDR(const ImageColorDescription&)noexcept;
inline SpatialColor spatialColorForDescription(const ImageColorDescription&c)noexcept{return c.transfer==ColorTransfer::Linear?(imageColorIsHDR(c)?SpatialColor::HDR:SpatialColor::Linear):SpatialColor::Perceptual;}
}
