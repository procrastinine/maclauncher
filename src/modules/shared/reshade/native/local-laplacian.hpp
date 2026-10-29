#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "color-contract.hpp"
namespace macfx {
// Eight-level fast local Laplacian with float32 Gaussian/Laplacian pyramids.
// Parameters: Detail (default 1), Contrast (1), Samples (8 intensity samples).
std::shared_ptr<ShaderNode> makeLocalLaplacianNode(const ShaderParameters&);
std::shared_ptr<ShaderNode> forkLocalLaplacianNode(const std::shared_ptr<ShaderNode>&,const ShaderParameters&);
void setLocalLaplacianNodeColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
}
