#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <CoreGraphics/CoreGraphics.h>
#include <string_view>
namespace macfx {
enum class ImageColorSpace {LegacySDR,SRGB,DisplayP3,Unsupported};
inline ImageColorSpace imageColorSpace(CGColorSpaceRef space,bool extended=false)noexcept{
    if(extended)return ImageColorSpace::Unsupported;
    if(!space)return ImageColorSpace::LegacySDR;
    const auto name=CGColorSpaceCopyName(space);if(!name)return ImageColorSpace::Unsupported;
    const auto result=CFEqual(name,kCGColorSpaceSRGB)?ImageColorSpace::SRGB:
        CFEqual(name,kCGColorSpaceDisplayP3)?ImageColorSpace::DisplayP3:ImageColorSpace::Unsupported;
    CFRelease(name);return result;
}
inline bool sameImageColorSpace(CGColorSpaceRef a,CGColorSpaceRef b)noexcept{return a==b||(a&&b&&CFEqual(a,b));}
inline bool modelColorSupported(ImageColorSpace space)noexcept{return space==ImageColorSpace::LegacySDR||space==ImageColorSpace::SRGB;}
inline std::string_view imageColorReason(ImageColorSpace space)noexcept{
    return space==ImageColorSpace::DisplayP3?"This model stage requires sRGB input; the Display P3 image is preserved for compatible stages":
        space==ImageColorSpace::Unsupported?"The source color space or extended range is unsupported; original rendering is preserved":
        space==ImageColorSpace::LegacySDR?"The publisher has no color-space tag; its existing SDR interpretation is retained":"";
}
}
