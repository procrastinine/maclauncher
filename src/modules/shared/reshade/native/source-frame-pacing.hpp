#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effects-plan.hpp"
#include "source-frame-cap.hpp"
#include <chrono>
#include <mach/mach_time.h>

namespace macfx {
// The cap the user selected in the current plan, read at most ten times per
// second on each producer thread. Zero leaves the producer's own timing.
inline double sourceFrameRateCap(){
    thread_local double cached=0;thread_local std::chrono::steady_clock::time_point next{};
    const auto now=std::chrono::steady_clock::now();
    if(now>=next){next=now+std::chrono::milliseconds(100);const auto plan=currentEffectPlan();cached=plan?plan->output.frameRateCap:0;}
    return cached;
}
// Called at a producer's frame boundary: Metal drawable requests and OpenGL
// flushes. It waits only while a cap is selected.
inline void paceSourceFrame(const void *owner,bool source=true){
    const double fps=sourceFrameRateCap();if(!(fps>0))return;
    static mach_timebase_info_data_t base=[]{mach_timebase_info_data_t value{};mach_timebase_info(&value);return value;}();
    static auto *cap=new SourceFrameCap;
    const uint64_t interval=uint64_t(1e9/fps*base.denom/base.numer);
    const auto deadline=cap->reserve(owner,interval,mach_absolute_time(),source);
    waitSourceFrameDeadline(deadline,[]{return mach_absolute_time();},[](uint64_t target){mach_wait_until(target);});
}
}
