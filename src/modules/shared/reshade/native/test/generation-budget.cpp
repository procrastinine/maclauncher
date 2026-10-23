#include "generation-budget.hpp"
#include <cassert>
#include <vector>
#include <tuple>
using namespace macfx;
int main(){
    const auto bytes=[](unsigned w,unsigned h,unsigned pixel){return alignedImageBytes(w,h,pixel);};
    assert(generationImageBytes(1920,1080,2,1,false,bytes)>uint64_t(1920)*1080*8);
    const auto quality=generationImageBytes(3840,2160,4,1,false,bytes),performance=generationImageBytes(3840,2160,4,1,true,bytes);
    assert(quality>performance);assert(generationImageBytes(3840,2160,4,.5,false,bytes)<quality);
    assert(generationImageBytes(3840,2160,2,1,false,bytes)<quality);
    assert(generationImageBytes(16384,16384,5,1,false,bytes)>uint64_t(16384)*16384*8*5);
    assert(!generationImageBytes(1,1,6,1,false,bytes));
    unsigned sourceCount=0,generatedCount=0;
    const auto one=generationImageBytes(128,96,4,1,false,[&](unsigned w,unsigned h,unsigned b){if(w==128&&h==96){if(b==4)++sourceCount;if(b==8)++generatedCount;}return bytes(w,h,b);});
    assert(one&&sourceCount==1&&generatedCount==3);
    puts("Pinned LSFG shared/history/per-output image envelope measured before graph allocation; no model-weight or GPU-cost estimate asserted");
}
