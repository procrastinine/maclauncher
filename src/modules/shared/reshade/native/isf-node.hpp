#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "shader-scene-inputs.h"
namespace macfx {
std::shared_ptr<ShaderNode>makeISFShaderNode(const ShaderSpec&);
std::shared_ptr<ShaderNode>forkISFShaderNode(const std::shared_ptr<ShaderNode>&,const ShaderSpec&);
ShaderResult bindISFSceneInputs(const std::shared_ptr<ShaderNode>&,const RSShaderSceneInputsV1*);
}
