#pragma once
#include "presentation.hpp"
#import <Cocoa/Cocoa.h>
namespace macfx {
// Main-thread window integration; no CGL calls or ownership-map lock required.
// The original view keeps its renderer, event routing and first responder.
class ViewPresentation {
public:
    ViewPresentation(NSView *source,unsigned width,unsigned height,const PresenterConfig &config=PresenterConfig{});
    ~ViewPresentation();
    void update(NSView *source,unsigned width,unsigned height); // Main thread only.
    // frameId zero reserves the next sequence for this view only.
    FrameResult submit(id<MTLCommandBuffer>,id<MTLTexture>,uint64_t,double);
    PresenterStatus snapshot()const;
    void stop(); // Safe from render/teardown threads; removal is dispatched to main.
private:
    struct Impl;
    std::shared_ptr<Impl>impl;
};
}
