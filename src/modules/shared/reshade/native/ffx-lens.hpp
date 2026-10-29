#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "color-contract.hpp"
#include <functional>
namespace macfx {
std::shared_ptr<ShaderNode>makeFfxLensNode(const ShaderParameters&);
std::shared_ptr<ShaderNode>forkFfxLensNode(const std::shared_ptr<ShaderNode>&,const ShaderParameters&);
void setFfxLensNodeColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
std::function<ShaderResult()>ffxLensCompletionTicket(const std::shared_ptr<ShaderNode>&);
ShaderResult finishFfxLensNode(const std::shared_ptr<ShaderNode>&);
}
