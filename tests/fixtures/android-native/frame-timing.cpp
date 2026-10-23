#include "frame-timing.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
int main(){
    klj_timing::Window timing;
    uint64_t now=1000000000;
    for(unsigned i=0;i<121;++i){timing.record(now,now+1000000);now+=16666667;}
    assert(timing.due(now));assert(std::abs(timing.fps()-60)<.01);
    assert(timing.percentile(.95)==17);assert(timing.maxSubmitNs==1000000);
    const auto oldPrevious=timing.previous;
    timing.reset(now);assert(timing.frames==0&&timing.intervals==0&&timing.previous==oldPrevious);
    now+=500000000;timing.record(now,now+2000000);
    assert(timing.maxIntervalNs>500000000);assert(timing.percentile(.95)>500);
    assert(timing.fps()<2);assert(timing.maxSubmitNs==2000000);
    puts("PASS bounded frame intervals, real stalls, percentiles and window reset");
}
