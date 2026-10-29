#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "color-contract.hpp"
#include "neural-node.hpp"
#include <functional>
namespace macfx {
std::shared_ptr<ShaderNode>makeHistogramExposureNode(const ShaderParameters&);
std::shared_ptr<ShaderNode>forkHistogramExposureNode(const std::shared_ptr<ShaderNode>&,const ShaderParameters&);
bool isHistogramExposureNode(const std::shared_ptr<ShaderNode>&);
void setHistogramExposureNodeColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
ShaderResult encodeHistogramExposureStamped(const std::shared_ptr<ShaderNode>&,const ShaderFrame&,const NeuralInputStamp&,bool redraw,bool displayMapped,std::function<ShaderResult()>*completion);
ShaderResult finishHistogramExposureNode(const std::shared_ptr<ShaderNode>&);
}
