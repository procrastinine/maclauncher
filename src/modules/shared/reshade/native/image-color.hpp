#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "image-color.h"
#include "color-contract.hpp"
#include <stdexcept>
namespace macfx {
inline ImageColorDescription readImageColor(const RSImageColorDescription&value){
 if(value.size<sizeof(value)||value.version!=1||value.primaries>RS_COLOR_BT2020||value.transfer>RS_COLOR_CAMERA_BT709||value.range>RS_COLOR_LIMITED||value.alpha>RS_COLOR_OPAQUE||value.flags&~RS_COLOR_SCENE_REFERRED||value.reserved)throw std::runtime_error("Invalid explicit image color metadata");
 ImageColorDescription c;c.primaries=ColorPrimaries(value.primaries);c.transfer=ColorTransfer(value.transfer);c.range=ColorRange(value.range);c.alpha=ColorAlpha(value.alpha);c.referenceWhite=value.referenceWhite;c.peakLuminance=value.peakLuminance;c.blackLuminance=value.blackLuminance;c.hlgSystemGamma=value.hlgSystemGamma;c.sceneReferred=value.flags&RS_COLOR_SCENE_REFERRED;if(!c.valid())throw std::runtime_error("Invalid explicit image luminance metadata");return c;
}
inline RSImageColorDescription writeImageColor(const ImageColorDescription&c){return {sizeof(RSImageColorDescription),1,unsigned(c.primaries),unsigned(c.transfer),unsigned(c.range),unsigned(c.alpha),c.referenceWhite,c.peakLuminance,c.blackLuminance,c.hlgSystemGamma,c.sceneReferred?RS_COLOR_SCENE_REFERRED:0u,0};}
inline ImageColorSpace imageColorLabel(const ImageColorDescription&c)noexcept{
 if(c.transfer==ColorTransfer::PQ)return c.primaries==ColorPrimaries::DisplayP3?ImageColorSpace::DisplayP3PQ:ImageColorSpace::BT2100PQ;
 if(c.transfer==ColorTransfer::HLG)return c.primaries==ColorPrimaries::DisplayP3?ImageColorSpace::DisplayP3HLG:ImageColorSpace::BT2100HLG;
 if(c.transfer==ColorTransfer::Linear)return c.primaries==ColorPrimaries::DisplayP3?ImageColorSpace::ExtendedDisplayP3:c.primaries==ColorPrimaries::BT2020?ImageColorSpace::ExtendedLinearBT2020:ImageColorSpace::ExtendedSRGB;
 return c.primaries==ColorPrimaries::DisplayP3?ImageColorSpace::DisplayP3:ImageColorSpace::SRGB;
}
}
