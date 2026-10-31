#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// Generated from effects/operation-contracts.mjs by generate-graphics-contracts.mjs.
#include <array>
#include <string_view>
namespace macfx {
struct GenerationMethodInfo{std::string_view id;bool scene,camera,matrices;unsigned maximumMultiplier;std::string_view gpuWorkScope;bool sdr;unsigned multipliers;};
inline constexpr std::array<GenerationMethodInfo,10>generationMethods{{
    {"lsfg",false,false,false,5,"caller-command-buffer",false,60},
    {"mlx-interpolation",false,false,false,5,"external-queues",true,60},
    {"rife",false,false,false,5,"external-queues",true,60},
    {"metalfx",true,true,false,2,"caller-command-buffer",false,4},
    {"fsr3",true,true,false,2,"caller-command-buffer",false,4},
    {"xess",true,false,true,2,"external-queues",false,4},
    {"vt-interpolation",false,false,false,4,"external-queues",true,20},
    {"metalfx-image",false,false,false,2,"external-queues",false,4},
    {"vision-flow",false,false,false,5,"external-queues",false,60},
    {"auto",false,false,false,5,"external-queues",true,60}
}};
inline constexpr const GenerationMethodInfo*generationMethodInfo(std::string_view method)noexcept{for(const auto&info:generationMethods)if(info.id==method)return &info;return nullptr;}
inline constexpr bool generationRequiresScene(std::string_view method)noexcept{const auto*info=generationMethodInfo(method);return info&&info->scene;}
inline constexpr bool generationRequiresCamera(std::string_view method)noexcept{const auto*info=generationMethodInfo(method);return info&&info->camera;}
// Image-pair methods share the timeline's repeat and scene-cut analysis.
inline constexpr bool generationUsesImagePairs(std::string_view method)noexcept{const auto*info=generationMethodInfo(method);return info&&!info->scene;}
// The provider's color boundary is 8-bit SDR, entered through a color island.
inline constexpr bool generationUsesSDRColor(std::string_view method)noexcept{const auto*info=generationMethodInfo(method);return info&&info->sdr;}
inline constexpr bool generationAcceptsMultiplier(std::string_view method,unsigned multiplier)noexcept{const auto*info=generationMethodInfo(method);return info&&multiplier<32&&(info->multipliers>>multiplier&1u);}
inline constexpr std::array<std::string_view,3>automaticGenerationCandidates{"vt-interpolation","metalfx-image","vision-flow"};
}
