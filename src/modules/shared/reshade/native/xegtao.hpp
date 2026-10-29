#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "image-color.hpp"
namespace macfx {
std::shared_ptr<ShaderNode> makeXegtaoNode(const ShaderParameters&);
std::shared_ptr<ShaderNode> forkXegtaoNode(const std::shared_ptr<ShaderNode>&,const ShaderParameters&);
void setXegtaoNodeColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
}
