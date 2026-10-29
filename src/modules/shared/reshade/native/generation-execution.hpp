#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effects-execution.hpp"
#include "generation-timeline.hpp"
#include "runtime-status.hpp"
#include <functional>
namespace macfx {
struct GenerationSequenceInput {
 id<MTLCommandBuffer>commands=nil;id<MTLTexture>source=nil;
 std::shared_ptr<EffectExecution>execution;
 unsigned capacity=0;uintptr_t owner=0;uint64_t sourceFrameId=0;
 double timeMs=0,durationMs=0;FrameOrigin origin=FrameOrigin::TopLeft;
 ImageColorDescription color;ImageContentStamp content;
 bool opaque=false,displayMapped=false;
 // Storage and its admission belong to the caller's bounded output batch.
 std::function<id<MTLTexture>(unsigned,unsigned,unsigned)>image;
 std::function<void(const EffectGenerationStage&,RuntimeStatusPhase,const std::string&)>observe;
};
struct GenerationSequenceResult {
 ShaderResult result;std::vector<GenerationEvent>events;
 std::vector<std::shared_ptr<ImageReservation>>admissions;
 struct Completion{size_t stage=0;std::function<ShaderResult()>result;};
 std::vector<Completion>completions;
};
// One shared graph evaluator for live presentation and offline video. It does
// not commit, wait, schedule display, choose media timestamps or own observers.
GenerationSequenceResult encodeGenerationSequence(const GenerationSequenceInput&,uint64_t&eventSequence);
// Called only after the source command buffer completes. Invalid synthetic
// outputs can be omitted without discarding their valid real endpoint.
ShaderResult completeGenerationEvent(const GenerationEvent&)noexcept;
}
