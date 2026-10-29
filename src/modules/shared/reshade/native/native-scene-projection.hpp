#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "native-scene.hpp"
#include <cmath>
#include <cstring>
#include <stdexcept>
namespace macfx {
// CPU metadata only; frame pixels and guide conversion remain GPU operations.
struct SceneProjectionConstants {
  float projection[16], inverse[16], jitterSign[4];
  uint32_t depthROI[4];
  float clip[4];
};
static_assert(sizeof(SceneProjectionConstants) == 176);
inline bool invertSceneProjection(const float *input, float *output) {
  double a[4][8]{};
  for (unsigned i = 0; i < 4; i++)
    for (unsigned j = 0; j < 4; j++) {
      if (!std::isfinite(input[i * 4 + j]))
        return false;
      a[i][j] = input[i * 4 + j];
      a[i][j + 4] = i == j;
    }
  for (unsigned c = 0; c < 4; c++) {
    unsigned pivot = c;
    for (unsigned r = c + 1; r < 4; r++)
      if (std::abs(a[r][c]) > std::abs(a[pivot][c]))
        pivot = r;
    if (std::abs(a[pivot][c]) < 1e-15)
      return false;
    for (unsigned j = 0; j < 8; j++)
      std::swap(a[c][j], a[pivot][j]);
    double d = a[c][c];
    for (unsigned j = 0; j < 8; j++)
      a[c][j] /= d;
    for (unsigned r = 0; r < 4; r++)
      if (r != c) {
        double v = a[r][c];
        for (unsigned j = 0; j < 8; j++)
          a[r][j] -= v * a[c][j];
      }
  }
  for (unsigned i = 0; i < 4; i++)
    for (unsigned j = 0; j < 4; j++) {
      output[i * 4 + j] = float(a[i][j + 4]);
      if (!std::isfinite(output[i * 4 + j]))
        return false;
    }
  return true;
}
inline std::string
sceneProjectionReason(const ShaderFrame &f, const RSTemporalFrame *scene,
                      const std::optional<RSSceneMatrices> &m) {
  if (!scene || !scene->depth)
    return "Matching renderer depth is required";
  if (!m || !(m->flags & RS_SCENE_PROJECTION_VALID))
    return "The actual scene projection matrix is required";
  const uint32_t clip =
      m->flags & (RS_SCENE_CLIP_ZERO_TO_ONE | RS_SCENE_CLIP_MINUS_ONE_TO_ONE);
  if (clip != RS_SCENE_CLIP_ZERO_TO_ONE &&
      clip != RS_SCENE_CLIP_MINUS_ONE_TO_ONE)
    return "The projection's explicit depth clip range is required";
  if (scene->frameId != m->frameId || scene->commandBufferKind ||
      scene->commandBuffer != (__bridge void *)f.commands)
    return "Depth and projection must belong to the current scene commands";
  if (scene->renderWidth != f.source.width ||
      scene->renderHeight != f.source.height)
    return "Depth and projection must align to the current image extent";
  auto depth = (__bridge id<MTLTexture>)scene->depth;
  if (depth.device != f.commands.device ||
      depth.textureType != MTLTextureType2D || depth.sampleCount != 1 ||
      depth.framebufferOnly ||
      (depth.usage != MTLTextureUsageUnknown &&
       !(depth.usage & MTLTextureUsageShaderRead)) ||
      uint64_t(scene->depthX) + scene->renderWidth > depth.width ||
      uint64_t(scene->depthY) + scene->renderHeight > depth.height)
    return "Readable resolved depth must cover the current image";
  if (!std::isfinite(scene->jitterX) || !std::isfinite(scene->jitterY))
    return "Scene sample jitter must be finite";
  float inverse[16];
  if (!invertSceneProjection(m->projection, inverse))
    return "The scene projection must be finite and invertible";
  return {};
}
inline SceneProjectionConstants
sceneProjectionConstants(const ShaderFrame &f, const RSTemporalFrame &scene,
                         const RSSceneMatrices &m, float strength = 1) {
  SceneProjectionConstants c{};
  std::memcpy(c.projection, m.projection, 64);
  if (!invertSceneProjection(m.projection, c.inverse))
    throw std::invalid_argument("Invalid scene projection");
  float z = c.inverse[10] * .5f + c.inverse[14],
        w = c.inverse[11] * .5f + c.inverse[15];
  if (!std::isfinite(z / w) || z / w == 0) {
    z = c.inverse[10] * .25f + c.inverse[14];
    w = c.inverse[11] * .25f + c.inverse[15];
  }
  if (!std::isfinite(z / w) || z / w == 0)
    throw std::invalid_argument(
        "The projection has no finite forward view ray");
  const bool bottom = f.origin == FrameOrigin::BottomLeft;
  const bool jittered = (m.flags & RS_SCENE_PROJECTION_JITTERED) != 0;
  c.jitterSign[0] = jittered ? 0 : scene.jitterX;
  c.jitterSign[1] = jittered ? 0 : (bottom ? -scene.jitterY : scene.jitterY);
  c.jitterSign[2] = z / w > 0 ? 1 : -1;
  c.jitterSign[3] = float((bottom ? 1u : 0u) |
                          ((m.flags & RS_SCENE_PROJECTION_Y_DOWN) ? 2u : 0u));
  c.depthROI[0] = scene.depthX;
  c.depthROI[1] = scene.depthY;
  c.depthROI[2] = scene.renderWidth;
  c.depthROI[3] = scene.renderHeight;
  c.clip[0] = (m.flags & RS_SCENE_CLIP_MINUS_ONE_TO_ONE) ? 2 : 1;
  c.clip[1] = (m.flags & RS_SCENE_CLIP_MINUS_ONE_TO_ONE) ? -1 : 0;
  c.clip[2] = strength;
  const bool standard = m.projection[1] == 0 && m.projection[3] == 0 &&
                        m.projection[4] == 0 && m.projection[7] == 0 &&
                        m.projection[0] != 0 && m.projection[5] != 0;
  const bool orthographic = m.projection[3] == 0 && m.projection[7] == 0 &&
                            m.projection[11] == 0 && m.projection[15] != 0;
  c.clip[3] = float((standard ? 1u : 0u) | (orthographic ? 2u : 0u));
  return c;
}
} // namespace macfx
