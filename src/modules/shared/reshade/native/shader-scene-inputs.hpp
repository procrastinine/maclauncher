// Copyright (c) MacLauncher contributors. MIT license.
#pragma once
#include "shader-scene-inputs.h"
#include "effect-node.hpp"
namespace macfx {
// Scope is explicit at the common caller; it cannot leak the worker's candidate
// inputs into another thread or an accepted execution's provider call.
class ShaderSceneInputScope {
 const RSShaderSceneInputsV1*previous=nullptr;
public:
 explicit ShaderSceneInputScope(const RSShaderSceneInputsV1*);
 ~ShaderSceneInputScope();
 ShaderSceneInputScope(const ShaderSceneInputScope&)=delete;
 ShaderSceneInputScope&operator=(const ShaderSceneInputScope&)=delete;
};
const RSShaderSceneInputsV1*shaderSceneInputs(const ShaderFrame&)noexcept;
}
