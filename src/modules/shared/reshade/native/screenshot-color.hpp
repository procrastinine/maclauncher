#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// Frame capture writes 8-bit RGB images. The presenter converts any other
// output, such as float, 10-bit, PQ or HLG, once to 8-bit sRGB before capture.
#import <Metal/Metal.h>
#include "color-contract.hpp"
namespace macfx {
inline bool captureWritesFormat(MTLPixelFormat format)noexcept{
    return format==MTLPixelFormatBGRA8Unorm||format==MTLPixelFormatBGRA8Unorm_sRGB||format==MTLPixelFormatRGBA8Unorm||format==MTLPixelFormatRGBA8Unorm_sRGB;
}
// sRGB at the output's reference white, so SDR content keeps its levels and
// Automatic mapping compresses only what the output holds above that white.
inline ImageColorDescription screenshotColor(const ImageColorDescription&output)noexcept{
    ImageColorDescription sdr;sdr.referenceWhite=sdr.peakLuminance=std::isfinite(output.referenceWhite)&&output.referenceWhite>0?output.referenceWhite:203;return sdr;
}
}
