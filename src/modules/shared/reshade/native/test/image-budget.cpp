#include "image-budget.hpp"
#include <cassert>
#include <limits>
using namespace macfx;
int main(){
    constexpr uint64_t GiB=uint64_t(1)<<30;
    assert(admitImageBytes({16*GiB,4*GiB,GiB,0},4*GiB).admitted);
    assert(!admitImageBytes({16*GiB,14*GiB,GiB,GiB},GiB).admitted);
    assert(!admitImageBytes({GiB,0,GiB/2,GiB/4},GiB/4).admitted);
    assert(admitImageBytes({0,0,0,0},20*GiB).admitted); // Unknown is not an invented4K limit.
    assert(!admitImageBytes({0,std::numeric_limits<uint64_t>::max(),0,0},1).admitted);
    assert(!admitImageBytes({GiB,0,0,0},0).admitted);
    assert(admitImageBytes({GiB,0,0,0},GiB).structurallyImpossible);
    assert(!admitImageBytes({GiB,GiB,0,0},4096).structurallyImpossible);
    assert(!admitImageBytes({GiB,GiB,0,0},4096).admitted&&admitImageBytes({GiB,0,0,0},4096).admitted);
    assert(alignedImageBytes(1920,1080,4)>=uint64_t(1920)*1080*4);
    assert(alignedImageBytes(1,1,4)==4096);
    for(uint64_t pending=0;pending<10000;++pending){const auto value=admitImageBytes({20000,1234,2000,pending},321);
        assert(value.projected==2000+pending+321);assert(value.admitted==(value.projected<=18750));}
}
