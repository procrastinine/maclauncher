#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "color-contract.hpp"
namespace macfx {
std::shared_ptr<ShaderNode>makeFfxDofNode(const ShaderParameters&);
std::shared_ptr<ShaderNode>forkFfxDofNode(const std::shared_ptr<ShaderNode>&,const ShaderParameters&);
void setFfxDofNodeColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
ShaderResult finishFfxDofNode(const std::shared_ptr<ShaderNode>&);
}
