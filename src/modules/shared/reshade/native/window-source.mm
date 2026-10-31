#include "window-source.h"
#include "window-stream.hpp"
#include "window-overlay-policy.hpp"
#include "effects-execution.hpp"
#include "effects-plan.hpp"
#include "source-frame-pacing.hpp"
#include "graphics.hpp"
#include "live-controls.hpp"
#include "diagnostics.hpp"
#include <algorithm>
#include <cstring>
#include <unistd.h>
#include <vector>

@interface MacFXWindowSourceOutputWindow : NSPanel
@end
@implementation MacFXWindowSourceOutputWindow
- (BOOL)canBecomeKeyWindow{return NO;}
- (BOOL)canBecomeMainWindow{return NO;}
@end
// The overlay's content view hosts the presenter's layer. In place, the panel
// ignores the pointer; Scaled output hands pointer events to the source,
// which forwards them to the target window.
@interface MacFXWindowSourceView : NSView
@property(nonatomic,copy) void (^forward)(NSEvent *);
@end
@implementation MacFXWindowSourceView
- (instancetype)initWithFrame:(NSRect)frame{
    if((self=[super initWithFrame:frame]))[self addTrackingArea:[[NSTrackingArea alloc]initWithRect:NSZeroRect
        options:NSTrackingMouseMoved|NSTrackingActiveAlways|NSTrackingInVisibleRect owner:self userInfo:nil]];
    return self;
}
- (BOOL)acceptsFirstMouse:(NSEvent *)event{return YES;}
- (void)send:(NSEvent *)event{if(self.forward)self.forward(event);}
- (void)mouseDown:(NSEvent *)event{[self send:event];}
- (void)mouseUp:(NSEvent *)event{[self send:event];}
- (void)mouseDragged:(NSEvent *)event{[self send:event];}
- (void)mouseMoved:(NSEvent *)event{[self send:event];}
- (void)rightMouseDown:(NSEvent *)event{[self send:event];}
- (void)rightMouseUp:(NSEvent *)event{[self send:event];}
- (void)rightMouseDragged:(NSEvent *)event{[self send:event];}
- (void)otherMouseDown:(NSEvent *)event{[self send:event];}
- (void)otherMouseUp:(NSEvent *)event{[self send:event];}
- (void)otherMouseDragged:(NSEvent *)event{[self send:event];}
- (void)scrollWheel:(NSEvent *)event{[self send:event];}
@end

