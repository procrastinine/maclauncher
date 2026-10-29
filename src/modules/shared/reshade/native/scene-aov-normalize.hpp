#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-aovs.hpp"
#include "scene-matrices.hpp"
#include "effect-node.hpp"
namespace macfx {
// Normalizes only requested actual attachments. Each ROI spans the complete
// current viewport. Normal space changes require the actual view matrix;
// neither geometry nor missing material/lighting values are synthesized.
class SceneAovNormalizer {
 struct Impl;std::shared_ptr<Impl>impl;
public:
 explicit SceneAovNormalizer(id<MTLCommandQueue>);~SceneAovNormalizer();
 ShaderResult prepare(const RSSceneAovs&,unsigned width,unsigned height,uint32_t mask,
                     RSSceneAovSpace normalSpace=RS_SCENE_AOV_SPACE_WORLD,bool outputBottomLeft=false);
 RSSceneAovs layout()const;
 ShaderResult encode(id<MTLCommandBuffer>,const RSSceneAovs&,
                     const std::optional<RSSceneMatrices>&,RSSceneAovs&normalized);
};
}
