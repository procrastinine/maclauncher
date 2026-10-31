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
    puts("Automatic generation leaves a late candidate at once and returns after ten seconds of headroom outside a thirty-second back-off");
}