namespace {
// The second client of the completed-window core: a picked window or display
// of any process, shown in an overlay that the handle owns.
struct Source :macfx::WindowStream {
    MacFXWindowSourceOutputWindow *output=nil;
    std::string failure;bool userStopped=false;
    Source(){label="Window";admissionStage="window-capture-memory";}
    void hostClosed()override{if(output)[output orderOut:nil];output=nil;[layer removeFromSuperlayer];}
    void hostFailed(const std::string &message)override{failure=message;}
    void placeOutput(NSRect frame)override{if(output&&!NSEqualRects(output.frame,frame))[output setFrame:frame display:NO];}
    void streamStopped(NSError *error)override{
        // Stop Sharing in the system capture indicator ends the session.
        // The flag is read on the main thread after the close that fail()
        // dispatches there.
        if([error.domain isEqualToString:SCStreamErrorDomain]&&error.code==SCStreamErrorUserStopped)userStopped=true;
        WindowStream::streamStopped(error);
    }
};
struct Target {bool exists=false,onScreen=false,overlapped=false;int pid=0;macfx::WindowRect bounds;};
double number(NSDictionary *info,const void *key){NSNumber *value=info[(__bridge NSString*)key];return [value isKindOfClass:NSNumber.class]?value.doubleValue:0;}
macfx::WindowRect bounds(NSDictionary *info){
    CGRect rect=CGRectZero;NSDictionary *value=info[(__bridge NSString*)kCGWindowBounds];
    if(![value isKindOfClass:NSDictionary.class]||!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)value,&rect))return {};
    return {rect.origin.x,rect.origin.y,rect.size.width,rect.size.height};
}
// Window-server metadata only: bounds, layer, owner and on-screen state need
// no capture permission and never touch the window.
// A minimized window or one of a hidden app still exists, off screen; a
// closed window no longer has a description. ownWindows counts only the
// target app's windows as covering it.
Target windowTarget(uint32_t window,bool ownWindows){
    Target result;
    const void *identifier=reinterpret_cast<const void*>(uintptr_t(window));
    CFArrayRef ids=CFArrayCreate(nullptr,&identifier,1,nullptr);
    NSArray *list=ids?CFBridgingRelease(CGWindowListCreateDescriptionFromArray(ids)):nil;
    if(ids)CFRelease(ids);
    for(NSDictionary *info in list)if(uint32_t(number(info,kCGWindowNumber))==window){
        result.exists=true;result.bounds=bounds(info);result.onScreen=[info[(__bridge NSString*)kCGWindowIsOnscreen] boolValue];
        result.pid=int(number(info,kCGWindowOwnerPID));break;
    }
    if(!result.exists||!result.onScreen)return result;
    NSArray *above=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenAboveWindow,window));
    std::vector<macfx::WindowAbove>rows;rows.reserve(above.count);
    for(NSDictionary *info in above)rows.push_back({bounds(info),int(number(info,kCGWindowLayer)),int(number(info,kCGWindowOwnerPID)),
        info[(__bridge NSString*)kCGWindowAlpha]?number(info,kCGWindowAlpha):1});
    result.overlapped=macfx::windowOverlapped(result.bounds,rows.data(),unsigned(rows.size()),getpid(),ownWindows?result.pid:0);
    return result;
}
Target displayTarget(uint32_t display){
    Target result;if(!CGDisplayIsActive(display))return result;
    const auto rect=CGDisplayBounds(display);result.exists=true;result.onScreen=!CGDisplayIsAsleep(display);
    result.bounds={rect.origin.x,rect.origin.y,rect.size.width,rect.size.height};return result;
}
// The screen that holds the target's center, with its visible frame, in
// window-server coordinates. The same flip converts in both directions.
struct ScreenArea {macfx::WindowRect frame,visible;};
ScreenArea targetScreen(const macfx::WindowRect &bounds,double primary){
    const auto f=macfx::windowOverlayFrame(bounds,primary);const NSPoint center=NSMakePoint(f.x+f.width/2,f.y+f.height/2);
    NSScreen *chosen=nil;for(NSScreen *screen in NSScreen.screens)if(NSPointInRect(center,screen.frame)){chosen=screen;break;}
    if(!(chosen=chosen?:NSScreen.mainScreen))return {};
    const auto flip=[&](NSRect r){return macfx::windowOverlayFrame({r.origin.x,r.origin.y,r.size.width,r.size.height},primary);};
    return {flip(chosen.frame),flip(chosen.visibleFrame)};
}
CGFloat screenScale(NSRect frame,uint32_t display){
    for(NSScreen *screen in NSScreen.screens){
        NSNumber *number=screen.deviceDescription[@"NSScreenNumber"];
        if(display?number.unsignedIntValue==display:NSPointInRect(NSMakePoint(NSMidX(frame),NSMidY(frame)),screen.frame))return screen.backingScaleFactor;
    }
    return NSScreen.mainScreen.backingScaleFactor?:1;
}
void copyReason(char *buffer,size_t size,const std::string &reason){if(!buffer||!size)return;const auto count=std::min(size-1,reason.size());std::memcpy(buffer,reason.data(),count);buffer[count]=0;}
struct SourceHandle {
    RSWindowSourceOptions options{};
    MacFXWindowSourceOutputWindow *output=nil;MacFXWindowSourceView *view=nil;CALayer *container=nil;
    SCContentFilter *filter=nil;uint32_t windowID=0,displayID=0;
    std::shared_ptr<Source>session;
    uint32_t state=RS_WINDOW_SOURCE_WAITING;std::string reason;
    bool failed=false;macfx::BrowserFrameAttemptContract failedContract{};macfx::WindowStreamRecovery recovery;
    // Scaled output's pointer mapping, refreshed by each poll.
    struct Mapping {bool active=false;int pid=0;macfx::WindowRect area,image,target;}mapping;
    uintptr_t context()const{return reinterpret_cast<uintptr_t>((__bridge void*)output);}
    uint32_t identity()const{return windowID?windowID:displayID;}
    bool scaled()const{return windowID&&(options.flags&RS_WINDOW_SOURCE_SCALED);}
    // The plan's frame-rate cap limits capture as it limits any other frame
    // source; an explicit capture rate from the host replaces it.
    double captureInterval()const{return macfx::windowCaptureInterval(options.captureRate>0?options.captureRate:macfx::sourceFrameRateCap());}
    void end(){mapping.active=false;if(session){session->close();session.reset();}[output orderOut:nil];}
    bool start(const macfx::BrowserFrameGeometry &g,NSRect frame,CGFloat scale,CGSize drawable){
        auto s=std::make_shared<Source>();s->window=identity();s->geometry=g;s->width=g.pixelsWidth;s->height=g.pixelsHeight;
        s->showsCursor=options.flags&RS_WINDOW_SOURCE_CURSOR;s->includeChildWindows=windowID!=0;
        s->minimumInterval=captureInterval();
        if(!s->prepareDevice()){reason="Window capture could not prepare its GPU resources; original window retained";return false;}
        s->output=output;output.ignoresMouseEvents=!scaled();
        // Window corners keep their captured alpha; a display is opaque.
        s->prepareLayer(scale,displayID!=0);if(drawable.width>0&&drawable.height>0)s->layer.drawableSize=drawable;
        [container addSublayer:s->layer];s->placeOutput(frame);
        s->preparePresenter(macfx::RuntimeFrameSource::ExternalWindow,std::optional<bool>(displayID!=0));
        if(NSError *failure=s->attach(filter)){s->close();reason="Window graphics unavailable: "+macfx::windowCaptureError("output",failure)+"; original window retained";return false;}
        session=s;
        s->startCapture(^{macfx::nativeLog("Window source=picked-"+std::string(windowID?"window":"display")+" id="+std::to_string(identity())+
            " extent="+std::to_string(g.pixelsWidth)+"x"+std::to_string(g.pixelsHeight));});
        return true;
    }
    // The presenter's layer inside the overlay view: the whole view in place,
    // the letterbox for Scaled output, whose bars stay black once a frame
    // is shown.
    void placeImage(const macfx::WindowRect &image){
        [CATransaction begin];[CATransaction setDisableActions:YES];
        container.frame=view.bounds;
        container.backgroundColor=scaled()&&session->revealed?NSColor.blackColor.CGColor:nil;
        const NSRect rect=NSMakeRect(image.x,image.y,image.width,image.height);
        if(!NSEqualRects(session->layer.frame,rect))session->layer.frame=rect;
        [CATransaction commit];
    }
    // Scaled output: a pointer event on the image goes to the matching point
    // of the target window, addressed to that window, in the target's process.
    void forward(NSEvent *event){ // Main thread.
        if(!mapping.active||!mapping.pid||!windowID)return;
        const NSPoint local=[view convertPoint:event.locationInWindow fromView:nil];
        auto point=macfx::windowViewPoint(mapping.area,local.x,local.y);
        // A drag or release that leaves the image stays on its edge, so a
        // press on the image always ends in the target.
        const auto type=event.type;
        if(type==NSEventTypeLeftMouseDragged||type==NSEventTypeRightMouseDragged||type==NSEventTypeOtherMouseDragged||
           type==NSEventTypeLeftMouseUp||type==NSEventTypeRightMouseUp||type==NSEventTypeOtherMouseUp){
            point.x=std::clamp(point.x,mapping.image.x,mapping.image.x+mapping.image.width);
            point.y=std::clamp(point.y,mapping.image.y,mapping.image.y+mapping.image.height);
        }
        const auto mapped=macfx::windowMapPoint(mapping.image,mapping.target,point.x,point.y);
        CGEventRef source=event.CGEvent;if(!mapped||!source)return;
        CGEventRef copy=CGEventCreateCopy(source);if(!copy)return;
        CGEventSetLocation(copy,CGPointMake(mapped->x,mapped->y));
        CGEventSetIntegerValueField(copy,kCGMouseEventWindowUnderMousePointer,windowID);
        CGEventSetIntegerValueField(copy,kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent,windowID);
        CGEventPostToPid(mapping.pid,copy);CFRelease(copy);
    }
    void poll(){ // Main thread.
        if(!filter){state=RS_WINDOW_SOURCE_WAITING;return;}
        if(state==RS_WINDOW_SOURCE_CLOSED)return;
        const bool scaledOutput=scaled();
        const auto target=windowID?windowTarget(windowID,scaledOutput):displayTarget(displayID);
        if(!target.exists){end();state=RS_WINDOW_SOURCE_CLOSED;reason=windowID?"The window closed":"The display is no longer available";return;}
        if(session&&session->closed&&session->userStopped){end();state=RS_WINDOW_SOURCE_CLOSED;reason="Sharing was stopped";return;}
        const bool processing=macfx::imageProcessingRequested();
        if(options.suspended||!processing){
            // Off keeps the target; turning an effect back on resumes it.
            end();failed=false;recovery.reset();
            if(!processing)macfx::observeBypassedPlan(context());
            state=options.suspended?RS_WINDOW_SOURCE_SUSPENDED:RS_WINDOW_SOURCE_OFF;return;
        }
        const auto primary=NSScreen.screens.firstObject.frame.size.height;
        // Scaled output covers the target's screen area with the letterboxed
        // image; in place, the overlay covers the target itself.
        macfx::WindowRect area=target.bounds,image{0,0,target.bounds.width,target.bounds.height};
        if(scaledOutput){
            const auto screen=targetScreen(target.bounds,primary);
            area=macfx::windowScaledArea(target.bounds,screen.frame,screen.visible);
            image=macfx::windowLetterbox(area,target.bounds.width,target.bounds.height);
        }
        const auto overlay=macfx::windowOverlayFrame(area,primary);
        const NSRect frame=NSMakeRect(overlay.x,overlay.y,overlay.width,overlay.height);
        const auto scale=screenScale(frame,displayID);
        const macfx::BrowserFrameGeometry g{0,0,target.bounds.width,target.bounds.height,
            macfx::windowPixelExtent(target.bounds.width,scale),macfx::windowPixelExtent(target.bounds.height,scale)};
        const CGSize drawable=scaledOutput?CGSizeMake(macfx::windowPixelExtent(image.width,scale),macfx::windowPixelExtent(image.height,scale)):CGSizeZero;
        if(!macfx::browserFrameGeometryValid(g)||(scaledOutput&&!(drawable.width>0&&drawable.height>0))){
            mapping.active=false;[output orderOut:nil];state=RS_WINDOW_SOURCE_HIDDEN;return;}
        const macfx::BrowserFrameAttemptContract contract{macfx::effectPlanDemandGeneration(),macfx::liveEffects()?macfx::liveState().generation:0};
        if(session&&session->closed){
            if(session->recoverAfterGeometry)recovery.arm(identity(),session->geometry,CACurrentMediaTime());
            reason=session->failure;failed=true;failedContract=contract;session.reset();
        }
        if(!session){
            // A failure retries once after the source settles, and again for
            // each later plan edit; it never loops on an unchanged plan.
            const bool retry=!failed||failedContract!=contract||recovery.ready(identity(),g,CACurrentMediaTime());
            if(!retry){[output orderOut:nil];state=RS_WINDOW_SOURCE_FAILED;return;}
            failed=false;reason.clear();
            if(!start(g,frame,scale,drawable)){failed=true;failedContract=contract;state=RS_WINDOW_SOURCE_FAILED;macfx::nativeLog(reason);return;}
        }else {session->update(g,frame,scale,drawable);session->minimumInterval=captureInterval();}
        session->reveal();session->pollPublication();
        placeImage(scaledOutput?macfx::windowLetterboxInView(area,image):macfx::WindowRect{0,0,area.width,area.height});
        const bool active=!scaledOutput||NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==target.pid;
        const bool shown=macfx::windowOverlayShown({processing,target.onScreen,target.overlapped,options.suspended!=0,scaledOutput,active});
        mapping={shown&&scaledOutput,target.pid,area,image,target.bounds};
        if(shown&&!output.visible)[output orderFrontRegardless];else if(!shown&&output.visible)[output orderOut:nil];
        state=shown?RS_WINDOW_SOURCE_RUNNING:RS_WINDOW_SOURCE_HIDDEN;
    }
};
template<class F>int guarded(F &&f,int failure=0){@try{try{return f();}catch(...){return failure;}}@catch(NSException *){return failure;}}
}

