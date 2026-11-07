#pragma once
#import <QuartzCore/CAMetalLayer.h>
#include <cstdint>
#include <functional>
#include <memory>
namespace macfx {
// Private macOS 14+ driver. The callback receives Core Animation's acquired
// drawable, the next presentation time and the observed refresh rate.
class PresentationDisplayLink {
    struct Impl;std::unique_ptr<Impl> impl;
public:
    using Update=std::function<void(id<CAMetalDrawable>,double,unsigned)>;
    PresentationDisplayLink(CAMetalLayer*,Update);
    ~PresentationDisplayLink();
    void resume();void pause();void invalidate();void setDisplay(uint32_t);
};
}
