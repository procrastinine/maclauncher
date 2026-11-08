#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// Screenshot encoding follows the HDR PNG approach in MacShade (BSD-3-Clause;
// macshade-BSD-3-Clause.txt): BT.2020 PQ, 16-bit RGB for HDR; 8-bit sRGB for SDR.
// The shared color converter handles the source transfer, primaries and white.
#import <Metal/Metal.h>
#include "color-contract.hpp"
#include <algorithm>
#import <objc/runtime.h>
namespace macfx {
inline bool captureWritesFormat(MTLPixelFormat format)noexcept{
    return format==MTLPixelFormatBGRA8Unorm||format==MTLPixelFormatBGRA8Unorm_sRGB||format==MTLPixelFormatRGBA8Unorm||format==MTLPixelFormatRGBA8Unorm_sRGB;
}
inline bool screenshotHDR(const ImageColorDescription&color)noexcept{
    return color.transfer==ColorTransfer::PQ||color.transfer==ColorTransfer::HLG||color.peakLuminance>color.referenceWhite;
}
inline MTLPixelFormat screenshotFormat(const ImageColorDescription&color)noexcept{return screenshotHDR(color)?MTLPixelFormatRGBA16Unorm:MTLPixelFormatRGBA8Unorm;}
// Only images converted by ScreenshotImage carry this marker. An arbitrary
// 16-bit source must not be misidentified as already encoded BT.2020 PQ.
inline char screenshotHDRKey;
inline bool screenshotHDRTexture(id<MTLTexture>texture)noexcept{return texture&&texture.pixelFormat==MTLPixelFormatRGBA16Unorm&&objc_getAssociatedObject(texture,&screenshotHDRKey)!=nil;}
inline void markScreenshotHDR(id<MTLTexture>texture){objc_setAssociatedObject(texture,&screenshotHDRKey,@YES,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
inline bool captureWritesTexture(id<MTLTexture>texture)noexcept{return texture&&(captureWritesFormat(texture.pixelFormat)||screenshotHDRTexture(texture));}
inline ImageColorDescription screenshotColor(const ImageColorDescription&output)noexcept{
    ImageColorDescription result;result.referenceWhite=std::isfinite(output.referenceWhite)&&output.referenceWhite>0?output.referenceWhite:203;
    result.peakLuminance=result.referenceWhite;
    if(screenshotHDR(output)){result.primaries=ColorPrimaries::BT2020;result.transfer=ColorTransfer::PQ;result.alpha=ColorAlpha::Opaque;result.peakLuminance=std::max(result.referenceWhite,output.peakLuminance);}
    return result;
}
}
