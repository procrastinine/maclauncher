#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "scene-matrices.hpp"
#include <cmath>

namespace macfx {
// XeSS-FG's frame-constant contract requires row-major matrices without sample
// jitter (XeSS SDK doc/xess_fg_developer_guide_english.md, Frame Constants).
// Its D3D12 resources use texture-row coordinates and normalized [0,1] depth.
// Transform only explicitly declared representation differences. The real view,
// handedness, reverse-Z and authored off-center/orthographic terms are
// retained.
inline std::optional<RSSceneMatrices>
xessGenerationMatrices(const RSTemporalFrame &scene,
                       const std::optional<RSSceneMatrices> &matrices,
                       FrameOrigin origin) {
  const bool bottom = origin == FrameOrigin::BottomLeft;
  auto result = sceneMatricesForImage(scene, matrices, false, bottom);
  if (!result)
    return {};
  // The helper's row zero is its top texture row. A bottom-origin producer
  // keeps its GPU pixels unchanged; the copied projection describes those
  // same rows rather than requiring an extra full-image flip.
  if (bool(result->flags & RS_SCENE_PROJECTION_Y_DOWN) != bottom)
    for (unsigned row = 0; row < 4; ++row)
      result->projection[row * 4 + 1] = -result->projection[row * 4 + 1];
  result->flags &= ~uint32_t(RS_SCENE_PROJECTION_Y_DOWN);
  if (result->flags & RS_SCENE_CLIP_MINUS_ONE_TO_ONE) {
    for (unsigned row = 0; row < 4; ++row)
      result->projection[row * 4 + 2] = .5f * (result->projection[row * 4 + 2] +
                                               result->projection[row * 4 + 3]);
    result->flags =
        (result->flags & ~uint32_t(RS_SCENE_CLIP_MINUS_ONE_TO_ONE)) |
        RS_SCENE_CLIP_ZERO_TO_ONE;
  }
  // Legacy declarations without clip flags already use the SDK convention;
  // no depth range is inferred for them or invented in the public binding.
  for (float value : result->projection)
    if (!std::isfinite(value))
      return {};
  return result;
}
} // namespace macfx
