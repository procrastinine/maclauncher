#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#if __has_include("temporal-scene-matrices.h")
#include "temporal-scene-matrices.h"
#else
#include "../temporal/scene-matrices.h"
#endif
#include <optional>
namespace macfx {
std::optional<RSSceneMatrices> temporalSceneMatrices(const RSTemporalFrame&);
// A full-viewport scale leaves projection unchanged. When matching color has
// been dejittered, remove only the declared sample offset from a projection
// that already contains it, retaining authored off-center/ortho terms.
std::optional<RSSceneMatrices> sceneMatricesForImage(const RSTemporalFrame&,
    const std::optional<RSSceneMatrices>&,bool colorJittered,bool bottomLeft=false);
// Consume one unambiguous producer registration and associate it with the real
// command-buffer scene. A miss leaves the scene without invented matrices.
int bindTemporalMatricesForTextures(const RSTemporalFrame&);
std::optional<RSSceneMatrices>takeTemporalMatricesForTextures(const RSTemporalFrame&);
uint32_t temporalSceneInputMask(const RSTemporalFrame&)noexcept;
}
