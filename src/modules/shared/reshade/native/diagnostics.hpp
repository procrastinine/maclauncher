#pragma once
#include <cstdint>

namespace macfx {
enum class DiagnosticStage : unsigned {
    Hooks, WindowResolve, WindowPublish, WindowSurface, WindowSelected,
    MetalFrame, MetalOwnership, MetalRuntimeLock, MetalEncode,
    MetalQueue, MetalCommit, MetalProducerWait, MetalEffectWait, MetalDrawable,
    OpenGLFrame, OpenGLOwnership, OpenGLContextLock, OpenGLContextBind,
    OpenGLRuntimeLock, OpenGLState, OpenGLEffects, OpenGLSourceCopy,
    OpenGLSourceWait, OpenGLCopyBack, OpenGLCopyWait, OpenGLFlush, OpenGLCleanup,
    PresentedReal, PresentedGenerated,
    Count
};
struct DiagnosticSnapshot {
    uint64_t token=0,started=0,object=0;
    unsigned stage=unsigned(DiagnosticStage::Count),width=0,height=0;
};
struct DiagnosticSlot;
bool diagnosticsEnabled() noexcept;
void diagnosticEvent(DiagnosticStage stage,uintptr_t object=0,unsigned width=0,unsigned height=0) noexcept;
bool gpuTimingEnabled() noexcept;
void recordGpuDuration(const char *scope,unsigned width,unsigned height,double milliseconds,bool valid) noexcept;
// These durations are CPU elapsed times, including nested scopes and waits.
// GPU execution duration is reported separately by GPU timing queries.
class DiagnosticScope {
    DiagnosticSlot *slot_=nullptr;
    DiagnosticSnapshot current_,previous_;
    bool transition_=false;
public:
    explicit DiagnosticScope(DiagnosticStage stage,uintptr_t object=0,unsigned width=0,unsigned height=0) noexcept;
    // Checkpoint names must have static lifetime. Uses the existing event,
    // duration and record budgets; elapsed time includes nested work/waits.
    DiagnosticScope(DiagnosticStage stage,uintptr_t object,unsigned width,unsigned height,const char *checkpoint) noexcept;
    ~DiagnosticScope();
    DiagnosticScope(const DiagnosticScope&)=delete;
    DiagnosticScope& operator=(const DiagnosticScope&)=delete;
};
}
