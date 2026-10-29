#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
#import <objc/runtime.h>
#include "diagnostics.hpp"
#include <cmath>
#include <cstring>

namespace macfx {
// Compose with each application registration instead of registering a second
// handler on its options object. The Metal implementation owns registration
// semantics and options reuse; committing never adds another application block.
API_AVAILABLE(macos(26.0))
inline MTL4CommitFeedbackHandler metal4TimingHandler(MTL4CommitFeedbackHandler application) {
    if(!gpuTimingEnabled())return application;
    return ^(id<MTL4CommitFeedback> feedback) {
        @try {if(application)application(feedback);}
        @finally {
            if(gpuTimingEnabled()) {
                const double start=feedback.GPUStartTime,end=feedback.GPUEndTime;
                const bool valid=!feedback.error&&std::isfinite(start)&&std::isfinite(end)&&start>0&&end>=start;
                // Several registered application handlers can receive the same
                // feedback. Its observation follows the feedback lifetime, not
                // a growing list of completed submissions on reused options.
                const double signature[]={start,end};static char observedKey;
                bool fresh=false;
                @synchronized(feedback) {
                    auto previous=(NSData*)objc_getAssociatedObject(feedback,&observedKey);
                    if(previous.length!=sizeof(signature)||std::memcmp(previous.bytes,signature,sizeof(signature))) {
                        objc_setAssociatedObject(feedback,&observedKey,[NSData dataWithBytes:signature length:sizeof(signature)],OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                        fresh=true;
                    }
                }
                if(fresh)recordGpuDuration("game-metal4-submit",0,0,valid?(end-start)*1000:0,valid);
            }
        }
    };
}
}
