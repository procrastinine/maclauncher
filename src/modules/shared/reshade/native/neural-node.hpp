#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include <string_view>
#include "temporal-frame.h"
#include "color-contract.hpp"
#include "scene-compute.hpp"
#include <functional>
namespace macfx {
// Query after the owning command buffer completes. Cache reuse reports no new
// provider work instead of recycling the original inference interval.
enum class NeuralGpuTimingState { Unavailable,Complete,NoNewWork };
struct NeuralGpuTimingValue {uint64_t nanoseconds=0;NeuralGpuTimingState state=NeuralGpuTimingState::Unavailable;};
using NeuralGpuTimingTicket=std::function<NeuralGpuTimingValue()>;
struct NeuralSpec {std::string modelPath;float intensity=1;bool temporal=false;std::string method="mlx-dlss";float denoiseStrength=1;unsigned intrinsicScale=0;};
// A neural row normalizes model input to top-left rows, then preserves the
// current stage's dimensions, declared origin and original alpha. Its optional
// provider owns model execution; the host retains command-buffer submission.
std::shared_ptr<ShaderNode> makeNeuralNode(const NeuralSpec &);
void setNeuralStatusContext(const std::shared_ptr<ShaderNode>&,uintptr_t,std::string_view stage,std::string_view revision);
void setNeuralInputColor(const std::shared_ptr<ShaderNode>&,const ImageColorDescription&);
// inputIdentity names the exact pixels entering the row, including upstream
// controls; it validates completed-result caches and redraws. historyIdentity
// names only the input contract (extent, format, color semantics and upstream
// structure), so history continues across an upstream control edit and resets
// when the contract changes. An empty historyIdentity is inputIdentity.
struct NeuralInputStamp {
    uint64_t contentId=0,epoch=0,observationId=0,imageRevision=0;
    std::string_view inputIdentity,historyIdentity;
    bool synthetic=false;
    std::string_view history()const noexcept{return historyIdentity.empty()?inputIdentity:historyIdentity;}
};
// A redraw with the same image identity copies the exact completed GPU result
// without submitting the model or advancing its history. Producer revisions
// and upstream changes invalidate that result while retaining model weights.
bool neuralGpuTimingAvailable(const std::shared_ptr<ShaderNode>&);
ShaderResult encodeNeuralStamped(const std::shared_ptr<ShaderNode>&,const ShaderFrame&,const NeuralInputStamp&,bool redraw,NeuralGpuTimingTicket*timing=nullptr);
ShaderResult finishNeuralNode(const std::shared_ptr<ShaderNode> &);
// Graph preparation runs one inference at the frame's extent before a neural
// row is adopted, with no frame waiting for it. Busy while that runs, and while
// a failed warm-up waits for its retry; the status query reports the same
// without starting work.
ShaderResult warmNeuralNode(const std::shared_ptr<ShaderNode>&,const ShaderFrame&);
ShaderResult neuralWarmupStatus(const std::shared_ptr<ShaderNode>&);
std::function<ShaderResult()>neuralImageCompletionTicket(const std::shared_ptr<ShaderNode>&);
using NeuralSceneEncoder=SceneComputeEncoder;
std::shared_ptr<NeuralSceneEncoder> makeNeuralSceneEncoder(id<MTLDevice>,const NeuralSpec &);
}
