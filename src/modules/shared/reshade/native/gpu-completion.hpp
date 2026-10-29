#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <dispatch/dispatch.h>
namespace macfx {
// Per-submission GPU authority. An earlier consumer completion handler can
// observe the actual completed command before this owner's handler runs.
// The recorded terminal status also distinguishes success from GPU error
// after the exact command object is released. No waits or status promotion.
class GPUCompletionFence {
    __weak id<MTLCommandBuffer> commands=nil;
    std::atomic<unsigned> terminal{MTLCommandBufferStatusNotEnqueued};
public:
    void bind(id<MTLCommandBuffer> value)noexcept{commands=value;}
    void observe(id<MTLCommandBuffer> value)noexcept{
        auto original=commands;
        if(original&&original==value)terminal.store(unsigned(value.status),std::memory_order_release);
    }
    MTLCommandBufferStatus status()const noexcept{
        auto original=commands;
        return original?original.status:MTLCommandBufferStatus(terminal.load(std::memory_order_acquire));
    }
    bool completed()const noexcept{return status()==MTLCommandBufferStatusCompleted;}
    bool failed()const noexcept{return status()==MTLCommandBufferStatusError;}
};
// A caller command buffer that waits on the GPU for an external provider's
// done value is ended by the GPU watchdog when the provider is late, losing
// the frame and its owner's resources. Arm this once the GPU reaches the
// producer value: a provider that has not signaled done within the bound is
// released by the CPU after `expire` clears the frame's validity gate, so the
// frame keeps its passthrough image. The late result serves later frames only.
inline constexpr auto providerWaitBound=std::chrono::milliseconds(2000);
inline void releaseLateProvider(id<MTLSharedEvent> event,uint64_t done,void(^expire)(void))noexcept{
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,int64_t(providerWaitBound.count())*int64_t(NSEC_PER_MSEC)),dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
        if(event.signaledValue>=done)return;
        expire();event.signaledValue=std::max(event.signaledValue,done);
    });
}
}
