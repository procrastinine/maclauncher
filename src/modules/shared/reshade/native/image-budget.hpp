#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <algorithm>
#include <cstdint>
#include <limits>
namespace macfx {
struct ImageBudgetSnapshot {uint64_t workingSet=0,allocated=0,committed=0,pending=0,externalCommitted=0;};
struct ImageBudgetDecision {bool admitted=false,structurallyImpossible=false;uint64_t projected=0,limit=0,headroom=0;};
inline bool imageBytesAdd(uint64_t a,uint64_t b,uint64_t &value)noexcept{
    if(b>std::numeric_limits<uint64_t>::max()-a)return false;value=a+b;return true;
}
// Query the device only on new image admission. A zero working-set value is
// unknown, not a fabricated small-device limit. Outstanding reservations still
// participate in overflow checks and in subsequent known-budget decisions.
inline ImageBudgetDecision admitImageBytes(ImageBudgetSnapshot state,uint64_t bytes)noexcept{
    ImageBudgetDecision result;result.headroom=state.workingSet/16;
    result.limit=state.workingSet?state.workingSet-result.headroom:std::numeric_limits<uint64_t>::max();
    result.structurallyImpossible=!bytes||bytes>result.limit;
    if(!bytes||!imageBytesAdd(std::max(state.allocated,state.committed),state.externalCommitted,result.projected)||
       !imageBytesAdd(result.projected,state.pending,result.projected)||
       !imageBytesAdd(result.projected,bytes,result.projected))return result;
    result.admitted=result.projected<=result.limit;return result;
}
inline uint64_t alignedImageBytes(unsigned width,unsigned height,unsigned pixelBytes,unsigned rowAlignment=256,unsigned pageAlignment=4096)noexcept{
    if(!width||!height||!pixelBytes||!rowAlignment||!pageAlignment)return 0;
    const uint64_t row=uint64_t(width)*pixelBytes;
    const uint64_t stride=((row+rowAlignment-1)/rowAlignment)*rowAlignment;
    if(stride>std::numeric_limits<uint64_t>::max()/height)return 0;
    const uint64_t bytes=stride*height;
    if(bytes>std::numeric_limits<uint64_t>::max()-(pageAlignment-1))return 0;
    return ((bytes+pageAlignment-1)/pageAlignment)*pageAlignment;
}
}
