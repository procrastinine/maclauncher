#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// Pure Simple placement policy. Pixel/dispatch-group work is an estimate,
// never GPU milliseconds. Qualification remains separate from API support.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string_view>

namespace macfx::simplegeneration {
enum class Placement { Output, Source };
struct Size {unsigned width=0,height=0;};
struct Work {
    uint64_t sourcePixels=0,outputPixels=0;
    unsigned generated=0,scalerPasses=0;
    double flowScale=1,generationPasses=0,outputGeneration=0,sourceGeneration=0,outputScaling=0,sourceScaling=0,outputTotal=0,sourceTotal=0;
};
struct Decision {Placement placement=Placement::Output;Work work;const char *reason="The generation or scaler input contract is unavailable.";};
inline unsigned scalerPasses(std::string_view method) noexcept {
    if(method=="fsr1")return 2;
    return method=="nearest"||method=="bilinear"||method=="bicubic"||method=="metalfx"||method=="mako"?1:0;
}
inline Decision choose(Size source,Size output,unsigned multiplier,unsigned scalerJobs,bool allowSource,uint64_t maximumGenerationPixels=0,double flowScale=1) noexcept {
    Decision result;
    const auto valid=[](Size value){return value.width&&value.height&&value.width<=16384&&value.height<=16384;};
    if(!valid(source)||!valid(output)||!scalerJobs||scalerJobs>2||multiplier<2||multiplier>5||!std::isfinite(flowScale)||flowScale<.25||flowScale>1)return result;
    auto &work=result.work;
    work.sourcePixels=uint64_t(source.width)*source.height;work.outputPixels=uint64_t(output.width)*output.height;
    work.generated=multiplier-1;work.flowScale=flowScale;work.generationPasses=1+17*flowScale*flowScale+work.generated*(2+20*flowScale*flowScale);work.scalerPasses=scalerJobs;
    work.outputGeneration=work.outputPixels*work.generationPasses;work.sourceGeneration=work.sourcePixels*work.generationPasses;
    work.outputScaling=work.outputPixels*scalerJobs;work.sourceScaling=work.outputScaling*multiplier;
    work.outputTotal=work.outputGeneration+work.outputScaling;work.sourceTotal=work.sourceGeneration+work.sourceScaling;
    if(!allowSource){result.reason="Output-size generation retains the qualified placement.";return result;}
    if(source.width>output.width||source.height>output.height||work.sourcePixels>=work.outputPixels){
        result.reason="The completed generation source is not smaller than the presentation.";return result;
    }
    const auto x=uint64_t(source.width)*output.height,y=uint64_t(source.height)*output.width;
    if((x>y?x-y:y-x)>std::max({source.width,source.height,output.width,output.height})){
        result.reason="The source and presentation geometry do not share a fitted aspect ratio.";return result;
    }
    if(maximumGenerationPixels&&work.sourcePixels>maximumGenerationPixels){
        result.reason="The source generation extent exceeds the supplied pixel budget.";return result;
    }
    if(work.sourceTotal>=work.outputTotal){
        result.reason="Scaling every delivered frame does not reduce estimated image work.";return result;
    }
    result.placement=Placement::Source;
    result.reason=maximumGenerationPixels&&work.outputPixels>maximumGenerationPixels?
        "Source-size generation fits the supplied pixel budget and reduces estimated image work.":
        "Source-size generation reduces estimated image work after accounting for scaling every delivered frame.";
    return result;
}
}
