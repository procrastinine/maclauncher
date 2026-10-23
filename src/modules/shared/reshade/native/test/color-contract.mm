#include "color-contract.hpp"
#import <QuartzCore/CAMetalLayer.h>
#include <cassert>
using namespace macfx;
int main(){@autoreleasepool{
    auto srgb=CGColorSpaceCreateWithName(kCGColorSpaceSRGB),p3=CGColorSpaceCreateWithName(kCGColorSpaceDisplayP3),linear=CGColorSpaceCreateWithName(kCGColorSpaceExtendedLinearSRGB);
    assert(imageColorSpace(nullptr)==ImageColorSpace::LegacySDR&&modelColorSupported(imageColorSpace(nullptr)));
    assert(imageColorSpace(srgb)==ImageColorSpace::SRGB&&modelColorSupported(imageColorSpace(srgb)));
    assert(imageColorSpace(p3)==ImageColorSpace::DisplayP3&&!modelColorSupported(imageColorSpace(p3)));
    assert(imageColorSpace(linear)==ImageColorSpace::Unsupported&&imageColorSpace(srgb,true)==ImageColorSpace::Unsupported);
    auto source=[CAMetalLayer layer],output=[CAMetalLayer layer];source.colorspace=p3;output.colorspace=source.colorspace;
    assert(sameImageColorSpace(output.colorspace,p3));source.colorspace=srgb;
    assert(!sameImageColorSpace(output.colorspace,source.colorspace)); // Accepted P3 pixels keep their old tag until replacement.
    output.colorspace=nullptr;assert(!output.colorspace); // No implicit retagging of legacy publisher values.
    CFRelease(srgb);CFRelease(p3);CFRelease(linear);
    puts("Validated nil/sRGB/P3 tags and unsupported extended range; layer metadata only, no GPU conversion/display claim");
}}
