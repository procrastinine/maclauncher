#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effects-execution.hpp"
#include "generation-schedule.hpp"
#import <QuartzCore/CAMetalLayer.h>
namespace macfx {
class FrameCapture;
// Registration is supplied by the original nextDrawable owner, never by
// guessing render targets from their dimensions or their command queue.
void registerTemporalDrawable(id<CAMetalDrawable>);
// Exact current real/output drawable registrations of one source only;
// no queue, extent or window guess. Each reservation is a new interval.
std::shared_ptr<CallerIntervalSourceOwnership>reserveCallerIntervalSource(id<MTLTexture>current,id<MTLTexture>output,const std::shared_ptr<CallerIntervalSourceOwnership>&previous,const std::string&revision,const std::string&stage);
std::shared_ptr<CallerIntervalSourceOwnership>callerIntervalSource(id<MTLTexture>);
// Propagate only the adapter's actual completed-image copy/view provenance.
void copyCallerIntervalSource(id<MTLTexture>from,id<MTLTexture>to);
id callerIntervalDrawableRegistration(id<MTLTexture>);
std::shared_ptr<CallerIntervalSourceOwnership>reserveObservedCallerIntervalSource(id<MTLTexture>real,id<MTLTexture>generated,const std::shared_ptr<CallerIntervalSourceOwnership>&previous,const std::string&revision,const std::string&stage);
bool bindCallerIntervalSource(id<MTLTexture>,id acquisition,const std::shared_ptr<CallerIntervalSourceOwnership>&);
bool reserveTemporalOutput(id<MTLCommandBuffer>,id<MTLTexture>);
// Explicit scene producers own the supplied output; a receipt still matches
// only that exact output and its unsubmitted retaining command buffer.
bool reserveExplicitTemporalOutput(id<MTLCommandBuffer>,id<MTLTexture>,void*owner,uint64_t frameId);
void publishTemporalOutput(id<MTLCommandBuffer>,id<MTLTexture>,uint64_t,std::shared_ptr<EffectExecution>,std::shared_ptr<FrameCapture> capture={});
void publishTemporalOutputWithDepth(id<MTLCommandBuffer>,id<MTLTexture>,uint64_t,std::shared_ptr<EffectExecution>,std::shared_ptr<FrameCapture>,const DepthFrame*);
void publishTemporalOutputWithDepth(id<MTLCommandBuffer>,id<MTLTexture>,uint64_t,std::shared_ptr<EffectExecution>,std::shared_ptr<FrameCapture>,const DepthFrame*,bool displayMapped,const RSTemporalFrame*scene=nullptr);
void publishTemporalPreparation(id<MTLCommandBuffer>,id<MTLTexture>,uint64_t,const std::string&);
struct TemporalPlanReceipt {std::shared_ptr<EffectExecution> execution;uint64_t frameId=0;std::shared_ptr<FrameCapture> capture;DepthFrame depth{nil,0,FrameOrigin::TopLeft};bool preparing=false;std::string reason;bool displayMapped=false;uint32_t inputs=0;std::shared_ptr<const EffectSceneLease>scene;std::function<ShaderResult()>completion;bool deferred=false,synthetic=false;
 // Scalar source information only; resource fields are cleared at publication
 // so receipts cannot retain their own command buffers through metadata.
 std::optional<ShaderFrame>sourceFrame;};
class DeferredTemporalOutput {
public:virtual ~DeferredTemporalOutput()=default;
 virtual void submitted(bool,id<MTLSharedEvent>,uint64_t)=0;
 virtual void completed(ShaderResult)=0;
};
std::shared_ptr<DeferredTemporalOutput>deferTemporalOutput(id<MTLTexture>,TemporalPlanReceipt,void*explicitOwner=nullptr);
std::shared_ptr<DeferredTemporalOutput>deferTemporalOutputForScope(id<MTLTexture>,TemporalPlanReceipt,void*explicitOwner,void*retirementScope);
// True only after an actual retaining exact-frame consumer encoded its event
// dependency. No virtual or provider/frame ABI changes for this observation.
bool deferredTemporalOutputHasEventConsumer(const std::shared_ptr<DeferredTemporalOutput>&);
// An actual retained drawable/event consumer can defer its CPU encoding on
// its existing worker. Notification follows publication GPU completion, not
// final producer feedback, which may itself be waiting for that consumer.
bool observeDeferredTemporalOutput(id<MTLCommandBuffer>consumer,id<MTLTexture>,uint64_t expectedFrameId,
 dispatch_queue_t,std::function<void(ShaderResult)>);
std::optional<ShaderFrame>temporalOutputSourceFrame(id<MTLCommandBuffer>,id<MTLTexture>);
TemporalPlanReceipt takeDeferredTemporalOutput(id<MTLCommandBuffer>,id<MTLTexture>,uint64_t expectedFrameId=0);
void clearDeferredTemporalOutputs(void*owner);
TemporalPlanReceipt takeTemporalOutput(id<MTLCommandBuffer>,id<MTLTexture>);
bool hasTemporalOutput(id<MTLCommandBuffer>,id<MTLTexture>);
bool temporalPlanRequested() noexcept;
}
