#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-compute.hpp"
#include "generation-provider.hpp"
namespace macfx {
struct XessSpec {std::string backend="auto";};
std::shared_ptr<GenerationEncoder> makeXessGenerationEncoder(id<MTLDevice>,const LsfgConfig&);
using XessSceneEncoder=SceneComputeEncoder;
std::shared_ptr<XessSceneEncoder> makeXessSceneEncoder(id<MTLDevice>,const XessSpec &spec = {});
}
