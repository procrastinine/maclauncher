// Copyright (c) MacLauncher contributors. MIT license.
// Screenshot conversion choices for each presenter output format. This test
// creates no Metal device and runs without a GPU.
#include "../screenshot-color.hpp"
#include <cstdio>
#include <cstdlib>
#define CHECK(value) do{if(!(value)){std::fprintf(stderr,"%s:%d: %s\n",__FILE__,__LINE__,#value);std::exit(1);}}while(0)
using namespace macfx;
int main(){
    // 8-bit outputs are written directly; every other presenter format is converted.
    for(auto format:{MTLPixelFormatBGRA8Unorm,MTLPixelFormatBGRA8Unorm_sRGB,MTLPixelFormatRGBA8Unorm,MTLPixelFormatRGBA8Unorm_sRGB})CHECK(captureWritesFormat(format));
    for(auto format:{MTLPixelFormatRGBA16Float,MTLPixelFormatRGBA32Float,MTLPixelFormatBGR10A2Unorm,MTLPixelFormatRGB10A2Unorm,MTLPixelFormatBGRA10_XR,MTLPixelFormatBGR10_XR})CHECK(!captureWritesFormat(format));
    // A PQ output with display headroom becomes sRGB at its reference white.
    // Its peak is above the target's, which is what makes Automatic mapping
    // (outputColorMapping) compress the highlights.
    auto pq=describeImageColor(ImageColorSpace::BT2100PQ);pq.referenceWhite=203;pq.peakLuminance=203*4;
    const auto sdr=screenshotColor(pq);
    CHECK(sdr.valid()&&sdr.transfer==ColorTransfer::SRGB&&sdr.primaries==ColorPrimaries::BT709&&sdr.referenceWhite==203&&sdr.peakLuminance==203);
    CHECK(pq.peakLuminance>sdr.peakLuminance);
    // A float output without headroom has the same peak, so its levels are kept.
    ImageColorDescription linear;linear.transfer=ColorTransfer::Linear;linear.referenceWhite=linear.peakLuminance=100;
    const auto plain=screenshotColor(linear);CHECK(plain.referenceWhite==100&&plain.peakLuminance==linear.peakLuminance);
    // An unusable reference white falls back to 203 nits.
    ImageColorDescription broken;broken.referenceWhite=0;CHECK(screenshotColor(broken).referenceWhite==203);
    std::puts("screenshot-color: pass");
    return 0;
}
