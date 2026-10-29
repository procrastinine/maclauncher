// Copyright (c) MacLauncher contributors. MIT license.
#pragma once
#include "effect-node.hpp"
#include "image-color.hpp"
namespace macfx {
std::shared_ptr<ShaderNode>makeScreenSpaceReflectionsNode(const ShaderParameters&);
std::shared_ptr<ShaderNode>forkScreenSpaceReflectionsNode(const std::shared_ptr<ShaderNode>&,const ShaderParameters&);
void setScreenSpaceReflectionsNodeColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
ShaderResult finishScreenSpaceReflectionsNode(const std::shared_ptr<ShaderNode>&);
}
