#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "color-contract.hpp"
#include "neural-node.hpp"
#include <functional>
namespace macfx {
// A bounded descriptor selects a compiled implementation. It contains no code,
// resource paths, or provider library names.
bool nativeImageUsesSDR(const ShaderSpec&);
std::shared_ptr<ShaderNode>makeNativeImageShaderNode(const ShaderSpec&,const std::string&modelPath={},const std::string&modelOperation={});
std::shared_ptr<ShaderNode>forkNativeImageShaderNode(const std::shared_ptr<ShaderNode>&,const ShaderSpec&,const std::string&modelPath={},const std::string&modelOperation={});
void setNativeImageShaderColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
ShaderResult nativeImagePreparationStatus(const std::shared_ptr<ShaderNode>&);
bool nativeImageGpuTimingAvailable(const std::shared_ptr<ShaderNode>&);
ShaderResult encodeNativeImageStamped(const std::shared_ptr<ShaderNode>&,const ShaderFrame&,const NeuralInputStamp&,bool redraw,bool displayMapped,std::function<ShaderResult()>*completion,NeuralGpuTimingTicket*timing=nullptr);
ShaderResult finishNativeImageNode(const std::shared_ptr<ShaderNode>&);
}
