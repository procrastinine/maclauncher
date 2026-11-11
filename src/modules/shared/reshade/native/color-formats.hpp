#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
namespace macfx {
inline bool packedColorFormat(MTLPixelFormat f)noexcept{return f==MTLPixelFormatRGB10A2Unorm||f==MTLPixelFormatBGR10A2Unorm||f==MTLPixelFormatBGRA10_XR||f==MTLPixelFormatBGRA10_XR_sRGB||f==MTLPixelFormatBGR10_XR||f==MTLPixelFormatBGR10_XR_sRGB;}
inline bool extendedPackedColorFormat(MTLPixelFormat f)noexcept{return f==MTLPixelFormatBGRA10_XR||f==MTLPixelFormatBGRA10_XR_sRGB||f==MTLPixelFormatBGR10_XR||f==MTLPixelFormatBGR10_XR_sRGB;}
// RG11B10Float is the packed float image that renderers such as FidelityFX
// hand over for HDR scenes. It has no alpha, and every Mac GPU samples, writes
// and renders it, so it is a complete RGB image format. The ordered graph
// works on RGBA16Float copies of it.
inline bool imageRGBFormat(MTLPixelFormat f)noexcept{return f==MTLPixelFormatBGRA8Unorm||f==MTLPixelFormatRGBA8Unorm||f==MTLPixelFormatBGRA8Unorm_sRGB||f==MTLPixelFormatRGBA8Unorm_sRGB||f==MTLPixelFormatRGBA16Float||f==MTLPixelFormatRGBA32Float||packedColorFormat(f)||f==MTLPixelFormatRG11B10Float;}
// RGB9E5Float scene color is read only: GPUs other than Apple's cannot render
// it, so it is accepted as an input that is converted, never as an output.
inline bool sampledRGBFormat(MTLPixelFormat f)noexcept{return imageRGBFormat(f)||f==MTLPixelFormatRGB9E5Float;}
inline unsigned imageQuantizationBits(MTLPixelFormat f)noexcept{return packedColorFormat(f)?10:f==MTLPixelFormatBGRA8Unorm||f==MTLPixelFormatRGBA8Unorm||f==MTLPixelFormatBGRA8Unorm_sRGB||f==MTLPixelFormatRGBA8Unorm_sRGB?8:0;}
}
