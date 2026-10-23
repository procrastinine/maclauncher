#include "view-presentation.hpp"
#include <atomic>
#include <mutex>
#include <stdexcept>

@interface MacFXPresentationView : NSView
@end
@implementation MacFXPresentationView
- (NSView *)hitTest:(NSPoint)point {return nil;}
- (BOOL)acceptsFirstResponder {return NO;}
- (BOOL)isOpaque {return YES;}
@end

struct macfx::ViewPresentation::Impl:std::enable_shared_from_this<Impl> {
    __weak NSView *source;
    MacFXPresentationView *overlay;
    CAMetalLayer *layer;
    std::shared_ptr<FramePresenter> presenter;
    std::atomic<bool>stopped{false},revealQueued{false},revealed{false};
    unsigned width=0,height=0;
    std::mutex submission;uint64_t nextFrame=0;
    uint64_t revealAfter=0;
    Impl(NSView *view,unsigned w,unsigned h,const PresenterConfig &config) {
        if(!NSThread.isMainThread||!view.superview||!view.window||!w||!h)
            throw std::runtime_error("Presentation requires an attached game view");
        source=view;
        layer=[CAMetalLayer layer];layer.device=MTLCreateSystemDefaultDevice();
        layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.framebufferOnly=NO;
        layer.opaque=YES;layer.displaySyncEnabled=NO;
        overlay=[[MacFXPresentationView alloc]initWithFrame:view.frame];
        overlay.wantsLayer=YES;overlay.layer=layer;overlay.hidden=YES;
        presenter=std::make_shared<FramePresenter>(layer,this,config);
        [view.superview addSubview:overlay positioned:NSWindowAbove relativeTo:view];
        update(view,w,h);
    }
    void update(NSView *view,unsigned w,unsigned h) {
        if(!NSThread.isMainThread)throw std::runtime_error("Presentation layout requires the main thread");
        if(stopped.load())return;
        if(view!=source||!view.superview||view.superview!=overlay.superview||!view.window||!view.window.visible||view.window.miniaturized||view.hiddenOrHasHiddenAncestor){shutdown();return;}
        const bool changed=width!=w||height!=h||!NSEqualRects(overlay.frame,view.frame);
        if(changed){revealed.store(false);overlay.hidden=YES;revealAfter=presenter->snapshot().completedReal;width=w;height=h;}
        if(changed){overlay.frame=view.frame;layer.frame=overlay.bounds;layer.contentsScale=view.window.backingScaleFactor;
            layer.drawableSize=CGSizeMake(w,h); }
    }
    void reveal(unsigned attempts=0) {
        if(stopped.load()){revealQueued.store(false);return;}
        NSView *view=source;
        if(!view||!view.window.visible||view.window.miniaturized||view.hiddenOrHasHiddenAncestor||view.superview!=overlay.superview){shutdown();revealQueued.store(false);return;}
        const auto status=presenter->snapshot();
        if(!status.reason.empty()){shutdown();revealQueued.store(false);return;}
        if(status.completedReal>revealAfter){overlay.hidden=NO;revealed.store(true);revealQueued.store(false);return;}
        if(attempts>=120){revealQueued.store(false);return;}
        auto self=shared_from_this();dispatch_after(dispatch_time(DISPATCH_TIME_NOW,16*NSEC_PER_MSEC),dispatch_get_main_queue(),^{self->reveal(attempts+1);});
    }
    FrameResult submit(id<MTLCommandBuffer>commands,id<MTLTexture>texture,uint64_t frame,double time) {
        if(stopped.load()){FrameResult r;r.reason="Game presentation is detached";return r;}
        std::lock_guard<std::mutex>serial(submission);
        const auto assigned=frame?frame:nextFrame+1;
        auto result=presenter->submit(commands,texture,assigned,time);
        if(result.encoded)nextFrame=assigned;
        if(result.encoded&&!revealed.load()&&!revealQueued.exchange(true)){auto self=shared_from_this();dispatch_async(dispatch_get_main_queue(),^{self->reveal();});}
        return result;
    }
    void shutdown() {
        if(stopped.exchange(true))return;
        presenter->stop();
        MacFXPresentationView *held=overlay;
        void(^remove)(void)=^{held.hidden=YES;[held removeFromSuperview];};
        if(NSThread.isMainThread)remove();else dispatch_async(dispatch_get_main_queue(),remove);
    }
    ~Impl(){shutdown();}
};
macfx::ViewPresentation::ViewPresentation(NSView*v,unsigned w,unsigned h,const PresenterConfig&c):impl(std::make_shared<Impl>(v,w,h,c)){}
macfx::ViewPresentation::~ViewPresentation(){stop();}
void macfx::ViewPresentation::update(NSView*v,unsigned w,unsigned h){impl->update(v,w,h);}
macfx::FrameResult macfx::ViewPresentation::submit(id<MTLCommandBuffer>c,id<MTLTexture>t,uint64_t f,double time){return impl->submit(c,t,f,time);}
macfx::PresenterStatus macfx::ViewPresentation::snapshot()const{return impl->presenter->snapshot();}
void macfx::ViewPresentation::stop(){if(impl)impl->shutdown();}
