#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "image-color.hpp"
namespace macfx {
std::shared_ptr<ShaderNode> makeCacaoNode(const ShaderParameters &);
std::shared_ptr<ShaderNode> forkCacaoNode(const std::shared_ptr<ShaderNode> &,
                                          const ShaderParameters &);
void setCacaoNodeColor(const std::shared_ptr<ShaderNode> &,
                       const ImageColorDescription &);
} // namespace macfx
