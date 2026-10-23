#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
#include <atomic>
#include <memory>

namespace macfx {
// Only compatibility consumers wait on a producer. A deadline never marks GPU
// work complete: submitted resources remain owned by their completion leases.
class CommandDeadline {
    struct State {
        dispatch_semaphore_t ready=dispatch_semaphore_create(0);
        std::atomic<bool> success{false};
        void signal(bool value){if(value)success.store(true,std::memory_order_release);dispatch_semaphore_signal(ready);}
    };
    std::shared_ptr<State> state=std::make_shared<State>();
public:
    enum class Milestone { Scheduled, Completed };
    CommandDeadline(id<MTLCommandBuffer> commands,Milestone milestone){
        auto pending=state;
        if(milestone==Milestone::Scheduled)[commands addScheduledHandler:^(id<MTLCommandBuffer> value){pending->signal(value.status>=MTLCommandBufferStatusScheduled&&value.status!=MTLCommandBufferStatusError);}];
        [commands addCompletedHandler:^(id<MTLCommandBuffer> value){pending->signal(value.status==MTLCommandBufferStatusCompleted);}];
    }
    bool wait(unsigned milliseconds=8)const{
        if(state->success.load(std::memory_order_acquire))return true;
        if(dispatch_semaphore_wait(state->ready,dispatch_time(DISPATCH_TIME_NOW,int64_t(milliseconds)*NSEC_PER_MSEC)))return false;
        return state->success.load(std::memory_order_acquire);
    }
};
}
