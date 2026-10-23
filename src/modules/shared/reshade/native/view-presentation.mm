#include "view-presentation.hpp"
#include "virtual-window.hpp"
#include "virtual-visibility.hpp"
#include "log.hpp"
#include "color-contract.hpp"
#import <QuartzCore/CATransaction.h>
#include <atomic>
#include <mutex>
#include <stdexcept>
#include <utility>

@interface MacFXPresentationView : NSView
@end
@implementation MacFXPresentationView
- (NSView *)hitTest:(NSPoint)point {return nil;}
- (BOOL)acceptsFirstResponder {return NO;}
- (BOOL)isOpaque {return YES;}
@end

@interface MacFXPresentationLayer : CAMetalLayer
@end
@implementation MacFXPresentationLayer
- (CALayer *)hitTest:(CGPoint)point {return nil;}
@end

struct macfx::ViewPresentation::Impl:std::enable_shared_from_this<Impl> {
    __weak NSView *source;
    __weak NSView *targetView;
    __weak CAMetalLayer *renderLayer;
    const void *sourcePublisher=nullptr;
    bool layerLocal=false,virtualOutput=false;
    MacFXPresentationView *overlay;
    CAMetalLayer *layer;
    std::shared_ptr<FramePresenter> presenter;
    std::shared_ptr<ViewPresentation> previousOwner;
    std::atomic<bool>stopped{false},suspended{false},revealQueued{false},revealed{false};
    unsigned width=0,height=0;
    std::atomic<uint64_t> extent{0};
    std::mutex submission;uint64_t nextFrame=0;
    uint64_t revealAfter=0;
    bool preparedVirtual=false;double revealTime=0,preparationBegan=0;
    bool replayOnVisibility=false;double visibilityBegan=0;
    VirtualBackgroundActivation backgroundActivation;
    NSArray *visibilityObservers=nil;
    Impl(NSView *view,unsigned w,unsigned h,const PresenterConfig &config,CGColorSpaceRef color,std::shared_ptr<ViewPresentation> previous):previousOwner(std::move(previous)) {
        if(!NSThread.isMainThread||!view.superview||!view.window||!w||!h)
            throw std::runtime_error("Presentation requires an attached game view");
        source=view;sourcePublisher=virtualPublisherIdentity(view);
        layer=[CAMetalLayer layer];layer.device=MTLCreateSystemDefaultDevice();
        layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.framebufferOnly=NO;layer.colorspace=color;
        layer.opaque=YES;layer.displaySyncEnabled=YES;
        const auto destination=virtualPresentationSource(view,CGSizeMake(w,h));
        targetView=destination.active?destination.view:view;virtualOutput=destination.active;
        NSView *display=targetView;
        // Keep presentation inside the application content hierarchy. Inserting
        // a sibling of NSWindow.contentView mutates AppKit's private theme-frame
        // children and can disturb title/traffic-light layout during resizing.
        overlay=[[MacFXPresentationView alloc]initWithFrame:display.bounds];
        overlay.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
        overlay.wantsLayer=YES;overlay.layer=layer;overlay.hidden=YES;
        presenter=std::make_shared<FramePresenter>(layer,this,config);
        preparedVirtual=virtualOutput&&virtualWindowPrepared(view);
        if(preparedVirtual)presenter->retainCompletedFrameForReplay(true);
        [display addSubview:overlay positioned:NSWindowAbove relativeTo:nil];
        update(view,w,h);
    }
    Impl(CAMetalLayer *input,NSView *view,unsigned w,unsigned h,const PresenterConfig &config,CGColorSpaceRef color,std::shared_ptr<ViewPresentation> previous):previousOwner(std::move(previous)) {
        if(!NSThread.isMainThread||!input||!input.device||!view.window||!w||!h)
            throw std::runtime_error("Presentation requires an attached game layer");
        // A transparent replacement over an unchanged transparent drawable
        // would composite the game twice. Ordinary in-place effects remain
        // available for such a layer until the publisher can retire its base.
        if(!input.opaque)throw std::runtime_error("Layer presentation requires an opaque game drawable");
        source=view;sourcePublisher=virtualPublisherIdentity(view);targetView=view;renderLayer=input;layerLocal=true;
        layer=[MacFXPresentationLayer layer];layer.device=input.device;
        layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.framebufferOnly=NO;layer.colorspace=color;
        layer.opaque=YES;layer.displaySyncEnabled=YES;layer.hidden=YES;
        presenter=std::make_shared<FramePresenter>(layer,this,config);
        [CATransaction begin];[CATransaction setDisableActions:YES];
        [input insertSublayer:layer atIndex:0];[CATransaction commit];
        update(view,w,h);
    }
    bool attached(NSView *view)const {
        if(view!=source||!view.window||!view.window.visible||view.window.miniaturized||view.hiddenOrHasHiddenAncestor)return false;
        if(virtualOutput&&(preparedVirtual||replayOnVisibility)&&!targetView.window.visible)return false;
        if(!layerLocal)return targetView&&overlay.superview==targetView;
        CAMetalLayer *input=renderLayer;
        if(!input||!input.opaque||input.device!=layer.device||layer.superlayer!=input)return false;
        unsigned depth=0;
        for(CALayer *at=input;at;at=at.superlayer)if(at.hidden||++depth>256)return false;
        return true;
    }
    void hide(){if(layerLocal)layer.hidden=YES;else overlay.hidden=YES;}
    VirtualWindowVisibility visibility()const {
        NSWindow *original=source.window,*output=targetView.window;
        return {bool(NSApp.active),bool(NSApp.hidden),bool(original.visible),bool(output.visible),bool(original.onActiveSpace),bool(output.onActiveSpace),
            bool(original.miniaturized),bool(output.miniaturized),virtualWindowTransitioning(source),
            bool(original.occlusionState&NSWindowOcclusionStateVisible),bool(output.occlusionState&NSWindowOcclusionStateVisible),
            bool(output.opaque&&output.alphaValue>=1),revealed.load()};
    }
    void observeVisibility(){
        if(!preparedVirtual)return;std::weak_ptr<Impl>weak=shared_from_this();NSMutableArray *observers=[NSMutableArray new];
        for(NSWindow *window in @[source.window,targetView.window])for(NSString *name in @[NSWindowDidChangeOcclusionStateNotification,NSWindowWillCloseNotification])
            [observers addObject:[NSNotificationCenter.defaultCenter addObserverForName:name object:window queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification){
                if(auto self=weak.lock();self&&!self->stopped.load()){
                    if([notification.name isEqualToString:NSWindowWillCloseNotification]){self->shutdown(true);return;}
                    if(self->replayOnVisibility&&!self->revealQueued.exchange(true))self->reveal();
                }
            }]];
        visibilityObservers=[observers copy];
    }
    void update(NSView *view,unsigned w,unsigned h) {
        if(!NSThread.isMainThread)throw std::runtime_error("Presentation layout requires the main thread");
        if(stopped.load())return;
        // Miniaturization suspends an owned virtual pair. It does not retire
        // the publisher or its presentation, which must resume on restoration.
        if(virtualOutput&&virtualWindowSuspended(view.window)){suspended.store(true);return;}
        suspended.store(false);
        if(!attached(view)){shutdown(true);return;}
        NSView *display=targetView;
        // A non-proxy source can later need real allocation reduction. Retire
        // this target before the resolver recreates it with a virtual session;
        // keeping it would never enter the proxy constructor/resize path.
        if(!layerLocal&&!virtualOutput&&virtualPresentationRequired(view)){shutdown(true);return;}
        if(virtualOutput){
            const auto destination=virtualPresentationSource(view,CGSizeMake(w,h));
            if(!destination.active||destination.view!=display){shutdown(true);return;}
            w=unsigned(destination.outputPixels.width);h=unsigned(destination.outputPixels.height);
        }
        presenter->setDisplay([display.window.screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue]);
        const CGRect frame=layerLocal?renderLayer.bounds:display.bounds;
        const CGFloat scale=layerLocal?renderLayer.contentsScale:display.window.backingScaleFactor;
        const bool changed=width!=w||height!=h||layer.contentsScale!=scale||!CGRectEqualToRect(layerLocal?layer.frame:overlay.frame,frame);
        // Keep the last completed processed image fitted to the native view
        // while resized targets are prepared. Revealing the original publisher
        // between slow reconstructions would alternate raw and processed frames.
        if(changed){if(!revealed.load()){hide();revealAfter=presenter->snapshot().completedReal;}width=w;height=h;}
        if(changed){[CATransaction begin];[CATransaction setDisableActions:YES];
            if(layerLocal)layer.frame=frame;
            else {overlay.frame=frame;layer.frame=overlay.bounds;}
            layer.contentsScale=scale;
            layer.drawableSize=CGSizeMake(w,h);extent.store((uint64_t(w)<<32)|h);[CATransaction commit];}
    }
    void reveal(unsigned attempts=0) {
        if(stopped.load()){revealQueued.store(false);return;}
        if(preparedVirtual&&!preparationBegan)preparationBegan=CACurrentMediaTime();
        NSView *view=source;
        if(virtualOutput&&virtualWindowSuspended(view.window)){suspended.store(true);revealQueued.store(false);return;}
        if(!attached(view)){shutdown(true);revealQueued.store(false);return;}
        const auto status=presenter->snapshot();
        if(!status.reason.empty()){shutdown(true);revealQueued.store(false);return;}
        if((preparedVirtual||replayOnVisibility)&&(!sourcePublisher||sourcePublisher!=virtualPublisherIdentity(view))){
            failVirtualWindowPreparation(view,targetView);shutdown(true);revealQueued.store(false);return;
        }
        if(replayOnVisibility){
            // GPU-ready background activation is not physical presentation.
            // Keep its immutable image until a later real display callback.
            if(presenter->lastRealPresentedTime()>=revealTime){replayOnVisibility=false;presenter->retainCompletedFrameForReplay(false);revealQueued.store(false);return;}
            const auto visible=visibility();
            if(!virtualVisibilityUsable(visible)||!visible.outputVisible){visibilityBegan=0;revealQueued.store(false);return;}
            if(!visibilityBegan)visibilityBegan=CACurrentMediaTime();
            if(presenter->completedFrameReplayReady()&&attempts%4==0)presenter->replayCompletedFrame();
            const auto budget=presenter->completedFrameReplayReady()?3.0:30.0;
            if(CACurrentMediaTime()-visibilityBegan>=budget){shutdown(true);revealQueued.store(false);return;}
            auto self=shared_from_this();dispatch_after(dispatch_time(DISPATCH_TIME_NOW,16*NSEC_PER_MSEC),dispatch_get_main_queue(),^{self->reveal(attempts+1);});return;
        }
        if(preparedVirtual&&!virtualWindowPrepared(view)){shutdown(true);revealQueued.store(false);return;}
        if(status.completedReal>revealAfter&&(!preparedVirtual||presenter->completedFrameReplayReady())){
            if(!revealed.load()){
                const auto gate=preparedVirtual?backgroundActivation.beforeReveal(visibility(),CACurrentMediaTime()):VirtualRevealGate::Physical;
                if(gate==VirtualRevealGate::Wait||gate==VirtualRevealGate::Defer)goto waitForVisibility;
                revealTime=CACurrentMediaTime();if(layerLocal)layer.hidden=NO;else overlay.hidden=NO;
                if(virtualOutput)revealVirtualWindow(view);revealed.store(true);
            if(previousOwner){auto previous=std::move(previousOwner);
                if(virtualOutput&&previous->impl->targetView==targetView)previous->impl->virtualOutput=false;
                previous->stop();}
            }
            if(!preparedVirtual){revealQueued.store(false);return;}
            const auto visible=visibility();
            if(virtualVisibilityUsable(visible)&&presenter->lastRealPresentedTime()>=revealTime&&commitVirtualWindow(view,targetView)){
                preparedVirtual=false;presenter->retainCompletedFrameForReplay(false);revealQueued.store(false);return;
            }
            if(presenter->completedFrameReplayReady()&&backgroundActivation.canCommitCovered(visible,CACurrentMediaTime())&&commitVirtualWindow(view,targetView)){
                preparedVirtual=false;replayOnVisibility=true;revealQueued.store(false);
                nativeLog("Virtual source activation: completed image retained while both windows are occluded; physical presentation is pending");return;
            }
            // Occluding the original may pause its producer. Reuse the exact
            // completed image/ID instead of asking for synthetic source work.
            if(attempts%4==0)presenter->replayCompletedFrame();
        }
        waitForVisibility:
        const bool expired=preparedVirtual?(revealTime?CACurrentMediaTime()-revealTime>=3:CACurrentMediaTime()-preparationBegan>=30):attempts>=120;
        if(expired){if(preparedVirtual){failVirtualWindowPreparation(view,targetView);shutdown(true);}revealQueued.store(false);return;}
        auto self=shared_from_this();dispatch_after(dispatch_time(DISPATCH_TIME_NOW,16*NSEC_PER_MSEC),dispatch_get_main_queue(),^{self->reveal(attempts+1);});
    }
    FrameResult submit(id<MTLCommandBuffer>commands,id<MTLTexture>texture,uint64_t frame,double time,const DepthFrame *depth=nullptr,bool opaque=true) {
        if(stopped.load()){FrameResult r;r.reason="Game presentation is detached";return r;}
        if(suspended.load()){FrameResult r;r.busy=true;r.reason="Game presentation is minimized";return r;}
        std::lock_guard<std::mutex>serial(submission);
        const auto assigned=frame?frame:nextFrame+1;
        DepthFrame actual=depth?*depth:DepthFrame{};
        // Zero is assigned here only for this synchronous, same-buffer capture.
        if(depth&&!frame&&!actual.frameId)actual.frameId=assigned;
        auto result=presenter->submitDisplayFrame(commands,texture,assigned,time,opaque,depth?&actual:nullptr);
        if(result.encoded)nextFrame=assigned;
        if(result.encoded&&virtualSourceFramePending((__bridge const void*)source)){
            // A source resize is accepted only after the producer has really
            // completed a frame at that extent. A retiring target must never
            // acknowledge a replacement session or selected non-proxy source.
            std::weak_ptr<Impl> weakSelf=shared_from_this();
            __weak NSView *frameSource=source,*frameTarget=targetView;
            const void *framePublisher=sourcePublisher;
            const CGSize sourcePixels=CGSizeMake(texture.width,texture.height);
            [commands addCompletedHandler:^(id<MTLCommandBuffer> completed){
                if(completed.status!=MTLCommandBufferStatusCompleted)return;
                dispatch_async(dispatch_get_main_queue(),^{
                    auto self=weakSelf.lock();NSView *view=frameSource,*target=frameTarget;
                    if(self&&!self->stopped.load()&&view&&target)
                        virtualSourceFrameReady(view,target,sourcePixels,framePublisher);
                });
            }];
        }
        if(result.encoded&&!revealed.load()&&!revealQueued.exchange(true)){auto self=shared_from_this();dispatch_async(dispatch_get_main_queue(),^{self->reveal();});}
        return result;
    }
    void shutdown(bool preservePrevious=false) {
        if(!preservePrevious&&previousOwner){previousOwner->stop();previousOwner.reset();}
        if(stopped.exchange(true))return;
        presenter->stop();
        MacFXPresentationView *held=overlay;
        CAMetalLayer *heldLayer=layerLocal?layer:nil;
        NSView *heldSource=source,*heldTarget=targetView;const bool restoreVirtual=virtualOutput&&!previousOwner;
        NSArray *heldObservers=visibilityObservers;
        void(^remove)(void)=^{for(id observer in heldObservers)[NSNotificationCenter.defaultCenter removeObserver:observer];held.hidden=YES;[held removeFromSuperview];held.layer=nil;heldLayer.hidden=YES;[heldLayer removeFromSuperlayer];if(restoreVirtual)stopVirtualWindow(heldSource,heldTarget);};
        if(NSThread.isMainThread)remove();else dispatch_async(dispatch_get_main_queue(),remove);layer=nil;overlay=nil;
    }
    ~Impl(){shutdown();}
};
macfx::ViewPresentation::ViewPresentation(NSView*v,unsigned w,unsigned h,const PresenterConfig&c):ViewPresentation(v,w,h,c,nullptr){}
macfx::ViewPresentation::ViewPresentation(CAMetalLayer*l,NSView*v,unsigned w,unsigned h,const PresenterConfig&c):ViewPresentation(l,v,w,h,c,l.colorspace){}
macfx::ViewPresentation::ViewPresentation(NSView*v,unsigned w,unsigned h,const PresenterConfig&c,CGColorSpaceRef color,std::shared_ptr<ViewPresentation>previous){try{impl=std::make_shared<Impl>(v,w,h,c,color,previous);impl->observeVisibility();}catch(...){if(!previous)stopVirtualWindow(v);throw;}}
macfx::ViewPresentation::ViewPresentation(CAMetalLayer*l,NSView*v,unsigned w,unsigned h,const PresenterConfig&c,CGColorSpaceRef color,std::shared_ptr<ViewPresentation>previous):impl(std::make_shared<Impl>(l,v,w,h,c,color,std::move(previous))){}
bool macfx::ViewPresentation::failedForCurrentContract(unsigned w,unsigned h,MTLPixelFormat format,id<MTLDevice>device){return impl->presenter->gpuFailureMatchesCurrent(w,h,format,device);}
bool macfx::ViewPresentation::colorSpaceMatches(CGColorSpaceRef color)const{return sameImageColorSpace(impl->layer.colorspace,color);}
std::shared_ptr<macfx::ViewPresentation> macfx::ViewPresentation::takePreviousOutput(){return impl->stopped.load()?std::exchange(impl->previousOwner,{}):nullptr;}
macfx::ViewPresentation::~ViewPresentation(){stop();}
void macfx::ViewPresentation::update(NSView*v,unsigned w,unsigned h){impl->update(v,w,h);}
void macfx::ViewPresentation::update(CAMetalLayer*l,NSView*v,unsigned w,unsigned h){if(l!=impl->renderLayer){impl->shutdown(true);return;}impl->update(v,w,h);}
macfx::FrameResult macfx::ViewPresentation::submit(id<MTLCommandBuffer>c,id<MTLTexture>t,uint64_t f,double time){return impl->submit(c,t,f,time);}
macfx::FrameResult macfx::ViewPresentation::submitWithDepth(id<MTLCommandBuffer>c,id<MTLTexture>t,uint64_t f,double time,const DepthFrame&d){return impl->submit(c,t,f,time,&d);}
macfx::FrameResult macfx::ViewPresentation::submitDisplayFrame(id<MTLCommandBuffer>c,id<MTLTexture>t,uint64_t f,double time,bool opaque,const DepthFrame*d){return impl->submit(c,t,f,time,d,opaque);}
macfx::PresenterStatus macfx::ViewPresentation::snapshot()const{return impl->presenter->snapshot();}
bool macfx::ViewPresentation::requiresDepth()const{return !impl->stopped.load()&&impl->presenter->requiresDepth();}
CGSize macfx::ViewPresentation::outputSize()const{const auto size=impl->extent.load();return CGSizeMake(size>>32,uint32_t(size));}
bool macfx::ViewPresentation::canHoldPresentation(std::string&reason)const{
    if(!NSThread.isMainThread||impl->stopped.load()||impl->suspended.load()||!impl->revealed.load()||impl->layerLocal||impl->virtualOutput||
       !impl->attached(impl->source)||impl->overlay.hidden||!impl->layer.opaque||impl->layer.pixelFormat!=MTLPixelFormatBGRA8Unorm){
        reason="A visible ordinary owned opaque SDR output is required for this live update";return false;}
    const auto status=impl->presenter->snapshot();
    if(!status.presentedReal&&!status.presentedGenerated){reason="The owned output has not reached the display yet";return false;}return true;
}
unsigned macfx::ViewPresentation::presentationWindow()const{return NSThread.isMainThread?unsigned(impl->source.window.windowNumber):0;}
macfx::PresentationHoldStatus macfx::ViewPresentation::beginPresentationHold(const PresentationHoldCommand&command){
    std::string reason;if(canHoldPresentation(reason))return impl->presenter->beginPresentationHold(command);
    PresentationHoldStatus result;result.state="failed";result.epoch=command.epoch;result.transactionId=command.transactionId;result.reason=reason;result.holding=presentationHeld();return result;
}
macfx::PresentationHoldStatus macfx::ViewPresentation::resumePresentationHold(const PresentationHoldCommand&command){auto status=impl->presenter->resumePresentationHold(command);if(status.state=="abandoned"&&!status.holding)impl->shutdown();return status;}
macfx::PresentationHoldStatus macfx::ViewPresentation::presentationHoldStatus()const{return impl->presenter->presentationHoldStatus();}
bool macfx::ViewPresentation::presentationHeld()const{return !impl->stopped.load()&&impl->presenter->presentationHeld();}
void macfx::ViewPresentation::setNativeMetalCapabilities(bool inPlace,bool owned,bool required){impl->presenter->setNativeMetalCapabilities(inPlace,owned,required);}
void macfx::ViewPresentation::stop(){if(impl)impl->shutdown();}
