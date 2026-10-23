#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effects-execution.hpp"
#import <QuartzCore/CAMetalLayer.h>
namespace macfx {
class FrameCapture;
// Registration is supplied by the original nextDrawable owner, never by
// guessing render targets from their dimensions or their command queue.
void registerTemporalDrawable(id<CAMetalDrawable>);
bool reserveTemporalOutput(id<MTLCommandBuffer>,id<MTLTexture>);
void publishTemporalOutput(id<MTLCommandBuffer>,id<MTLTexture>,uint64_t,std::shared_ptr<EffectExecution>,std::shared_ptr<FrameCapture> capture={});
struct TemporalPlanReceipt {std::shared_ptr<EffectExecution> execution;uint64_t frameId=0;std::shared_ptr<FrameCapture> capture;};
TemporalPlanReceipt takeTemporalOutput(id<MTLCommandBuffer>,id<MTLTexture>);
bool hasTemporalOutput(id<MTLCommandBuffer>,id<MTLTexture>);
bool temporalPlanRequested() noexcept;
}
