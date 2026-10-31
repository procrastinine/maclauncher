// Copyright (c) MacLauncher contributors. MIT license.
// Deterministic producer ownership and interrupted-deadline regression.
#include "../source-frame-cap.hpp"
#include <cstdio>
#include <cstdlib>
#include <vector>
#define CHECK(value) do{if(!(value)){std::fprintf(stderr,"%s:%d: %s\n",__FILE__,__LINE__,#value);std::exit(1);}}while(0)
using namespace macfx;

static void cadence(unsigned fps){
    // 90,000 ticks/second represents both tested caps exactly. Driver/helper
    // contexts must not evict the real producer from the eight-clock table.
    SourceFrameCap cap;int producer=0,helpers[20]{};
    const uint64_t interval=90000/fps;uint64_t now=1000;unsigned waits=0;
    std::vector<uint64_t>released;
    for(unsigned frame=0;frame<200;++frame){
        for(auto&helper:helpers)CHECK(cap.reserve(&helper,interval,now,false)==0);
        const auto deadline=cap.reserve(&producer,interval,now);
        waitSourceFrameDeadline(deadline,[&]{return now;},[&](uint64_t target){
            CHECK(target==deadline);++waits;
            // Two interrupted/early waits, then completion. The frame must
            // retain the same reservation through all three returns.
            if(waits%3)now+=interval/32;else now=target;
        });
        CHECK(!deadline||now>=deadline);released.push_back(now);
        now+=interval/8; // deterministic rendering work before the next flush
    }
    CHECK(waits==3*199);
    for(unsigned frame=1;frame<released.size();++frame)CHECK(released[frame]-released[frame-1]==interval);
    CHECK(released.back()-released.front()==199*interval);
}
int main(){
    cadence(30);cadence(45);
    // Rejected calls cannot advance an existing producer's clock either.
    SourceFrameCap cap;int owner=0;
    CHECK(cap.reserve(&owner,100,1000)==0);
    CHECK(cap.reserve(&owner,100,1010,false)==0);
    CHECK(cap.reserve(&owner,100,1010)==1100);
    unsigned reads=0,waits=0;
    waitSourceFrameDeadline(0,[&]{++reads;return uint64_t(1);},[&](uint64_t){++waits;});
    CHECK(reads==0&&waits==0);
    waitSourceFrameDeadline(100,[&]{return uint64_t(101);},[&](uint64_t){++waits;});
    CHECK(waits==0);
    std::puts("source-frame-pacing: pass");
}
