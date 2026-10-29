#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "color-contract.hpp"
#include "neural-node.hpp"
#include <functional>
namespace macfx {
// Relative-depth range is stabilized on the GPU, without blending depth pixels.
// Only complete real content advances the two scalar bounds. Redraw/synthetic
// images retain history; source-contract/epoch changes reset it. Visual cut
// detection is an image estimate, not an engine camera-cut signal.
std::shared_ptr<ShaderNode>makeEstimatedDepthFogNode(const ShaderParameters&,const std::string&modelPath);
std::shared_ptr<ShaderNode>forkEstimatedDepthFogNode(const std::shared_ptr<ShaderNode>&,const ShaderParameters&,const std::string&modelPath);
void setEstimatedDepthFogNodeColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
ShaderResult estimatedDepthFogPreparationStatus(const std::shared_ptr<ShaderNode>&);
bool estimatedDepthFogGpuTimingAvailable(const std::shared_ptr<ShaderNode>&);
ShaderResult encodeEstimatedDepthFogStamped(const std::shared_ptr<ShaderNode>&,const ShaderFrame&,const NeuralInputStamp&,bool redraw,bool displayMapped,std::function<ShaderResult()>*completion,NeuralGpuTimingTicket*timing=nullptr);
ShaderResult finishEstimatedDepthFogNode(const std::shared_ptr<ShaderNode>&);
}
