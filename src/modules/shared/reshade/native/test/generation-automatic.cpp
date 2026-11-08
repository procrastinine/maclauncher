#include "generation-automatic.hpp"
#include "generation-methods.hpp"
#include <cassert>
#include <cstdio>
using namespace macfx;
using Clock=AutomaticGenerationChoice::Clock;
int main(){
    const auto start=Clock::now();const auto at=[&](double seconds){return start+std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(seconds));};
    const auto all=[](size_t){return true;};
    AutomaticGenerationChoice choice(3);assert(choice.active()==0);
    // Behind leaves at once for the next usable candidate.
    assert(choice.observe(true,false,at(0),all)&&choice.active()==1);
    // Ten seconds of headroom are not enough inside the thirty-second back-off.
    for(double t=.1;t<=20;t+=.1)assert(!choice.observe(false,true,at(t),all));
    assert(choice.active()==1);
    // After the back-off, ten seconds of continuous headroom return to the preferred candidate.
    double t=20.1;bool returned=false;for(;t<=45&&!returned;t+=.1)returned=choice.observe(false,true,at(t),all);
    assert(returned&&choice.active()==0&&t>=30);
    // A capture without headroom restarts the headroom period.
    assert(choice.observe(true,false,at(50),all)&&choice.active()==1);
    for(t=50.1;t<79.9;t+=.1)assert(!choice.observe(false,true,at(t),all));
    assert(!choice.observe(false,false,at(79.95),all)&&choice.active()==1);
    assert(!choice.observe(false,true,at(80),all)&&!choice.observe(false,true,at(89.9),all)&&choice.observe(false,true,at(90.1),all)&&choice.active()==0);
    // Unprepared candidates are skipped; the last candidate stays when behind.
    AutomaticGenerationChoice skip(3);assert(skip.observe(true,false,at(0),[](size_t index){return index!=1;})&&skip.active()==2);
    assert(!skip.observe(true,false,at(1),all)&&skip.active()==2);
    // settle moves off a candidate that cannot run without a back-off.
    AutomaticGenerationChoice settle(2);assert(settle.settle([](size_t index){return index==1;})&&settle.active()==1);
    assert(settle.settle([](size_t index){return index==0;})&&settle.active()==0);
    // Candidate eligibility follows the generated contracts.
    assert(generationAcceptsMultiplier("vt-interpolation",2)&&generationAcceptsMultiplier("vt-interpolation",4)&&!generationAcceptsMultiplier("vt-interpolation",3));
    assert(generationAcceptsMultiplier("metalfx-image",2)&&!generationAcceptsMultiplier("metalfx-image",4)&&generationAcceptsMultiplier("vision-flow",5));
    assert(generationUsesImagePairs("auto")&&!generationUsesImagePairs("metalfx")&&generationUsesSDRColor("vt-interpolation")&&!generationUsesSDRColor("vision-flow"));
    // Replacement preparation is not overload; a busy prepared session is.
    assert(automaticGenerationBehind(true,false)&&!automaticGenerationBehind(true,true)&&!automaticGenerationBehind(false,false));
    // Measured work sizing: three slow smoothed ratios step down, 120 fast
    // ones step up, invalid timing is ignored and the level stays bounded.
    ImagePairWorkSize size;assert(size.level()==0&&ImagePairWorkSize::dimension(0)==1920);
    assert(!size.observe(0,1)&&!size.observe(1,0)&&!size.observe(INFINITY,1)&&size.level()==0);
    assert(!size.observe(.9,1)&&!size.observe(.9,1)&&size.observe(.9,1)&&size.level()==1&&ImagePairWorkSize::dimension(1)==1280);
    for(unsigned step=0;step<3;++step)size.observe(.95,1);
    assert(size.level()==2);for(unsigned step=0;step<12;++step)size.observe(.95,1);
    assert(size.level()==2&&ImagePairWorkSize::dimension(2)==960&&ImagePairWorkSize::dimension(9)==640);
    ImagePairWorkSize recover;for(unsigned step=0;step<3;++step)recover.observe(.9,1);
    unsigned fast=0;while(!recover.observe(.1,1)&&fast<1000)++fast;
    assert(fast==119&&recover.level()==0);
    // A mid-range ratio resets both counters.
    ImagePairWorkSize steady;steady.observe(.9,1);steady.observe(.9,1);steady.observe(.2,1);
    assert(!steady.observe(.9,1)&&steady.level()==0);
    puts("Automatic generation leaves a late candidate at once and returns after ten seconds of headroom outside a thirty-second back-off; image-pair work sizes follow measured timing");
}
