#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-compute.hpp"
namespace macfx {
std::shared_ptr<SceneComputeEncoder> makeMetalFxDenoisedEncoder(id<MTLDevice>);
uint32_t metalFxDenoisedAovDemand()noexcept;
}
