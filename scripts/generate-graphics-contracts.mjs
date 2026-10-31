import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {GENERATION} from "../src/modules/shared/effects/operation-contracts.mjs";

export function generationMethodsHeader(){
  const mask=value=>(value.multipliers||[2,3,4,5].filter(factor=>factor<=value.maximumMultiplier)).reduce((bits,factor)=>bits|1<<factor,0);
  const rows=Object.entries(GENERATION).map(([id,value])=>`    {"${id}",${value.scene},${value.camera},${value.matrices},${value.maximumMultiplier},"${value.gpuWorkScope}",${value.color==="sdr"},${mask(value)}}`);
  const candidates=GENERATION.auto.candidates.map(id=>`"${id}"`);
  return `#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// Generated from effects/operation-contracts.mjs by generate-graphics-contracts.mjs.
#include <array>
#include <string_view>
namespace macfx {
struct GenerationMethodInfo{std::string_view id;bool scene,camera,matrices;unsigned maximumMultiplier;std::string_view gpuWorkScope;bool sdr;unsigned multipliers;};
inline constexpr std::array<GenerationMethodInfo,${rows.length}>generationMethods{{
${rows.join(",\n")}
}};
inline constexpr const GenerationMethodInfo*generationMethodInfo(std::string_view method)noexcept{for(const auto&info:generationMethods)if(info.id==method)return &info;return nullptr;}
inline constexpr bool generationRequiresScene(std::string_view method)noexcept{const auto*info=generationMethodInfo(method);return info&&info->scene;}
inline constexpr bool generationRequiresCamera(std::string_view method)noexcept{const auto*info=generationMethodInfo(method);return info&&info->camera;}
// Image-pair methods share the timeline's repeat and scene-cut analysis.
inline constexpr bool generationUsesImagePairs(std::string_view method)noexcept{const auto*info=generationMethodInfo(method);return info&&!info->scene;}
// The provider's color boundary is 8-bit SDR, entered through a color island.
inline constexpr bool generationUsesSDRColor(std::string_view method)noexcept{const auto*info=generationMethodInfo(method);return info&&info->sdr;}
inline constexpr bool generationAcceptsMultiplier(std::string_view method,unsigned multiplier)noexcept{const auto*info=generationMethodInfo(method);return info&&multiplier<32&&(info->multipliers>>multiplier&1u);}
inline constexpr std::array<std::string_view,${candidates.length}>automaticGenerationCandidates{${candidates.join(",")}};
}
`;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const file=path.resolve(import.meta.dirname,"../src/modules/shared/reshade/native/generation-methods.hpp"),contents=generationMethodsHeader();
  if(process.argv[2]==="--check"){
    if(fs.readFileSync(file,"utf8")!==contents)throw Error("Generate the native graphics contracts before building.");
  }else if(process.argv.length===2)fs.writeFileSync(file,contents);
  else throw Error("Usage: node scripts/generate-graphics-contracts.mjs [--check]");
}
