#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <CoreGraphics/CoreGraphics.h>
#include <string_view>
#include <cmath>
namespace macfx {
enum class ImageColorSpace {LegacySDR,SRGB,DisplayP3,Unsupported,ExtendedSRGB,ExtendedDisplayP3,BT2100PQ,BT2100HLG,LinearSRGB,LinearDisplayP3,ExtendedNonlinearSRGB,ExtendedNonlinearDisplayP3,LinearBT2020,ExtendedLinearBT2020,DisplayP3PQ,DisplayP3HLG};
enum class ColorPrimaries { BT709, DisplayP3, BT2020 };
enum class ColorTransfer { SRGB, Linear, PQ, HLG, BT709 };
enum class ColorRange { Full, Limited };
enum class ColorAlpha { Straight, Premultiplied, Opaque };
struct ImageColorDescription {
    ColorPrimaries primaries=ColorPrimaries::BT709;
    ColorTransfer transfer=ColorTransfer::SRGB;
    ColorRange range=ColorRange::Full;
    ColorAlpha alpha=ColorAlpha::Straight;
    // Linear 1.0 denotes reference white. PQ remains absolute; conversion
    // divides its 10000-nit EOTF by this explicitly supplied reference white.
    float referenceWhite=203,peakLuminance=203,blackLuminance=0,hlgSystemGamma=1.2f;
    bool sceneReferred=false;
    bool valid()const noexcept{return unsigned(primaries)<=unsigned(ColorPrimaries::BT2020)&&unsigned(transfer)<=unsigned(ColorTransfer::BT709)&&unsigned(range)<=unsigned(ColorRange::Limited)&&unsigned(alpha)<=unsigned(ColorAlpha::Opaque)&&std::isfinite(referenceWhite)&&referenceWhite>0&&referenceWhite<=10000&&std::isfinite(peakLuminance)&&peakLuminance>=referenceWhite&&peakLuminance<=10000&&std::isfinite(blackLuminance)&&blackLuminance>=0&&blackLuminance<referenceWhite&&std::isfinite(hlgSystemGamma)&&hlgSystemGamma>=1&&hlgSystemGamma<=2;}
};
inline ImageColorDescription describeImageColor(ImageColorSpace space)noexcept{
    ImageColorDescription color;
    if(space==ImageColorSpace::DisplayP3||space==ImageColorSpace::ExtendedDisplayP3||space==ImageColorSpace::LinearDisplayP3||space==ImageColorSpace::ExtendedNonlinearDisplayP3||space==ImageColorSpace::DisplayP3PQ||space==ImageColorSpace::DisplayP3HLG)color.primaries=ColorPrimaries::DisplayP3;
    if(space==ImageColorSpace::ExtendedSRGB||space==ImageColorSpace::ExtendedDisplayP3){color.transfer=ColorTransfer::Linear;color.peakLuminance=1000;}
    if(space==ImageColorSpace::LinearSRGB||space==ImageColorSpace::LinearDisplayP3)color.transfer=ColorTransfer::Linear;
    if(space==ImageColorSpace::ExtendedNonlinearSRGB||space==ImageColorSpace::ExtendedNonlinearDisplayP3)color.peakLuminance=1000;
    if(space==ImageColorSpace::LinearBT2020||space==ImageColorSpace::ExtendedLinearBT2020){color.primaries=ColorPrimaries::BT2020;color.transfer=ColorTransfer::Linear;if(space==ImageColorSpace::ExtendedLinearBT2020)color.peakLuminance=1000;}
    if(space==ImageColorSpace::BT2100PQ||space==ImageColorSpace::BT2100HLG){color.primaries=ColorPrimaries::BT2020;color.transfer=space==ImageColorSpace::BT2100PQ?ColorTransfer::PQ:ColorTransfer::HLG;color.peakLuminance=1000;}
    if(space==ImageColorSpace::DisplayP3PQ||space==ImageColorSpace::DisplayP3HLG){color.transfer=space==ImageColorSpace::DisplayP3PQ?ColorTransfer::PQ:ColorTransfer::HLG;color.peakLuminance=1000;}
    return color;
}
inline ImageColorSpace imageColorSpace(CGColorSpaceRef space,bool extended=false)noexcept{
    if(!space)return extended?ImageColorSpace::Unsupported:ImageColorSpace::LegacySDR;
    const auto name=CGColorSpaceCopyName(space);if(!name)return ImageColorSpace::Unsupported;
    const auto result=CFEqual(name,kCGColorSpaceSRGB)?(extended?ImageColorSpace::ExtendedNonlinearSRGB:ImageColorSpace::SRGB):
        CFEqual(name,kCGColorSpaceDisplayP3)?(extended?ImageColorSpace::ExtendedNonlinearDisplayP3:ImageColorSpace::DisplayP3):
        CFEqual(name,kCGColorSpaceExtendedSRGB)?ImageColorSpace::ExtendedNonlinearSRGB:
        CFEqual(name,kCGColorSpaceExtendedDisplayP3)?ImageColorSpace::ExtendedNonlinearDisplayP3:
        CFEqual(name,kCGColorSpaceLinearSRGB)?ImageColorSpace::LinearSRGB:
        CFEqual(name,kCGColorSpaceLinearDisplayP3)?ImageColorSpace::LinearDisplayP3:
        CFEqual(name,kCGColorSpaceLinearITUR_2020)?ImageColorSpace::LinearBT2020:
        CFEqual(name,kCGColorSpaceExtendedLinearITUR_2020)?ImageColorSpace::ExtendedLinearBT2020:
        CFEqual(name,kCGColorSpaceExtendedLinearSRGB)?ImageColorSpace::ExtendedSRGB:
        CFEqual(name,kCGColorSpaceExtendedLinearDisplayP3)?ImageColorSpace::ExtendedDisplayP3:
        CFEqual(name,kCGColorSpaceITUR_2100_PQ)?ImageColorSpace::BT2100PQ:
        CFEqual(name,kCGColorSpaceITUR_2100_HLG)?ImageColorSpace::BT2100HLG:
        CFEqual(name,kCGColorSpaceDisplayP3_PQ)?ImageColorSpace::DisplayP3PQ:
        CFEqual(name,kCGColorSpaceDisplayP3_HLG)?ImageColorSpace::DisplayP3HLG:ImageColorSpace::Unsupported;
    CFRelease(name);return result;
}
inline bool sameImageColorSpace(CGColorSpaceRef a,CGColorSpaceRef b)noexcept{return a==b||(a&&b&&CFEqual(a,b));}
inline bool modelColorSupported(ImageColorSpace space)noexcept{return space==ImageColorSpace::LegacySDR||space==ImageColorSpace::SRGB;}
inline std::string_view imageColorReason(ImageColorSpace space)noexcept{
    return space==ImageColorSpace::DisplayP3?"This model stage requires sRGB input; the Display P3 image is preserved for compatible stages":
        space==ImageColorSpace::Unsupported?"The source color space or extended range is unsupported; original rendering is preserved":
        space==ImageColorSpace::LegacySDR?"The publisher has no color-space tag; its existing SDR interpretation is retained":
        modelColorSupported(space)?"":"This model stage requires an sRGB conversion of the HDR image";
}
}
