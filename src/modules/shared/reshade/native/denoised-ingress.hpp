#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "scene-aovs.hpp"
#include "scene-matrices.hpp"
namespace macfx {
// Called at a real SDK encode boundary. The caller supplies the actual source
// color, epoch/revision and enabled optional descriptor slots. This only reads
// metadata/resources; the caller immediately binds their completion-owned lease.
ShaderResult captureDenoisedScalerInputs(id scaler,id<MTLCommandBuffer> commands,
    void*owner,uint64_t frameId,uint32_t optionalMask,RSTemporalFrame&,
    RSSceneAovs&,RSSceneMatrices&);
}
