#include "simple-generation-policy.hpp"
#include <cassert>
#include <cstring>
#include <iostream>
using namespace macfx::simplegeneration;
int main(){
    const Size source{960,540},output{3840,2160};
    const auto baseline=choose(source,output,4,scalerPasses("fsr1"),false);
    assert(baseline.placement==Placement::Output);
    const auto candidate=choose(source,output,4,scalerPasses("fsr1"),true);
    assert(candidate.placement==Placement::Source);
    assert(candidate.work.sourceScaling==candidate.work.outputScaling*4);
    assert(candidate.work.sourceGeneration*16==candidate.work.outputGeneration);
    assert(candidate.work.sourceTotal<candidate.work.outputTotal);
    const auto lightFlow=choose(source,output,4,2,true,0,.25);
    assert(lightFlow.work.sourceGeneration<candidate.work.sourceGeneration&&lightFlow.work.sourceScaling==candidate.work.sourceScaling);
    assert(choose({1900,1069},{1920,1080},4,2,true,0,.25).placement==Placement::Output);
    assert(choose(output,output,4,1,true).placement==Placement::Output);
    assert(choose({960,720},output,4,1,true).placement==Placement::Output);
    assert(choose({854,480},{2560,1440},4,1,true).placement==Placement::Source);
    const auto budget=choose(source,output,4,1,true,1920*1080);
    assert(budget.placement==Placement::Source&&std::strstr(budget.reason,"pixel budget"));
    assert(choose(source,output,4,1,true,100).placement==Placement::Output);
    assert(choose({0,540},output,4,1,true).placement==Placement::Output);
    assert(choose(source,output,1,1,true).placement==Placement::Output);
    assert(choose(source,output,4,scalerPasses("ls1"),true).placement==Placement::Output);
    for(unsigned multiplier=2;multiplier<=5;++multiplier)for(unsigned width:{1280u,1920u,2560u,3840u}){
        const Size size{width,width*9/16};const auto half=choose({width/2,size.height/2},size,multiplier,1,true);
        assert(half.placement==Placement::Source);
        assert(half.work.generated==multiplier-1&&half.work.sourceTotal<half.work.outputTotal);
    }
    std::cout<<"Simple generation pixel/pass policy passed\n";
}
