#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "color-contract.hpp"
namespace macfx {
std::shared_ptr<ShaderNode> makeDepthFogNode(const ShaderParameters&);
std::shared_ptr<ShaderNode> forkDepthFogNode(const std::shared_ptr<ShaderNode>&,const ShaderParameters&);
void setDepthFogNodeColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
std::shared_ptr<ShaderNode> makeDepthOutlinesNode(const ShaderParameters&);
std::shared_ptr<ShaderNode> forkDepthOutlinesNode(const std::shared_ptr<ShaderNode>&,const ShaderParameters&);
void setDepthOutlinesNodeColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
}
