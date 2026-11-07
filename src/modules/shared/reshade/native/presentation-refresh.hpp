#pragma once
#include <algorithm>
#include <array>
#include <cmath>
namespace macfx {
// Refresh callbacks can skip a tick. Use the shortest interval in a small
// recent window rather than interpreting a skipped callback as a slower panel.
class PresentationRefreshClock {
    double previous=0;std::array<double,8> intervals{};unsigned count=0,cursor=0;
public:
    void reset()noexcept{previous=0;count=cursor=0;}
    unsigned observe(double target)noexcept{
        if(!std::isfinite(target)||target<=0)return 0;
        const double interval=previous>0?target-previous:0;previous=target;
        if(interval>=1./1000&&interval<=1./20){intervals[cursor++%intervals.size()]=interval;count=std::min(count+1,unsigned(intervals.size()));}
        if(!count)return 0;
        const double period=*std::min_element(intervals.begin(),intervals.begin()+count);
        return unsigned(std::clamp(std::lround(1./period),20l,1000l));
    }
};
}
