#pragma once
#include "presentation.hpp"
#import <Cocoa/Cocoa.h>
namespace macfx {
// Main-thread window integration; no CGL calls or ownership-map lock required.
// The original view keeps its renderer, event routing and first responder.
class ViewPresentation {
public:
    ViewPresentation(NSView *source,unsigned width,unsigned height,const PresenterConfig &config=PresenterConfig{});
    // UIKit remains the owner of the source layer and all of its UI children.
    // An opaque game drawable can be replaced below those children, without
    // placing an AppKit view over the entire remote UIKit scene.
    ViewPresentation(CAMetalLayer *source,NSView *windowOwner,unsigned width,unsigned height,const PresenterConfig &config);
    ViewPresentation(NSView *,unsigned,unsigned,const PresenterConfig &,CGColorSpaceRef,std::shared_ptr<ViewPresentation> previous={});
    ViewPresentation(CAMetalLayer *,NSView *,unsigned,unsigned,const PresenterConfig &,CGColorSpaceRef,std::shared_ptr<ViewPresentation> previous={});
    bool colorSpaceMatches(CGColorSpaceRef,std::optional<ImageColorSpace> = {})const;
    bool failedForCurrentContract(unsigned,unsigned,MTLPixelFormat=MTLPixelFormatInvalid,id<MTLDevice> device=nil);
    bool terminalGpuFailure()const;
    std::shared_ptr<ViewPresentation> takePreviousOutput();
    ~ViewPresentation();
    void update(NSView *source,unsigned width,unsigned height); // Main thread only.
    void update(CAMetalLayer *source,NSView *windowOwner,unsigned width,unsigned height);
    // The layer whose contents mapping the output repeats when it does not
    // stretch its whole image over its bounds. True when it changed; the
    // caller then updates the layout. Main thread only.
    bool setContentsSource(CALayer *layer);
    // frameId zero reserves the next sequence for this view only.
    FrameResult submit(id<MTLCommandBuffer>,id<MTLTexture>,uint64_t,double);
    FrameResult submitWithDepth(id<MTLCommandBuffer>,id<MTLTexture>,uint64_t,double,const DepthFrame&);
    FrameResult submitDisplayFrame(id<MTLCommandBuffer>,id<MTLTexture>,uint64_t,double,bool opaque,const DepthFrame*depth=nullptr);
    PresenterStatus snapshot()const;
    bool requiresDepth()const;
    CGSize outputSize()const;
    bool canHoldPresentation(std::string &reason)const; // Main thread only.
    unsigned presentationWindow()const; // Main thread only.
    PresentationHoldStatus beginPresentationHold(const PresentationHoldCommand &);
    PresentationHoldStatus resumePresentationHold(const PresentationHoldCommand &);
    PresentationHoldStatus presentationHoldStatus()const;
    bool presentationHeld()const;
    void setNativeMetalCapabilities(bool sameSizeFxInPlace,bool ownedSourceSupported,bool presentationRequired=false);
    void stop(); // Safe from render/teardown threads; removal is dispatched to main.
private:
    struct Impl;
    std::shared_ptr<Impl>impl;
};
// Owner may be a CGL context, an Objective-C object address or another opaque
// frame token. Look up its address without retaining or messaging the token.
std::shared_ptr<ViewPresentation> viewPresentationForOwner(void *owner);
}
