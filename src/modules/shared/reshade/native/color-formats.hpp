#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
namespace macfx {
inline bool packedColorFormat(MTLPixelFormat f)noexcept{return f==MTLPixelFormatRGB10A2Unorm||f==MTLPixelFormatBGR10A2Unorm||f==MTLPixelFormatBGRA10_XR||f==MTLPixelFormatBGRA10_XR_sRGB||f==MTLPixelFormatBGR10_XR||f==MTLPixelFormatBGR10_XR_sRGB;}
inline bool extendedPackedColorFormat(MTLPixelFormat f)noexcept{return f==MTLPixelFormatBGRA10_XR||f==MTLPixelFormatBGRA10_XR_sRGB||f==MTLPixelFormatBGR10_XR||f==MTLPixelFormatBGR10_XR_sRGB;}
inline bool imageRGBFormat(MTLPixelFormat f)noexcept{return f==MTLPixelFormatBGRA8Unorm||f==MTLPixelFormatRGBA8Unorm||f==MTLPixelFormatBGRA8Unorm_sRGB||f==MTLPixelFormatRGBA8Unorm_sRGB||f==MTLPixelFormatRGBA16Float||f==MTLPixelFormatRGBA32Float||packedColorFormat(f);}
inline unsigned imageQuantizationBits(MTLPixelFormat f)noexcept{return packedColorFormat(f)?10:f==MTLPixelFormatBGRA8Unorm||f==MTLPixelFormatRGBA8Unorm||f==MTLPixelFormatBGRA8Unorm_sRGB||f==MTLPixelFormatRGBA8Unorm_sRGB?8:0;}
}
