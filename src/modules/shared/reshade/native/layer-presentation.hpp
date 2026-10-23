#pragma once
#include "presentation.hpp"
#import <IOSurface/IOSurface.h>

namespace macfx {
// Remote Core Animation owns the source layer. This host leaves its contents,
// geometry and input ownership intact and presents through a child output layer.
class LayerPresentation {
public:
    LayerPresentation(CALayer *source,unsigned width,unsigned height,const PresenterConfig &config);
    LayerPresentation(CALayer *source,unsigned width,unsigned height,const PresenterConfig &config,bool opaqueSource);
    ~LayerPresentation();
    void update(unsigned width,unsigned height);
    FrameResult submit(IOSurfaceRef surface);
    PresenterStatus snapshot()const;
    void stop();
private:
    struct Impl;
    std::shared_ptr<Impl>impl;
};
// Preserves the existing remote-surface producer dependency. The caller must
// finish taking a private GPU snapshot before the publisher can reuse its input.
void waitWindowSurfaceProducer(void *owner);
}
