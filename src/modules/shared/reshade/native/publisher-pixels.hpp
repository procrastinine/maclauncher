#pragma once
#include <algorithm>
#include <cmath>

namespace macfx {
struct PublisherExtent { double width=0,height=0; };

// Pixel units are a property of the renderer's allocation, independent of the
// display backing scale. Rounding either axis by one pixel is permitted.
class PublisherPixelMapping {
    PublisherExtent points_,pixels_;
    double ratio_=0,backingRatio_=0;
    bool ready_=false;
    static bool valid(PublisherExtent size) noexcept {
        return std::isfinite(size.width)&&std::isfinite(size.height)&&
            size.width>=1&&size.height>=1&&size.width<=16384&&size.height<=16384;
    }
    static bool same(PublisherExtent a,PublisherExtent b) noexcept {
        return std::abs(a.width-b.width)<.01&&std::abs(a.height-b.height)<.01;
    }
    static bool fits(double ratio,PublisherExtent points,PublisherExtent pixels) noexcept {
        return std::isfinite(ratio)&&ratio>=1./16&&ratio<=16&&
            std::abs(points.width*ratio-pixels.width)<=1.01&&
            std::abs(points.height*ratio-pixels.height)<=1.01;
    }
    static double ratio(PublisherExtent points,PublisherExtent pixels) noexcept {
        return (points.width*pixels.width+points.height*pixels.height)/
            (points.width*points.width+points.height*points.height);
    }
public:
    bool established() const noexcept { return ratio_>0; }
    // Only the owning main thread supplies observations. A fixed old drawable
    // during a resize must not redefine the units of an owned source window.
    bool observe(PublisherExtent points,PublisherExtent pixels,PublisherExtent backing,bool owned) noexcept {
        ready_=false;
        if(!valid(points)||!valid(pixels)||!valid(backing))return false;
        const double actual=ratio(points,pixels),backingScale=ratio(points,backing);
        if(!fits(actual,points,pixels)||!fits(backingScale,points,backing))return false;
        const bool changed=!same(pixels,pixels_);
        if(!established()){
            ratio_=actual;backingRatio_=backingScale;
        }else if(fits(ratio_,points,pixels)){
            // A resize allocation can arrive before the screen-density
            // allocation. Retain the display reference until the pixel ratio
            // changes; a low-DPI publisher can keep its ratio on any screen.
        }else{
            if(!changed)return false;
            if(owned){
                const double displayRatio=ratio_*backingScale/backingRatio_;
                if(std::abs(backingScale-backingRatio_)<.001||!fits(displayRatio,points,pixels))return false;
            }
            ratio_=actual;backingRatio_=backingScale;
        }
        points_=points;pixels_=pixels;ready_=true;return true;
    }
    PublisherExtent pixels(PublisherExtent points,bool owned) const noexcept {
        if(!established()||!valid(points)||(!owned&&(!ready_||!same(points,points_))))return {};
        // The admitted allocation is exact, including integer rounding. Use
        // prediction only while geometry is ahead of the next allocation.
        if(ready_&&same(points,points_))return pixels_;
        const PublisherExtent result{points.width*ratio_,points.height*ratio_};
        return valid(result)?result:PublisherExtent{};
    }
};

// Source window/input geometry remains in points; only the producer allocation
// is in pixels. Use the same measured conversion for either renderer density.
inline PublisherExtent publisherPointExtent(PublisherExtent desired,PublisherExtent pixels,PublisherExtent content) noexcept {
    if(pixels.width<=0||pixels.height<=0)return {};
    return {desired.width*content.width/pixels.width,desired.height*content.height/pixels.height};
}
}
