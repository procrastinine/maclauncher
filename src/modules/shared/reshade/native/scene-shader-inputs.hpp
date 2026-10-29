// Copyright (c) MacLauncher contributors. MIT license.
#pragma once
#include "shader-scene-inputs.hpp"
#include "scene-aov-normalize.hpp"
#include "color-contract.hpp"
#include <map>
namespace macfx {
struct SceneShaderInputFrame {
 RSShaderSceneInputsV1 value{};std::shared_ptr<void>storage;
};
// Per-row prepared resources follow its actual queue and current coordinate
// extent. All image allocations and pipeline creation occur in prepare().
class SceneShaderInputs {
 struct Impl;std::shared_ptr<Impl>impl;
public:
 SceneShaderInputs(id<MTLCommandQueue>,const std::map<std::string,uint32_t>&,
                   const std::optional<ImageColorDescription>&linearWorking={});
 ShaderResult prepare(const ShaderFrame&,const RSTemporalFrame&,
                      const std::optional<RSSceneMatrices>&,
                      const std::shared_ptr<const SceneAovLease>&);
 ShaderResult frame(const ShaderFrame&,const RSTemporalFrame&,
                    const std::optional<RSSceneMatrices>&,
                    const std::shared_ptr<const SceneAovLease>&,
                    bool encode,SceneShaderInputFrame&);
};
}
