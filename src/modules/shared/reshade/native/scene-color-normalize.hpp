// Copyright (c) MacLauncher contributors. MIT license.
#pragma once
#include "scene-aovs.hpp"
#include "color-conversion.hpp"
namespace macfx {
// Follows spatial attachment normalization. Reflected material RGB is
// dimensionless; radiance additionally follows the actual white/exposure units.
class SceneColorNormalizer {
 struct Impl;std::shared_ptr<Impl>impl;
public:
 SceneColorNormalizer(id<MTLCommandQueue>,const ImageColorDescription&working);
 ShaderResult prepare(const RSSceneAovs&,uint32_t mask);
 ShaderResult frame(id<MTLCommandBuffer>,const RSSceneAovs&,float currentPreExposure,
                    bool encode,RSSceneAovs&result);
};
}
