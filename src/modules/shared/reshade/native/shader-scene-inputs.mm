// Copyright (c) MacLauncher contributors. MIT license.
#include "shader-scene-inputs.hpp"
namespace macfx {namespace {thread_local const RSShaderSceneInputsV1*current=nullptr;}
ShaderSceneInputScope::ShaderSceneInputScope(const RSShaderSceneInputsV1*p):previous(current){current=p;}
ShaderSceneInputScope::~ShaderSceneInputScope(){current=previous;}
const RSShaderSceneInputsV1*shaderSceneInputs(const ShaderFrame&f)noexcept{
 const auto*p=current;return p&&p->size>=sizeof(*p)&&p->version==1&&p->commandBuffer==(__bridge void*)f.commands&&p->source==(__bridge void*)f.source&&p->target==(__bridge void*)f.target&&p->frameId==f.frameId?p:nullptr;
}
}
extern "C" uint32_t rsShaderSceneInputsAPI(){return RS_SHADER_SCENE_ABI_VERSION;}
