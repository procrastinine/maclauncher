// Copyright (c) MacLauncher contributors. MIT license.
// Screenshot conversion choices for each presenter output format and color.
// This test creates no Metal device and runs without a GPU.
#include "../screenshot-color.hpp"
#include <cstdio>
#include <cstdlib>
#define CHECK(value) do{if(!(value)){std::fprintf(stderr,"%s:%d: %s\n",__FILE__,__LINE__,#value);std::exit(1);}}while(0)
using namespace macfx;
int main(){
    // 8-bit outputs are written directly; every other presenter format is converted.
    for(auto format:{MTLPixelFormatBGRA8Unorm,MTLPixelFormatBGRA8Unorm_sRGB,MTLPixelFormatRGBA8Unorm,MTLPixelFormatRGBA8Unorm_sRGB})CHECK(captureWritesFormat(format));
    for(auto format:{MTLPixelFormatRGBA16Float,MTLPixelFormatRGBA32Float,MTLPixelFormatBGR10A2Unorm,MTLPixelFormatRGB10A2Unorm,MTLPixelFormatBGRA10_XR,MTLPixelFormatBGR10_XR})CHECK(!captureWritesFormat(format));
    // HDR output (PQ, HLG or a peak above reference white) becomes canonical
    // BT.2020 PQ in RGBA16Unorm at its own reference white and peak.
    auto pq=describeImageColor(ImageColorSpace::BT2100PQ);pq.referenceWhite=203;pq.peakLuminance=203*4;
    CHECK(screenshotHDR(pq)&&screenshotFormat(pq)==MTLPixelFormatRGBA16Unorm);
    const auto hdr=screenshotColor(pq);
    CHECK(hdr.valid()&&hdr.transfer==ColorTransfer::PQ&&hdr.primaries==ColorPrimaries::BT2020&&hdr.alpha==ColorAlpha::Opaque&&hdr.referenceWhite==203&&hdr.peakLuminance==pq.peakLuminance);
    ImageColorDescription extended;extended.transfer=ColorTransfer::Linear;extended.referenceWhite=100;extended.peakLuminance=400;
    CHECK(screenshotHDR(extended)&&screenshotColor(extended).transfer==ColorTransfer::PQ&&screenshotColor(extended).peakLuminance==400);
    // An unmarked 16-bit image is never treated as an encoded HDR screenshot.
    CHECK(!screenshotHDRTexture(nil)&&!captureWritesTexture(nil));
    // A float output without headroom has the same peak, so its levels are kept.
    ImageColorDescription linear;linear.transfer=ColorTransfer::Linear;linear.referenceWhite=linear.peakLuminance=100;
    CHECK(!screenshotHDR(linear)&&screenshotFormat(linear)==MTLPixelFormatRGBA8Unorm);
    const auto plain=screenshotColor(linear);CHECK(plain.transfer==ColorTransfer::SRGB&&plain.referenceWhite==100&&plain.peakLuminance==linear.peakLuminance);
    // An unusable reference white falls back to 203 nits.
    ImageColorDescription broken;broken.referenceWhite=0;CHECK(screenshotColor(broken).referenceWhite==203);
    std::puts("screenshot-color: pass");
    return 0;
}
