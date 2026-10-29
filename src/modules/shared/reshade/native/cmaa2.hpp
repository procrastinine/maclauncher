#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "color-contract.hpp"
namespace macfx {
std::shared_ptr<ShaderNode> makeCmaa2Node(const ShaderParameters&);
std::shared_ptr<ShaderNode> forkCmaa2Node(const std::shared_ptr<ShaderNode>&,const ShaderParameters&);
void setCmaa2NodeColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
}
