#include "publisher-pixels.hpp"
#include "resolution-scale.hpp"
#include <cassert>
#include <limits>

using macfx::PublisherExtent;
static bool close(double a,double b){return std::abs(a-b)<.01;}
static void expect(PublisherExtent value,double width,double height){assert(close(value.width,width)&&close(value.height,height));}
int main(){
    using namespace macfx;
    // The actual Wine producer is already half the Retina output. Divisor two
    // needs no source-window reduction; treating it as backing would halve twice.
    PublisherPixelMapping low;
    assert(low.observe({1920,1080},{1920,1080},{3840,2160},false));
    const auto lowPixels=low.pixels({1920,1080},false);expect(lowPixels,1920,1080);
    const auto lowDesired=renderSourceSize({{},{},2.},3840,2160,lowPixels.width,lowPixels.height);
    assert(close(lowDesired.width,lowPixels.width)&&close(lowDesired.height,lowPixels.height));
    expect(publisherPointExtent({lowDesired.width,lowDesired.height},lowPixels,{1920,1080}),1920,1080);

    PublisherPixelMapping retina;
    assert(retina.observe({1920,1080},{3840,2160},{3840,2160},false));
    const auto retinaPixels=retina.pixels({1920,1080},false);expect(retinaPixels,3840,2160);
    expect(publisherPointExtent({1920,1080},retinaPixels,{1920,1080}),960,540);
    // Old buffers cannot teach a different ratio during controlled reduction.
    assert(!retina.observe({960,540},{3840,2160},{1920,1080},true));
    expect(retina.pixels({960,540},true),1920,1080);
    assert(retina.observe({960,540},{1920,1080},{1920,1080},true));
    expect(retina.pixels({960,540},true),1920,1080);
    assert(!retina.observe({640,360},{1920,1080},{1280,720},true));
    expect(retina.pixels({640,360},true),1280,720);
    assert(retina.observe({640,360},{1280,720},{1280,720},true));

    // Ordinary window resize also waits for a new allocation before a proxy
    // can be created. The trusted mapping remains usable by an existing owner.
    assert(!low.observe({1280,720},{1920,1080},{2560,1440},false));
    expect(low.pixels({1280,720},false),0,0);
    expect(low.pixels({1280,720},true),1280,720);
    assert(low.observe({1280,720},{1280,720},{2560,1440},false));
    expect(low.pixels({1280,720},false),1280,720);

    PublisherPixelMapping fractional;
    assert(fractional.observe({800,600},{1000,750},{1600,1200},false));
    expect(fractional.pixels({641,361},true),801.25,451.25);
    expect(publisherPointExtent({500,250},fractional.pixels({641,361},true),{641,361}),400,200);
    assert(fractional.observe({641,361},{802,452},{1282,722},true));
    expect(fractional.pixels({641,361},true),802,452);

    // Moving displays does not force a low-DPI publisher to adopt backing.
    assert(low.observe({1280,720},{1280,720},{1280,720},true));
    expect(low.pixels({1280,720},true),1280,720);
    assert(low.observe({1280,720},{1280,720},{2560,1440},true));
    expect(low.pixels({1280,720},true),1280,720);
    // A Retina publisher's changed allocation confirms a real display change.
    assert(retina.observe({640,360},{1280,720},{640,360},true));
    expect(retina.pixels({640,360},true),1280,720);
    assert(retina.observe({640,360},{640,360},{640,360},true));
    expect(retina.pixels({640,360},true),640,360);
    assert(retina.observe({640,360},{1280,720},{1280,720},true));
    expect(retina.pixels({640,360},true),1280,720);
    PublisherPixelMapping compound;
    assert(compound.observe({1920,1080},{3840,2160},{3840,2160},false));
    assert(!compound.observe({960,540},{3840,2160},{960,540},true));
    // Resize arrives at the old density before the new display allocation.
    assert(compound.observe({960,540},{1920,1080},{960,540},true));
    assert(compound.observe({960,540},{960,540},{960,540},true));
    expect(compound.pixels({960,540},true),960,540);

    // Fixed/nonuniform backbuffers, invalid extents and unexpected allocation
    // changes cannot corrupt an established owned conversion.
    assert(!retina.observe({640,360},{1024,720},{1280,720},true));
    assert(!retina.observe({640,360},{1920,1080},{1280,720},true));
    assert(!retina.observe({640,360},{0,0},{1280,720},true));
    assert(!retina.observe({640,360},{std::numeric_limits<double>::quiet_NaN(),720},{1280,720},true));
    expect(retina.pixels({640,360},true),1280,720);
    PublisherPixelMapping unknown;
    assert(!unknown.observe({800,600},{1600,900},{1600,1200},false));
    expect(unknown.pixels({800,600},false),0,0);
    // An unowned renderer may explicitly switch density without a screen move.
    assert(retina.observe({640,360},{640,360},{1280,720},false));
    expect(retina.pixels({640,360},false),640,360);
}