extern "C" void *rsWindowSourceCreate(const RSWindowSourceOptions *options,RSPresenterError *error){
    if(!NSThread.isMainThread||(options&&(options->size<sizeof(RSWindowSourceOptions)||options->version!=RS_WINDOW_SOURCE_ABI_VERSION))){
        if(error)copyReason(error->reason,sizeof(error->reason),"Window source options are invalid or not on the main thread");return nullptr;}
    void *result=nullptr;
    guarded([&]{
        auto *handle=new SourceHandle;if(options)handle->options=*options;
        auto *output=[[MacFXWindowSourceOutputWindow alloc]initWithContentRect:NSMakeRect(0,0,1,1) styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
        output.releasedWhenClosed=NO;output.ignoresMouseEvents=YES;output.hidesOnDeactivate=NO;
        auto *view=[[MacFXWindowSourceView alloc]initWithFrame:NSMakeRect(0,0,1,1)];
        view.layer=handle->container=[CALayer layer];view.wantsLayer=YES;output.contentView=view;handle->view=view;
        view.forward=^(NSEvent *event){guarded([&]{handle->forward(event);return 1;});};
        output.opaque=NO;output.backgroundColor=NSColor.clearColor;output.hasShadow=NO;output.level=NSFloatingWindowLevel;
        // The overlay is never an input of its own capture.
        output.sharingType=NSWindowSharingNone;
        output.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorFullScreenAuxiliary|
            NSWindowCollectionBehaviorStationary|NSWindowCollectionBehaviorIgnoresCycle;
        handle->output=output;result=handle;return 1;
    });
    if(!result&&error)copyReason(error->reason,sizeof(error->reason),"The window overlay could not be created");
    return result;
}
extern "C" uint32_t rsWindowSourceOutputWindow(void *value){return value?uint32_t(static_cast<SourceHandle*>(value)->output.windowNumber):0;}
extern "C" int rsWindowSourceSelect(void *value,const RSWindowSourceTarget *target,RSPresenterError *error){
    auto *handle=static_cast<SourceHandle*>(value);
    if(!handle||!NSThread.isMainThread||!target||target->size<sizeof(RSWindowSourceTarget)||target->version!=RS_WINDOW_SOURCE_ABI_VERSION||
       !target->filter||bool(target->windowID)==bool(target->displayID)){
        if(error)copyReason(error->reason,sizeof(error->reason),"Select one picked window or display");return 0;}
    return guarded([&]{
        id filter=(__bridge id)target->filter;if(![filter isKindOfClass:SCContentFilter.class])return 0;
        handle->end();handle->filter=filter;handle->windowID=target->windowID;handle->displayID=target->displayID;
        handle->state=RS_WINDOW_SOURCE_WAITING;handle->reason.clear();handle->failed=false;handle->recovery.reset();return 1;
    });
}
extern "C" int rsWindowSourceSetOptions(void *value,const RSWindowSourceOptions *options){
    auto *handle=static_cast<SourceHandle*>(value);
    if(!handle||!NSThread.isMainThread||!options||options->size<sizeof(RSWindowSourceOptions)||options->version!=RS_WINDOW_SOURCE_ABI_VERSION)return 0;
    // The cursor is a stream option and Scaled output changes the overlay's
    // geometry and input; either change takes effect with a new stream.
    const bool restart=(handle->options.flags^options->flags)&(RS_WINDOW_SOURCE_CURSOR|RS_WINDOW_SOURCE_SCALED);
    handle->options=*options;if(restart&&handle->session)handle->end();
    return 1;
}
extern "C" int rsWindowSourcePoll(void *value,RSWindowSourceStatus *status){
    auto *handle=static_cast<SourceHandle*>(value);
    if(!handle||!NSThread.isMainThread)return 0;
    const int polled=guarded([&]{handle->poll();return 1;});
    if(!polled){handle->end();handle->state=RS_WINDOW_SOURCE_FAILED;handle->reason="Window graphics update failed; original window retained";}
    if(status&&status->size>=sizeof(RSWindowSourceStatus)){
        status->state=handle->state;status->revealed=handle->session&&handle->session->revealed;
        status->captured=handle->session?handle->session->complete.load():0;status->dropped=handle->session?handle->session->dropped.load():0;
        status->presentedReal=status->presentedGenerated=0;status->pixelsWidth=status->pixelsHeight=0;
        if(handle->session&&handle->session->presenter){const auto snapshot=handle->session->presenter->snapshot();
            status->presentedReal=snapshot.presentedReal;status->presentedGenerated=snapshot.presentedGenerated;status->dropped+=snapshot.dropped;}
        if(handle->session){status->pixelsWidth=handle->session->width;status->pixelsHeight=handle->session->height;}
        copyReason(status->reason,sizeof(status->reason),handle->reason);
    }
    return polled;
}
extern "C" void rsWindowSourceDestroy(void *value){
    auto *handle=static_cast<SourceHandle*>(value);if(!handle)return;
    guarded([&]{handle->end();handle->view.forward=nil;[handle->output close];handle->output=nil;handle->filter=nil;return 1;});
    delete handle;
}
extern "C" unsigned rsWindowSourceAPI(){return RS_WINDOW_SOURCE_ABI_VERSION;}
