#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
namespace macfx {
struct MagpieGeometry {uint32_t width=0,height=0;std::string error;};
std::shared_ptr<ShaderNode>makeMagpieShaderNode(const ShaderSpec&);
std::shared_ptr<ShaderNode>forkMagpieShaderNode(const std::shared_ptr<ShaderNode>&,const ShaderSpec&);
// Additive geometry query; external ShaderNode ABI1 remains unchanged.
MagpieGeometry magpieOutputGeometry(const ShaderNode*,uint32_t inputW,uint32_t inputH,uint32_t requestedW,uint32_t requestedH);
}
