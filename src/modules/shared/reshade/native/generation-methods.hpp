#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// Generated from effects/operation-contracts.mjs by generate-graphics-contracts.mjs.
#include <array>
#include <string_view>
namespace macfx {
struct GenerationMethodInfo{std::string_view id;bool scene,camera,matrices;unsigned maximumMultiplier;std::string_view gpuWorkScope;};
inline constexpr std::array<GenerationMethodInfo,6>generationMethods{{
    {"lsfg",false,false,false,5,"caller-command-buffer"},
    {"mlx-interpolation",false,false,false,5,"external-queues"},
    {"rife",false,false,false,5,"external-queues"},
    {"metalfx",true,true,false,2,"caller-command-buffer"},
    {"fsr3",true,true,false,2,"caller-command-buffer"},
    {"xess",true,false,true,2,"external-queues"}
}};
inline constexpr const GenerationMethodInfo*generationMethodInfo(std::string_view method)noexcept{for(const auto&info:generationMethods)if(info.id==method)return &info;return nullptr;}
inline constexpr bool generationRequiresScene(std::string_view method)noexcept{const auto*info=generationMethodInfo(method);return info&&info->scene;}
inline constexpr bool generationRequiresCamera(std::string_view method)noexcept{const auto*info=generationMethodInfo(method);return info&&info->camera;}
}
