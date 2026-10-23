#pragma once
#import <Metal/Metal.h>
#include "diagnostics.hpp"

namespace macfx {
inline bool timingEnabled() {return gpuTimingEnabled();}
// Scope names distinguish full game buffers from effect-only GPU work. Records
// are queued in memory; the background writer batches disk output.
inline void recordTiming(id<MTLCommandBuffer> buffer,const char *scope,unsigned width,unsigned height) {
    if(!timingEnabled()) return;
    const double start=buffer.GPUStartTime,end=buffer.GPUEndTime;
    const bool valid=buffer.status==MTLCommandBufferStatusCompleted && start>0 && end>=start;
    recordGpuDuration(scope,width,height,valid?(end-start)*1000:0,valid);
}
inline void observeTiming(id<MTLCommandBuffer> buffer,const char *scope,unsigned width,unsigned height) {
    if(!timingEnabled()) return;
    [buffer addCompletedHandler:^(id<MTLCommandBuffer> completed) {recordTiming(completed,scope,width,height);}];
}
}
