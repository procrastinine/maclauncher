#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "image-budget.hpp"
#include <cmath>
#include <limits>
namespace macfx {
// Pinned LSFG Graph image construction: two full RGBA8 sources, seven R8
// flow mips, Alpha0/1 history, Beta0/1, and independent Gamma/Delta/generated
// images for each output. Scratch aliases in Delta0/1 are not counted twice.
// The callback measures each actual descriptor before Graph construction;
// pipelines, model weights and private provider buffers are not image bytes.
template<class Measure>uint64_t generationImageBytes(unsigned w,unsigned h,unsigned multiplier,double flow,bool performance,Measure measure){
    if(!w||!h||multiplier<2||multiplier>5||!std::isfinite(flow)||flow<.25||flow>1)return 0;
    uint64_t total=0;bool valid=true;
    const auto add=[&](unsigned x,unsigned y,unsigned bytes,unsigned count){const auto value=measure(x,y,bytes);if(!value||value>std::numeric_limits<uint64_t>::max()/count||!imageBytesAdd(total,value*count,total))valid=false;};
    const auto shrink=[](unsigned x,unsigned n){return std::max(1u,x>>n);};
    const unsigned fw=std::max(1u,unsigned(w*flow)),fh=std::max(1u,unsigned(h*flow)),m=performance?1:2;
    unsigned qw[7],qh[7];add(w,h,4,2);add(1,1,4,1);
    for(unsigned i=0;i<7;++i){const unsigned mw=shrink(fw,i),mh=shrink(fh,i),hw=(mw+1)/2,hh=(mh+1)/2;qw[i]=(hw+1)/2;qh[i]=(hh+1)/2;
        add(mw,mh,1,1);add(hw,hh,4,2*m);add(qw[i],qh[i],4,2*m);add(qw[i],qh[i],4,(i?2:3)*2*m);}
    add(qw[0],qh[0],4,6);for(unsigned i=0;i<6;++i)add(shrink(qw[0],i),shrink(qh[0],i),1,1);
    for(unsigned branch=1;branch<multiplier;++branch){add(w,h,8,1);for(unsigned j=0;j<7;++j){const unsigned i=6-j;add(qw[i],qh[i],4,3+2*m);add(qw[i],qh[i],8,j>=4?3:1);}}
    return valid?total:0;
}
}
