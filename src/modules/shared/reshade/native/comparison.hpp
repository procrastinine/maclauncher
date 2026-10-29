#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "output-policy.hpp"
#include "color-contract.hpp"
namespace macfx {
// Both textures are from the same admitted source event. The caller aligns
// their color/displayMapped domains before the one final output conversion.
class ComparisonEncoder {
 struct Impl;std::shared_ptr<Impl>impl;
public:
 ComparisonEncoder();~ComparisonEncoder();
 ShaderResult prepare(id<MTLDevice>,MTLPixelFormat);
 ShaderResult encode(id<MTLCommandBuffer>,id<MTLTexture>raw,id<MTLTexture>processed,id<MTLTexture>target,const ComparisonSettings&);
 // before/after/target are separate admitted RGBA16F images. Both sides enter
 // one linear output domain; the caller performs final conversion/dither once.
 ShaderResult encodeAligned(id<MTLCommandBuffer>,id<MTLTexture>raw,id<MTLTexture>processed,
   id<MTLTexture>before,id<MTLTexture>after,id<MTLTexture>target,const ComparisonSettings&,
   const ImageColorDescription&sourceColor,const ImageColorDescription&targetDisplayColor,
   bool rawMapped,bool processedMapped,uint64_t frameId,ImageColorDescription*encodedColor=nullptr,
   std::string_view toneMapping="auto",std::string_view*policyReason=nullptr);
};
}
