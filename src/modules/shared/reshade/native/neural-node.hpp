#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include <string_view>
namespace macfx {
struct NeuralSpec {std::string modelPath;float intensity=1;bool temporal=false;};
// A neural row normalizes model input to top-left rows, then preserves the
// current stage's dimensions, declared origin and original alpha. Its optional
// provider owns model execution; the host retains command-buffer submission.
std::shared_ptr<ShaderNode> makeNeuralNode(const NeuralSpec &);
void setNeuralStatusContext(const std::shared_ptr<ShaderNode>&,uintptr_t,std::string_view stage,std::string_view revision);
ShaderResult finishNeuralNode(const std::shared_ptr<ShaderNode> &);
}
