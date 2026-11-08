#include "window-source.h"
#include "window-forwarded.hpp"
#include "window-output-policy.hpp"
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
#include <unordered_map>
#include <unordered_set>
#include <vector>

@interface MacFXWindowSourceOutputWindow : NSPanel
@end
// Calls a block from a display link or a timer.
@interface MacFXWindowSourceTick : NSObject
@property(nonatomic,copy) void (^block)(void);
- (void)tick:(id)sender;
@end
@implementation MacFXWindowSourceTick
- (void)tick:(id)sender{if(self.block)self.block();}
@end
@implementation MacFXWindowSourceOutputWindow
- (BOOL)canBecomeKeyWindow{return NO;}
- (BOOL)canBecomeMainWindow{return NO;}
@end
@interface MacFXWindowSourceView : NSView
@end
@implementation MacFXWindowSourceView
@end

namespace {
// The second client of the completed-window core: a picked window or display
// of any process, shown in an overlay that the handle owns.
struct Source :macfx::ForwardedStream {
    MacFXWindowSourceOutputWindow *output=nil;
    std::string failure;
    Source(){label="Window";admissionStage="window-capture-memory";}
    void hostClosed()override{if(output)[output orderOut:nil];output=nil;[layer removeFromSuperlayer];}
    void hostFailed(const std::string &message)override{failure=message;}
    void placeOutput(NSRect frame)override{if(output&&!NSEqualRects(output.frame,frame))[output setFrame:frame display:NO];}

};
// layer: the target window's window-server level, which places its overlay.
struct Target {bool exists=false,onScreen=false;int pid=0,layer=0;macfx::WindowRect bounds;};
double number(NSDictionary *info,const void *key){NSNumber *value=info[(__bridge NSString*)key];return [value isKindOfClass:NSNumber.class]?value.doubleValue:0;}
macfx::WindowRect bounds(NSDictionary *info){
    CGRect rect=CGRectZero;NSDictionary *value=info[(__bridge NSString*)kCGWindowBounds];
    if(![value isKindOfClass:NSDictionary.class]||!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)value,&rect))return {};
    return {rect.origin.x,rect.origin.y,rect.size.width,rect.size.height};
}
// Window-server metadata only: bounds, layer, owner and on-screen state need
// no capture permission and never touch the window.
// A minimized window or one of a hidden app still exists, off screen; a
// closed window no longer has a description.
Target windowTarget(uint32_t window){
    Target result;
    const void *identifier=reinterpret_cast<const void*>(uintptr_t(window));
    CFArrayRef ids=CFArrayCreate(nullptr,&identifier,1,nullptr);
    NSArray *list=ids?CFBridgingRelease(CGWindowListCreateDescriptionFromArray(ids)):nil;
    if(ids)CFRelease(ids);
    for(NSDictionary *info in list)if(uint32_t(number(info,kCGWindowNumber))==window){
        result.exists=true;result.bounds=bounds(info);result.onScreen=[info[(__bridge NSString*)kCGWindowIsOnscreen] boolValue];
        result.pid=int(number(info,kCGWindowOwnerPID));result.layer=int(number(info,kCGWindowLayer));break;
    }
    return result;
}
// The numbers of the windows above `window`, front to back.
std::vector<CGWindowID> windowsAbove(CGWindowID window){
    std::vector<CGWindowID> ids;
    if(CFArrayRef list=CGWindowListCreate(kCGWindowListOptionOnScreenAboveWindow|kCGWindowListExcludeDesktopElements,window)){
        for(CFIndex i=0,count=CFArrayGetCount(list);i<count;++i)ids.push_back(CGWindowID(uintptr_t(CFArrayGetValueAtIndex(list,i))));
        CFRelease(list);
    }
    return ids;
}
// Whether each window in `known` still exists with those bounds.
bool windowBoundsUnchanged(const std::unordered_map<uint32_t,macfx::WindowRect> &known){
    if(known.empty())return true;
    std::vector<const void*> ids;for(const auto &[id,rect]:known)ids.push_back(reinterpret_cast<const void*>(uintptr_t(id)));
    CFArrayRef array=CFArrayCreate(nullptr,ids.data(),CFIndex(ids.size()),nullptr);
    NSArray *list=array?CFBridgingRelease(CGWindowListCreateDescriptionFromArray(array)):nil;if(array)CFRelease(array);
    if(list.count!=known.size())return false;
    for(NSDictionary *info in list){
        const auto entry=known.find(uint32_t(number(info,kCGWindowNumber)));const auto now=bounds(info);
        if(entry==known.end()||entry->second.x!=now.x||entry->second.y!=now.y||entry->second.width!=now.width||entry->second.height!=now.height)return false;
    }
    return true;
}
// The windows that shape a capture as of the source's last full check: the
// windows above the target other than overlays, and the target's known
// child windows with their bounds. The main thread records them; the render
// queue compares them with the window server's current list for each frame,
// since a captured frame can show a new or moved child window before the
// main thread's next check learns of it.
struct CaptureWindows {
    std::mutex mutex;bool known=false;CGWindowID target=0;std::vector<CGWindowID> above;
    std::unordered_set<uint32_t> overlays;std::unordered_map<uint32_t,macfx::WindowRect> children;
    void record(CGWindowID window,const std::vector<CGWindowID> &ids,std::unordered_set<uint32_t> skip,const std::unordered_map<uint32_t,macfx::WindowRect> &bounds){
        std::vector<CGWindowID> kept;for(const auto id:ids)if(!skip.count(id))kept.push_back(id);
        std::lock_guard<std::mutex> lock(mutex);known=true;target=window;above=std::move(kept);overlays=std::move(skip);children=bounds;
    }
    void clear(){std::lock_guard<std::mutex> lock(mutex);known=false;above.clear();overlays.clear();children.clear();}
    bool settled(){
        CGWindowID window=0;std::vector<CGWindowID> expected;std::unordered_set<uint32_t> skip;std::unordered_map<uint32_t,macfx::WindowRect> bounds;
        {std::lock_guard<std::mutex> lock(mutex);if(!known)return true;window=target;expected=above;skip=overlays;bounds=children;}
        size_t index=0;
        for(const auto id:windowsAbove(window)){if(skip.count(id))continue;if(index==expected.size()||expected[index]!=id)return false;++index;}
        return index==expected.size()&&windowBoundsUnchanged(bounds);
    }
};
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
template<class F>int guarded(F &&f,int failure=0){@try{try{return f();}catch(...){return failure;}}@catch(NSException *){return failure;}}
// The overlay windows of this process, which never cover a target. Main
// thread.
std::unordered_set<uint32_t> &overlayWindows(){static std::unordered_set<uint32_t> windows;return windows;}
void copyReason(char *buffer,size_t size,const std::string &reason){if(!buffer||!size)return;const auto count=std::min(size-1,reason.size());std::memcpy(buffer,reason.data(),count);buffer[count]=0;}
struct SourceHandle {
    RSWindowSourceOptions options{};
    MacFXWindowSourceOutputWindow *output=nil;MacFXWindowSourceView *view=nil;CALayer *container=nil;
    RSWindowSourceGeometry remote{};std::mutex inletMutex;std::weak_ptr<Source>inlet;CALayer *pointer=nil;unsigned spacePolls=0;bool outputShown=false;uint32_t windowID=0,displayID=0;
    std::shared_ptr<Source>session;
    uint32_t state=RS_WINDOW_SOURCE_WAITING;std::string reason;
    bool failed=false;macfx::BrowserFrameAttemptContract failedContract{};macfx::WindowStreamRecovery recovery;
    // Scaled output's pointer mapping, refreshed by each poll.
    struct Mapping {bool active=false;int pid=0;macfx::WindowRect area,image,target;}mapping;
    // In place, a display link on the overlay's screen moves the overlay
    // with the target and, with each app activation, compares the windows
    // above the target with the last full check. stackTick is the display
    // link, or a timer at the display's rate before macOS 14.
    id stackTick=nil;id activation=nil;std::vector<CGWindowID> aboveIDs;double stackedAt=0;
    // A left click's expected order, which stands until the windows show it
    // or until anticipatedUntil.
    id clickMonitor=nil;macfx::WindowOverlayPlacement anticipated{};double anticipatedUntil=0;
    // The target's known child windows, and the capture's crop, which keeps
    // the image on the target when a child window reaches past its edges.
    std::unordered_set<uint32_t> remoteOverlays;std::unordered_set<uint32_t> childWindows;macfx::WindowRect crop{};
    // checkFrom is the previous full check, the earliest time a change found
    // by the current one can have reached a captured frame. potential is the
    // crop the windows not yet known as children would ask for, and
    // childBounds the known child windows' bounds at the last full check.
    double checkFrom=0;macfx::WindowRect potential{};std::unordered_map<uint32_t,macfx::WindowRect> childBounds;
    std::shared_ptr<CaptureWindows> captureWindows=std::make_shared<CaptureWindows>();
    uintptr_t context()const{return reinterpret_cast<uintptr_t>((__bridge void*)output);}
    uint32_t identity()const{return windowID?windowID:displayID;}
    bool scaled()const{return windowID&&(options.flags&RS_WINDOW_SOURCE_SCALED);}
    // The plan's frame-rate cap limits capture as it limits any other frame
    // source; an explicit capture rate from the host replaces it.
    double captureInterval()const{return macfx::windowCaptureInterval(options.captureRate>0?options.captureRate:macfx::sourceFrameRateCap());}
    void end(){mapping.active=false;stopStacking();if(session){if(session->presenter)session->presenter->setOutputVisible(false);{std::lock_guard<std::mutex> lock(inletMutex);inlet.reset();}session->close();session.reset();}outputShown=false;pointer.hidden=YES;[output orderOut:nil];}
    void startStacking(){
        if(stackTick)return;
        SourceHandle *self=this;
        auto *ticker=[MacFXWindowSourceTick new];ticker.block=^{guarded([&]{self->tick();return 1;});};
        if(@available(macOS 14.0,*)){
            CADisplayLink *link=[output displayLinkWithTarget:ticker selector:@selector(tick:)];
            [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];stackTick=link;
        }else {
            const double rate=std::clamp(double(output.screen.maximumFramesPerSecond?:60),30.,120.);
            NSTimer *timer=[NSTimer timerWithTimeInterval:1/rate target:ticker selector:@selector(tick:) userInfo:nil repeats:YES];
            [NSRunLoop.mainRunLoop addTimer:timer forMode:NSRunLoopCommonModes];stackTick=timer;
        }
        activation=[NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil
            queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification*){guarded([&]{self->stack(true);return 1;});}];
        // Monitoring mouse events needs no Accessibility access.
        clickMonitor=[NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown handler:^(NSEvent *event){guarded([&]{self->anticipate(event);return 1;});}];
    }
    void stopStacking(){
        [stackTick invalidate];stackTick=nil;aboveIDs.clear();stackedAt=0;captureWindows->clear();
        if(activation)[NSWorkspace.sharedWorkspace.notificationCenter removeObserver:activation];activation=nil;
        if(clickMonitor)[NSEvent removeMonitor:clickMonitor];clickMonitor=nil;anticipatedUntil=0;
    }
    // Each display frame while an in-place overlay is shown. The overlay's
    // frame follows the target's moves; a size change waits for the poll,
    // which also reconfigures the capture. No window is ordered here.
    void tick(){
        if(state!=RS_WINDOW_SOURCE_RUNNING||!windowID||scaled()||!session)return;
        const auto target=windowTarget(windowID);
        if(target.exists&&target.onScreen&&target.bounds.width==session->geometry.width&&target.bounds.height==session->geometry.height){
            const auto f=macfx::windowOverlayFrame(target.bounds,NSScreen.screens.firstObject.frame.size.height);
            session->placeOutput(NSMakeRect(f.x,f.y,f.width,f.height));
        }
        stack(false);
    }
    // Whether a known child window moved or resized since the last full
    // check, which can change the crop without changing the window list.
    bool childrenMoved()const{return !windowBoundsUnchanged(childBounds);}
    // Main thread, while an in-place overlay is shown. The list of window
    // numbers above the target and the known child windows' bounds are cheap
    // to read; the full descriptions are read when either changes, and at
    // least every 50 ms for other windows that move. Frames pass the render
    // queue's comparison again once place() has set any hold.
    void stack(bool force){
        if(state!=RS_WINDOW_SOURCE_RUNNING||!windowID||scaled())return;
        auto ids=windowsAbove(windowID);
        const double now=CACurrentMediaTime();
        if(!force&&ids==aboveIDs&&now-stackedAt<.05&&!childrenMoved())return;
        checkFrom=stackedAt?stackedAt:now;aboveIDs=std::move(ids);stackedAt=now;place();
        if(state!=RS_WINDOW_SOURCE_RUNNING||!stackTick)return;
        auto overlays=overlayWindows();overlays.insert(remoteOverlays.begin(),remoteOverlays.end());
        captureWindows->record(windowID,aboveIDs,std::move(overlays),childBounds);
    }
    // The window under a left click comes forward once its app handles the
    // click, a frame or more after the window server has it. A click on the
    // target or its child window raises the target over what covered it; a
    // click on another window at the target's level that overlaps it brings
    // that window over the target. The overlay takes that order at the click.
    // A Command-click raises nothing.
    void anticipate(NSEvent *event){
        if(state!=RS_WINDOW_SOURCE_RUNNING||!windowID||scaled()||!session||(event.modifierFlags&NSEventModifierFlagCommand))return;
        const auto target=windowTarget(windowID);if(!target.exists||!target.onScreen)return;
        const NSPoint point=event.locationInWindow;const double x=point.x,y=NSScreen.screens.firstObject.frame.size.height-point.y;
        NSArray *list=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));
        for(NSDictionary *info in list){
            const uint32_t id=uint32_t(number(info,kCGWindowNumber));const auto b=bounds(info);
            if(overlayWindows().count(id)||remoteOverlays.count(id)||x<b.x||y<b.y||x>=b.x+b.width||y>=b.y+b.height)continue;
            if([info[(__bridge NSString*)kCGWindowAlpha] isKindOfClass:NSNumber.class]&&!(number(info,kCGWindowAlpha)>.01))continue;
            macfx::WindowOverlayPlacement next;
            if(id==windowID||childWindows.count(id))next={macfx::windowOverlayLevel(target.layer),macfx::WindowOverlayOrder::front};
            else if(int(number(info,kCGWindowLayer))==target.layer&&macfx::windowRectsOverlap(b,target.bounds))next={target.layer,macfx::WindowOverlayOrder::aboveTarget};
            else return;
            anticipated=next;anticipatedUntil=CACurrentMediaTime()+.15;
            if(output.level!=next.level)output.level=next.level;
            if(next.order==macfx::WindowOverlayOrder::front)[output orderFrontRegardless];
            else [output orderWindow:NSWindowAbove relativeTo:NSInteger(windowID)];
            return;
        }
    }
    // Orders the overlay only when it does not already stack as the windows
    // above the target ask. An order that has not applied yet shows in the
    // next check, which orders it again.
    void place(){
        const auto target=windowTarget(windowID);if(!target.exists||!target.onScreen)return;
        NSArray *list=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenAboveWindow|kCGWindowListExcludeDesktopElements,windowID));
        std::vector<macfx::WindowAbove> above;above.reserve(list.count);
        for(NSDictionary *info in list){
            macfx::WindowAbove window;window.id=uint32_t(number(info,kCGWindowNumber));window.pid=int(number(info,kCGWindowOwnerPID));
            window.layer=int(number(info,kCGWindowLayer));window.bounds=bounds(info);window.overlay=overlayWindows().count(window.id)>0||remoteOverlays.count(window.id)>0;
            if([info[(__bridge NSString*)kCGWindowAlpha] isKindOfClass:NSNumber.class])window.alpha=number(info,kCGWindowAlpha);
            window.child=childWindows.count(window.id)>0;above.push_back(window);
        }
        // At the target's level the overlay was ordered directly above the
        // target, so the target's app's windows listed after it are the
        // target's child windows.
        if(int(output.level)==target.layer)
            for(size_t i=above.size()-macfx::windowChildWindows(uint32_t(output.windowNumber),above.data(),above.size());i<above.size();++i)
                if(above[i].pid==target.pid)above[i].child=true;
        childWindows.clear();childBounds.clear();
        for(const auto &window:above)if(window.child){childWindows.insert(window.id);childBounds[window.id]=window.bounds;}
        // The target's app's windows directly above it, up to the overlay, are
        // its child windows, known or not. One not yet known that covers the
        // target is learned once the overlay is ordered directly above the
        // target. When it, or a known one, moves the capture's image, frames
        // from the last check on wait for the image that matches, and the
        // overlay keeps its last image meanwhile.
        const auto next=macfx::windowCaptureCrop(target.bounds,above.data(),above.size());
        double left=target.bounds.x-next.x,top=target.bounds.y-next.y;
        for(size_t i=above.size();i-->0;){
            const auto &window=above[i];
            if(window.overlay){if(window.id==uint32_t(output.windowNumber))break;continue;}
            if(window.pid!=target.pid||window.layer!=target.layer)break;
            if(macfx::windowCoversTarget(window,target.pid,target.layer,target.bounds)){left=std::min(left,window.bounds.x);top=std::min(top,window.bounds.y);}
        }
        const macfx::WindowRect reach{target.bounds.x-left,target.bounds.y-top,target.bounds.width,target.bounds.height};
        const bool moved=next.x!=crop.x||next.y!=crop.y,suspect=reach.x!=next.x||reach.y!=next.y;
        const bool fresh=suspect&&(reach.x!=potential.x||reach.y!=potential.y);potential=reach;
        if(session&&(moved||fresh))session->hold(checkFrom,CACurrentMediaTime()+.5,moved);
        else if(session&&!suspect)session->release();
        // A new crop applies with the next capture configuration, which the
        // poll and the host's options start.
        if(moved){
            crop=next;poll();
            [NSNotificationCenter.defaultCenter postNotificationName:@RS_WINDOW_SOURCE_CROP_CHANGED object:nil];
            if(state!=RS_WINDOW_SOURCE_RUNNING)return;
        }
        const auto placement=macfx::windowOverlayPlacement(target.pid,target.layer,target.bounds,above.data(),above.size());
        if(anticipatedUntil){if(placement==anticipated||CACurrentMediaTime()>=anticipatedUntil)anticipatedUntil=0;else return;}
        if(macfx::windowOverlayPlaced(placement,int(output.level),output.visible,uint32_t(output.windowNumber),above.data(),above.size(),
            target.pid,target.layer,target.bounds))return;
        if(output.level!=placement.level)output.level=placement.level;
        if(placement.order==macfx::WindowOverlayOrder::front)[output orderFrontRegardless];
        else [output orderWindow:NSWindowAbove relativeTo:NSInteger(windowID)];
    }
    bool start(const macfx::BrowserFrameGeometry &g,NSRect frame,CGFloat scale,CGSize drawable){
        auto s=std::make_shared<Source>();s->window=identity();s->geometry=g;s->width=g.pixelsWidth;s->height=g.pixelsHeight;
        s->showsCursor=options.flags&RS_WINDOW_SOURCE_CURSOR;s->includeChildWindows=windowID!=0;
        s->minimumInterval=captureInterval();
        if(!s->prepareDevice()){reason="Window capture could not prepare its GPU resources; original window retained";return false;}
        s->output=output;output.ignoresMouseEvents=YES;s->settled=[windows=captureWindows]{return windows->settled();};
        // Window corners keep their captured alpha; a display is opaque.
        s->prepareLayer(scale,displayID!=0);if(drawable.width>0&&drawable.height>0)s->layer.drawableSize=drawable;
        [container addSublayer:s->layer];s->placeOutput(frame);
        s->preparePresenter(macfx::RuntimeFrameSource::ExternalWindow,std::optional<bool>(displayID!=0));
        session=s;{std::lock_guard<std::mutex>lock(inletMutex);inlet=s;}
        s->updateForwarded(g,remote.generation,frame,scale,drawable);
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
    void poll(){ // Main thread.
        if(!identity()||!remote.generation){state=RS_WINDOW_SOURCE_WAITING;return;}
        if(state==RS_WINDOW_SOURCE_CLOSED)return;
        const bool scaledOutput=scaled();
        Target target{bool(remote.exists),bool(remote.onScreen),remote.pid,remote.layer,{remote.x,remote.y,remote.width,remote.height}};
        // The service reports a move up to a poll late; the window server's
        // position at the same size is the one each display frame's tick uses.
        if(windowID&&target.exists){const auto live=windowTarget(windowID);
            if(live.exists&&live.bounds.width==target.bounds.width&&live.bounds.height==target.bounds.height){target.bounds.x=live.bounds.x;target.bounds.y=live.bounds.y;}}
        if(!target.exists){end();state=RS_WINDOW_SOURCE_CLOSED;reason=windowID?"The window closed":"The display is no longer available";return;}
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
            area=options.scale>0?macfx::windowFactorArea(target.bounds,screen.visible,options.scale):macfx::windowScaledArea(target.bounds,screen.frame,screen.visible);
            image=macfx::windowLetterbox(area,target.bounds.width,target.bounds.height);
        }
        const auto overlay=macfx::windowOverlayFrame(area,primary);
        const NSRect frame=NSMakeRect(overlay.x,overlay.y,overlay.width,overlay.height);
        const auto scale=remote.scale>0?remote.scale:1;
        const bool cropped=windowID&&!scaledOutput;
        const macfx::BrowserFrameGeometry g{cropped?crop.x:0,cropped?crop.y:0,target.bounds.width,target.bounds.height,
            remote.pixelsWidth,remote.pixelsHeight};
        const CGSize drawable=scaledOutput?CGSizeMake(macfx::windowPixelExtent(image.width,scale),macfx::windowPixelExtent(image.height,scale)):CGSizeZero;
        if(!macfx::browserFrameGeometryValid(g)||(scaledOutput&&!(drawable.width>0&&drawable.height>0))){
            mapping.active=false;stopStacking();[output orderOut:nil];state=RS_WINDOW_SOURCE_HIDDEN;return;}
        const macfx::BrowserFrameAttemptContract contract{macfx::effectPlanDemandGeneration(),macfx::liveEffects()?macfx::liveState().generation:0};
        if(session&&session->closed){
            if(session->recoverAfterGeometry)recovery.arm(identity(),session->geometry,CACurrentMediaTime());
            reason=session->failure;failed=true;failedContract=contract;end();
        }
        if(!session){
            // A failure retries once after the source settles, and again for
            // each later plan edit; it never loops on an unchanged plan.
            const bool retry=!failed||failedContract!=contract||recovery.ready(identity(),g,CACurrentMediaTime());
            if(!retry){stopStacking();[output orderOut:nil];state=RS_WINDOW_SOURCE_FAILED;return;}
            failed=false;reason.clear();
            if(!start(g,frame,scale,drawable)){failed=true;failedContract=contract;state=RS_WINDOW_SOURCE_FAILED;macfx::nativeLog(reason);return;}
        }else {session->updateForwarded(g,remote.generation,frame,scale,drawable);session->minimumInterval=captureInterval();}
        session->reveal();session->pollPublication();
        placeImage(scaledOutput?macfx::windowLetterboxInView(area,image):macfx::WindowRect{0,0,area.width,area.height});
        bool shown=processing&&target.onScreen&&!options.suspended&&!(options.flags&RS_WINDOW_SOURCE_HOLD);
        if(shown&&(output.visible||spacePolls>=3)&&!output.onActiveSpace&&target.onScreen)++spacePolls;else spacePolls=0;
        if(spacePolls>=3){shown=false;reason="The output cannot be shown on this full-screen Space";}else reason.clear();
        session->presenter->setDisplay(displayID?displayID:remote.displayID);
        session->presenter->setOutputVisible(shown);outputShown=shown;
        mapping={shown&&scaledOutput,target.pid,area,image,target.bounds};
        state=shown?RS_WINDOW_SOURCE_RUNNING:RS_WINDOW_SOURCE_HIDDEN;
        if(!shown){stopStacking();if(output.visible)[output orderOut:nil];return;}
        // In place, the overlay stacks with the target: in front of it at a
        // fixed level while nothing covers the target, so clicks and
        // selections that bring the target forward leave the overlay above
        // it, and directly above it while another window covers it.
        if(windowID&&!scaledOutput){startStacking();stack(!output.visible);return;}
        // A display's output and Scaled output keep one level above ordinary
        // windows and are ordered front only when they appear.
        stopStacking();
        const NSWindowLevel level=windowID?macfx::windowOverlayLevel(target.layer):NSFloatingWindowLevel;
        if(output.level!=level)output.level=level;
        if(!output.visible)[output orderFrontRegardless];
    }
};
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

        output.opaque=NO;output.backgroundColor=NSColor.clearColor;output.hasShadow=NO;output.level=NSFloatingWindowLevel;
        // The overlay is never an input of its own capture.
        output.sharingType=NSWindowSharingNone;
        // It joins every Space and full-screen apps, stays out of the window
        // cycle, and Mission Control hides it instead of leaving it over the
        // window thumbnails.
        output.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorFullScreenAuxiliary|
            NSWindowCollectionBehaviorTransient|NSWindowCollectionBehaviorIgnoresCycle;
        handle->output=output;overlayWindows().insert(uint32_t(output.windowNumber));result=handle;return 1;
    });
    if(!result&&error)copyReason(error->reason,sizeof(error->reason),"The window overlay could not be created");
    return result;
}
extern "C" uint32_t rsWindowSourceOutputWindow(void *value){return value?uint32_t(static_cast<SourceHandle*>(value)->output.windowNumber):0;}
extern "C" int rsWindowSourceSelect(void *value,const RSWindowSourceTarget *target,RSPresenterError *error){
    auto *handle=static_cast<SourceHandle*>(value);
    if(!handle||!NSThread.isMainThread||!target||target->size<sizeof(RSWindowSourceTarget)||target->version!=RS_WINDOW_SOURCE_ABI_VERSION||
       bool(target->windowID)==bool(target->displayID)){
        if(error)copyReason(error->reason,sizeof(error->reason),"Select one picked window or display");return 0;}
    return guarded([&]{
        handle->end();handle->remote={};handle->windowID=target->windowID;handle->displayID=target->displayID;
        handle->state=RS_WINDOW_SOURCE_WAITING;handle->reason.clear();handle->failed=false;handle->recovery.reset();
        handle->childWindows.clear();handle->childBounds.clear();handle->crop=handle->potential={};
        // The poll places a window's overlay from the windows around it.
        handle->output.level=NSFloatingWindowLevel;return 1;
    });
}
extern "C" int rsWindowSourceSetOptions(void *value,const RSWindowSourceOptions *options){
    auto *handle=static_cast<SourceHandle*>(value);
    if(!handle||!NSThread.isMainThread||!options||options->size<sizeof(RSWindowSourceOptions)||options->version!=RS_WINDOW_SOURCE_ABI_VERSION)return 0;
    // The cursor is a stream option and Scaled output changes the overlay's
    // geometry and input; either change takes effect with a new stream.
    const bool restart=((handle->options.flags^options->flags)&RS_WINDOW_SOURCE_SCALED)||handle->options.scale!=options->scale;
    handle->options=*options;if(restart&&handle->session)handle->end();
    return 1;
}
extern "C" int rsWindowSourcePoll(void *value,RSWindowSourceStatus *status){
    auto *handle=static_cast<SourceHandle*>(value);
    if(!handle||!NSThread.isMainThread)return 0;
    const int polled=guarded([&]{handle->poll();return 1;});
    if(!polled){handle->end();handle->state=RS_WINDOW_SOURCE_FAILED;handle->reason="Window graphics update failed; original window retained";}
    if(status&&status->size>=sizeof(RSWindowSourceStatus)){
        status->cropX=handle->crop.x;status->cropY=handle->crop.y;
        status->onActiveSpace=handle->output.onActiveSpace;status->displayID=handle->displayID?handle->displayID:handle->remote.displayID;status->outputVisible=handle->outputShown;
        status->targetX=handle->remote.x;status->targetY=handle->remote.y;status->targetWidth=handle->remote.width;status->targetHeight=handle->remote.height;status->targetPid=handle->remote.pid;
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
    guarded([&]{handle->end();overlayWindows().erase(uint32_t(handle->output.windowNumber));[handle->output close];handle->output=nil;return 1;});
    delete handle;
}
extern "C" unsigned rsWindowSourcePendingStops(){return macfx::pendingWindowStreamStops();}
extern "C" unsigned rsWindowSourceAPI(){return RS_WINDOW_SOURCE_ABI_VERSION;}

extern "C" int rsWindowSourceSetGeometry(void*v,const RSWindowSourceGeometry*g){if(!v||!g||g->size<sizeof(*g)||g->version!=2||!NSThread.isMainThread)return 0;auto*h=static_cast<SourceHandle*>(v);h->remote=*g;h->poll();return 1;}
extern "C" double rsWindowSourceCaptureInterval(void*v){return v?static_cast<SourceHandle*>(v)->captureInterval():0;}
extern "C" int rsWindowSourceSubmit(void*v,IOSurfaceRef surface,const RSWindowSourceFrame*f,RSWindowSourceReleased released,void*context){
 if(!f)return 0;
 // ABI 2's original prefix remains sufficient. An old producer does not own
 // the appended crop fields, so never read those bytes from its pointer.
 const auto info=macfx::forwardedFrameInfo(f);
 auto frame=std::make_shared<macfx::ForwardedFrame>(surface,info,released,context);
 if(!v||f->size<RS_WINDOW_SOURCE_FRAME_BASE_SIZE||f->version!=2)return 0;
 auto*h=static_cast<SourceHandle*>(v);std::lock_guard<std::mutex>lock(h->inletMutex);auto s=h->inlet.lock();if(!s)return 0;s->submit(frame);return 1;
}
extern "C" int rsWindowSourceSetPointer(void*v,const RSWindowSourcePointer*p){
 if(!v||!p||p->size<sizeof(*p)||p->version!=2||!NSThread.isMainThread)return 0;auto*h=static_cast<SourceHandle*>(v);
 return guarded([&]{
  if(!h->pointer){h->pointer=[CALayer layer];NSImage*image=NSCursor.arrowCursor.image;h->pointer.contents=(__bridge id)[image CGImageForProposedRect:nullptr context:nil hints:nil];h->pointer.bounds=CGRectMake(0,0,16,24);[h->container addSublayer:h->pointer];}
  // Only a shown Scaled output maps the pointer; before its first geometry
  // the mapping is empty and has no image point.
  const bool shown=p->visible&&h->mapping.active;
  [CATransaction begin];[CATransaction setDisableActions:YES];h->pointer.hidden=!shown;
  if(shown){const auto point=macfx::windowImagePoint(h->mapping.image,h->mapping.target,p->x,p->y);
   h->pointer.anchorPoint=CGPointMake(0,1);h->pointer.position=CGPointMake(point.x-h->mapping.area.x,h->mapping.area.height-(point.y-h->mapping.area.y));}
  [CATransaction commit];return 1;
 });
}

extern "C" int rsWindowSourceSetOverlays(void*v,const uint32_t*ids,uint32_t count){
 if(!v||!NSThread.isMainThread||(!ids&&count))return 0;auto*h=static_cast<SourceHandle*>(v);h->remoteOverlays.clear();if(count)h->remoteOverlays.insert(ids,ids+count);return 1;
}
