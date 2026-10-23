#pragma once
#include <algorithm>
#include <cmath>

namespace macfx {
struct AutomaticResolutionSize {double width,height;};
// Physical presentation fitted to the producer's aspect ratio. A true source
// allocation can grow to this target after resize; a processing-only downsample
// separately clamps the target to its already-rendered input.
inline AutomaticResolutionSize automaticResolutionTarget(double outputWidth,double outputHeight,
                                                         double sourceWidth,double sourceHeight)noexcept {
    if(!std::isfinite(outputWidth)||!std::isfinite(outputHeight)||outputWidth<1||outputHeight<1||
       !std::isfinite(sourceWidth)||!std::isfinite(sourceHeight)||sourceWidth<1||sourceHeight<1)
        return {sourceWidth,sourceHeight};
    const double fit=std::min(outputWidth/sourceWidth,outputHeight/sourceHeight);
    const double divisor=std::clamp(std::round(std::min(sourceWidth*fit,sourceHeight*fit)/540.0),1.0,4.0);
    const double scale=fit/divisor;
    return {std::max(1.0,std::min(outputWidth,std::ceil(sourceWidth*scale))),
            std::max(1.0,std::min(outputHeight,std::ceil(sourceHeight*scale)))};
}
}
