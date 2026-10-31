#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// Explicit source frame-rate cap (output.frameRateCap). Plain C++ so the slot
// arithmetic is testable; source-frame-pacing.hpp connects it to the plan.
#include <array>
#include <cstdint>
#include <mutex>

namespace macfx {
// One slot per producer object, such as a Metal layer or an OpenGL context.
// A producer that is more than one interval late starts a new schedule
// instead of catching up with a burst of unpaced frames.
class SourceFrameCap {
    struct Slot {const void *owner=nullptr;uint64_t next=0,used=0;};
    std::mutex mutex;std::array<Slot,8> slots{};uint64_t sequence=0;
public:
    // `interval` and `now` share one tick unit. Returns the tick the caller
    // waits for, or zero when the frame may continue at once.
    uint64_t reserve(const void *owner,uint64_t interval,uint64_t now,bool source=true){
        if(!source||!owner||!interval)return 0;
        std::lock_guard lock(mutex);
        Slot *slot=nullptr;
        for(auto &value:slots)if(value.owner==owner){slot=&value;break;}
        if(!slot){slot=&slots[0];for(auto &value:slots)if(value.used<slot->used)slot=&value;*slot={owner,0,0};}
        slot->used=++sequence;
        if(!slot->next||now>slot->next+interval){slot->next=now+interval;return 0;}
        const uint64_t deadline=slot->next;slot->next+=interval;
        return now<deadline?deadline:0;
    }
};

// A wait can return early (for example after a signal). The reservation is one
// producer boundary, so retry its original deadline rather than reserving a
// second frame or releasing this one before its clock permits it.
template<class Now,class Wait>
void waitSourceFrameDeadline(uint64_t deadline,Now now,Wait wait){
    while(deadline&&now()<deadline)wait(deadline);
}
}
