#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "color-contract.hpp"
#include <functional>
namespace macfx {
std::shared_ptr<ShaderNode>makeFfxBlurNode(const ShaderParameters&);
std::shared_ptr<ShaderNode>forkFfxBlurNode(const std::shared_ptr<ShaderNode>&,const ShaderParameters&);
void setFfxBlurNodeColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
std::function<ShaderResult()>ffxBlurCompletionTicket(const std::shared_ptr<ShaderNode>&);
ShaderResult finishFfxBlurNode(const std::shared_ptr<ShaderNode>&);
}
