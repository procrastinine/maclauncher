#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "color-conversion.hpp"
#include <string_view>
namespace macfx {
struct OutputColorMapping {
 ColorToneMap toneMap=ColorToneMap::Preserve;
 std::string_view active="preserve",reason;
};
// Mapping precedes final encoding/dither. A display-mapped intermediate cannot
// recover scene highlights or satisfy another scene-referred mapping request.
inline OutputColorMapping outputColorMapping(std::string_view requested,
 const ImageColorDescription&source,const ImageColorDescription&target,bool mapped) noexcept {
 const auto automatic=[&]()->OutputColorMapping{
  if(mapped||source.peakLuminance<=target.peakLuminance)return {};
  return source.sceneReferred?OutputColorMapping{ColorToneMap::PBRNeutral,"pbr-neutral",{}}:
   OutputColorMapping{ColorToneMap::Reinhard,"reinhard",{}};
 };
 if(requested=="pbr-neutral"&&(!source.sceneReferred||mapped)){
  auto value=automatic();value.reason=mapped?
   "PBR Neutral requires unmapped scene-referred input; Automatic output is retained":
   "PBR Neutral requires scene-referred source metadata; Automatic output is retained";
  return value;
 }
 if(mapped||requested=="preserve")return {};
 if(requested=="reinhard")return {ColorToneMap::Reinhard,"reinhard",{}};
 if(requested=="pbr-neutral")return {ColorToneMap::PBRNeutral,"pbr-neutral",{}};
 return automatic();
}
}
