#include "virtual-window.hpp"
#include "fixture-files.hpp"
#include "process-phase.hpp"
#import <Cocoa/Cocoa.h>
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>
#import <objc/runtime.h>
@interface VirtualInputView:NSView
@property NSPoint lastPoint;
@property unsigned clicks;
@property unsigned motions;
@property NSPoint lastDelta;
@property BOOL testFlipped;
@end
@implementation VirtualInputView
- (BOOL)acceptsFirstResponder{return YES;}
- (BOOL)isFlipped{return self.testFlipped;}
- (void)mouseDown:(NSEvent *)event{self.lastPoint=[self convertPoint:event.locationInWindow fromView:nil];++self.clicks;}
- (void)mouseMoved:(NSEvent *)event{self.lastDelta=NSMakePoint(event.deltaX,event.deltaY);++self.motions;}
@end
@interface VirtualPassiveWindow:NSPanel
@end
@implementation VirtualPassiveWindow
- (BOOL)canBecomeKeyWindow{return NO;}
- (BOOL)canBecomeMainWindow{return NO;}
@end
@interface VirtualPassiveInputView:VirtualInputView
@end
@implementation VirtualPassiveInputView
- (BOOL)acceptsFirstMouse:(NSEvent *)event{return YES;}
@end
// Display backing pixels differ from the low-DPI renderer's one-pixel-per-
// point contract. Keep that distinction deterministic on either host display.
@interface VirtualLowDPIView:VirtualInputView
@end
@implementation VirtualLowDPIView
- (NSRect)convertRectToBacking:(NSRect)rect {return NSMakeRect(rect.origin.x*2,rect.origin.y*2,rect.size.width*2,rect.size.height*2);}
- (NSRect)convertRectFromBacking:(NSRect)rect {return NSMakeRect(rect.origin.x/2,rect.origin.y/2,rect.size.width/2,rect.size.height/2);}
@end
@interface VirtualFixedPublisherView:VirtualLowDPIView
@property BOOL holdBounds;
@property NSRect heldBounds;
@end
@implementation VirtualFixedPublisherView
- (NSRect)bounds {return self.holdBounds?self.heldBounds:[super bounds];}
@end
static bool close(double a,double b){return std::abs(a-b)<.01;}
static void pump(double seconds){NSDate *until=[NSDate dateWithTimeIntervalSinceNow:seconds];
    while(until.timeIntervalSinceNow>0){
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:.02]];
        NSEvent *event;while((event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast inMode:NSDefaultRunLoopMode dequeue:YES]))[NSApp sendEvent:event];
        [NSApp updateWindows];}}
static bool toggleFullscreen(NSWindow *source,NSWindow *output,bool fullscreen){
    __block bool completed=false;id observer=[NSNotificationCenter.defaultCenter addObserverForName:
        fullscreen?NSWindowDidEnterFullScreenNotification:NSWindowDidExitFullScreenNotification object:output queue:nil
        usingBlock:^(NSNotification *){completed=true;}];
    [source toggleFullScreen:nil];for(unsigned i=0;i<250&&!completed;++i)pump(.02);
    [NSNotificationCenter.defaultCenter removeObserver:observer];return completed&&bool(output.styleMask&NSWindowStyleMaskFullScreen)==fullscreen;
}
static VirtualPassiveWindow *passiveWindow(){
    auto window=[[VirtualPassiveWindow alloc]initWithContentRect:NSMakeRect(80,100,640,480)
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.hidesOnDeactivate=NO;window.floatingPanel=NO;window.level=NSNormalWindowLevel;
    auto view=[[VirtualPassiveInputView alloc]initWithFrame:NSMakeRect(0,0,640,480)];view.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
    window.contentView=view;[window orderBack:nil];return window;
}
static void passiveRequest(){
    setenv("RESHADE_RENDER_SOURCE_CONTROL","virtual",1);setenv("RESHADE_RENDER_SOURCE_ACTIVATION_API","0",1);
    for(const auto name:{"RESHADE_RENDER_SOURCE_CONTROL_FILE","RESHADE_RENDER_SOURCE_STATUS_FILE","RESHADE_DIAGNOSTICS_VIRTUAL_WINDOW"})unsetenv(name);
}
static void virtualContractFailure(const char *expression,const char *file,int line){
    std::fprintf(stderr,"Virtual window check failed: (%s), file %s, line %d\n",expression,file,line);std::fflush(stderr);std::exit(1);
}
#define VIRTUAL_CONTRACT_CHECK(expression) do{if(!(expression))virtualContractFailure(#expression,__FILE__,__LINE__);}while(false)
static void dispatchedPoint(VirtualInputView *source,const macfx::VirtualPresentationTarget &target){
    const auto bounds=target.view.bounds;const NSPoint local=NSMakePoint(bounds.origin.x+bounds.size.width*.25,bounds.origin.y+bounds.size.height*.75);
    const auto point=[target.view convertPoint:local toView:nil];const unsigned before=source.clicks;
    NSEvent *down=[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:point modifierFlags:NSEventModifierFlagShift timestamp:1 windowNumber:target.view.window.windowNumber context:nil eventNumber:91 clickCount:1 pressure:.5];
    NSEvent *mapped=macfx::virtualMappedEvent(source,down);VIRTUAL_CONTRACT_CHECK(mapped&&mapped!=down&&mapped.window==source.window);[source.window sendEvent:mapped];
    const auto sourceBounds=source.bounds;
    VIRTUAL_CONTRACT_CHECK(source.clicks==before+1&&close(source.lastPoint.x,sourceBounds.origin.x+sourceBounds.size.width*.25)&&close(source.lastPoint.y,sourceBounds.origin.y+sourceBounds.size.height*(source.isFlipped?.25:.75)));
    NSPoint screen=[target.view.window convertPointToScreen:point],mappedScreen,roundtrip;
    VIRTUAL_CONTRACT_CHECK(macfx::virtualMapScreenPoint(source,screen,&mappedScreen)&&macfx::virtualUnmapScreenPoint(source,mappedScreen,&roundtrip));VIRTUAL_CONTRACT_CHECK(close(screen.x,roundtrip.x)&&close(screen.y,roundtrip.y));
    NSEvent *up=[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:point modifierFlags:0 timestamp:2 windowNumber:target.view.window.windowNumber context:nil eventNumber:92 clickCount:1 pressure:0];
    VIRTUAL_CONTRACT_CHECK(macfx::virtualMappedEvent(source,up));
}
static void fullscreenFailureChecks(){@autoreleasepool{
    passiveRequest();auto window=passiveWindow();auto view=(VirtualPassiveInputView*)window.contentView;
    auto target=macfx::virtualPresentationSource(view);VIRTUAL_CONTRACT_CHECK(target.active);macfx::revealVirtualWindow(view);
    id<NSWindowDelegate> delegate=target.view.window.delegate;VIRTUAL_CONTRACT_CHECK(delegate&&!macfx::virtualWindowTransitioning(view));const auto geometry=window.frame;
    [delegate windowWillEnterFullScreen:[NSNotification notificationWithName:NSWindowWillEnterFullScreenNotification object:target.view.window]];
    VIRTUAL_CONTRACT_CHECK(macfx::virtualWindowTransitioning(view));VIRTUAL_CONTRACT_CHECK([delegate respondsToSelector:@selector(windowDidFailToEnterFullScreen:)]);
    [delegate windowDidFailToEnterFullScreen:target.view.window];VIRTUAL_CONTRACT_CHECK(!macfx::virtualWindowTransitioning(view)&&NSEqualRects(window.frame,geometry));
    dispatchedPoint(view,target);
    [delegate windowWillExitFullScreen:[NSNotification notificationWithName:NSWindowWillExitFullScreenNotification object:target.view.window]];
    VIRTUAL_CONTRACT_CHECK(macfx::virtualWindowTransitioning(view));VIRTUAL_CONTRACT_CHECK([delegate respondsToSelector:@selector(windowDidFailToExitFullScreen:)]);
    [delegate windowDidFailToExitFullScreen:target.view.window];VIRTUAL_CONTRACT_CHECK(!macfx::virtualWindowTransitioning(view)&&NSEqualRects(window.frame,geometry));
    dispatchedPoint(view,target);macfx::stopVirtualWindow(view);VIRTUAL_CONTRACT_CHECK(!window.parentWindow&&!target.view.window.visible);[window close];
    std::puts("virtual fullscreen failure: actual delegate will/fail seams cleared transition and preserved pointer mapping; no native transition, Space or HID input");
}}
static void resizeConstraintChecks(){@autoreleasepool{
    passiveRequest();
    for(bool aspect:{true,false}){
        auto window=passiveWindow();auto view=(VirtualPassiveInputView*)window.contentView;
        window.contentMinSize=NSMakeSize(240,180);window.contentMaxSize=NSMakeSize(1600,1200);
        if(aspect)window.contentAspectRatio=NSMakeSize(4,3);else{window.contentAspectRatio=NSZeroSize;window.contentResizeIncrements=NSMakeSize(7,5);}
        const auto minimum=window.contentMinSize,maximum=window.contentMaxSize,ratio=window.contentAspectRatio,increments=window.contentResizeIncrements;
        const auto behavior=window.collectionBehavior;auto target=macfx::virtualPresentationSource(view);VIRTUAL_CONTRACT_CHECK(target.active);auto output=target.view.window;
        VIRTUAL_CONTRACT_CHECK(NSEqualSizes(output.contentMinSize,minimum)&&NSEqualSizes(output.contentMaxSize,maximum));
        if(aspect)VIRTUAL_CONTRACT_CHECK(NSEqualSizes(output.contentAspectRatio,ratio));else VIRTUAL_CONTRACT_CHECK(NSEqualSizes(output.contentResizeIncrements,increments));
        macfx::revealVirtualWindow(view);dispatchedPoint(view,target);
        [output setContentSize:aspect?NSMakeSize(800,600):NSMakeSize(840,600)];[output setFrameOrigin:NSMakePoint(120,140)];
        target=macfx::virtualPresentationSource(view);dispatchedPoint(view,target);view.testFlipped=YES;dispatchedPoint(view,target);view.testFlipped=NO;
        const NSRect restored=[window frameRectForContentRect:[output contentRectForFrameRect:output.frame]];
        macfx::stopVirtualWindow(view);VIRTUAL_CONTRACT_CHECK(NSEqualRects(window.frame,restored)&&!window.parentWindow&&!output.visible&&window.collectionBehavior==behavior);
        VIRTUAL_CONTRACT_CHECK(NSEqualSizes(window.contentMinSize,minimum)&&NSEqualSizes(window.contentMaxSize,maximum)&&NSEqualSizes(window.contentAspectRatio,ratio)&&NSEqualSizes(window.contentResizeIncrements,increments));
        [window close];
    }
    std::puts("virtual resize constraints: native content min/max, aspect or increments, resized/flipped point dispatch and stop restoration; no HID or Space change");
}}
static __weak NSWindow *recordedFullscreenWindow=nil;
static void recordFullscreen(id window,SEL,id){recordedFullscreenWindow=window;}
static void preparedFullscreenChecks(){@autoreleasepool{
    NSString *directory=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"macfx-prepared-fullscreen-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    VIRTUAL_CONTRACT_CHECK([NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil]);
    NSString *file=[directory stringByAppendingPathComponent:@"source-control-prepared-fullscreen.json"],*status=[directory stringByAppendingPathComponent:@"source-status-prepared-fullscreen.json"];
    setenv("RESHADE_RENDER_SOURCE_CONTROL","virtual",1);setenv("RESHADE_RENDER_SOURCE_ACTIVATION_API","1",1);setenv("RESHADE_RENDER_SOURCE_CONTROL_FILE",file.fileSystemRepresentation,1);setenv("RESHADE_RENDER_SOURCE_STATUS_FILE",status.fileSystemRepresentation,1);setenv("RESHADE_RENDER_SOURCE_LAUNCH_ID","prepared-fullscreen",1);
    const auto write=[&](unsigned epoch){VIRTUAL_CONTRACT_CHECK((replaceFile([NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"launchId":@"prepared-fullscreen",@"epoch":@(epoch),@"revision":@"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",@"control":@"virtual",@"source":@{@"multiplier":@2}}options:0 error:nil],file)));};
    auto window=passiveWindow();auto view=(VirtualPassiveInputView*)window.contentView;const auto original=window.frame;
    Method method=class_getInstanceMethod(NSWindow.class,@selector(toggleFullScreen:));IMP originalMethod=method_setImplementation(method,reinterpret_cast<IMP>(recordFullscreen));
    VIRTUAL_CONTRACT_CHECK(class_getMethodImplementation(window.class,@selector(toggleFullScreen:))==reinterpret_cast<IMP>(recordFullscreen));
    write(1);macfx::pollVirtualSourceControl(true);const void *publisher=(__bridge const void*)view;macfx::setVirtualPublisherExtent(view,publisher,[view convertRectToBacking:view.bounds].size);
    auto target=macfx::virtualPresentationSource(view);VIRTUAL_CONTRACT_CHECK(target.active&&macfx::virtualWindowPrepared(view)&&NSEqualRects(window.frame,original));
    [window toggleFullScreen:nil];VIRTUAL_CONTRACT_CHECK(recordedFullscreenWindow==window&&!macfx::virtualWindowPrepared(view)&&NSEqualRects(window.frame,original)&&!window.parentWindow&&!target.view.window.visible);
    // This helper enters the trusted display-receipt seam, not an actual GPU
    // presentation. Only the original-method receiver is under examination.
    write(2);macfx::pollVirtualSourceControl(true);macfx::setVirtualPublisherExtent(view,publisher,[view convertRectToBacking:view.bounds].size);
    target=macfx::virtualPresentationSource(view);VIRTUAL_CONTRACT_CHECK(target.active&&macfx::virtualWindowPrepared(view));macfx::revealVirtualWindow(view);VIRTUAL_CONTRACT_CHECK(macfx::commitVirtualWindow(view,target.view));
    recordedFullscreenWindow=nil;[window toggleFullScreen:nil];VIRTUAL_CONTRACT_CHECK(recordedFullscreenWindow==target.view.window);
    macfx::stopVirtualWindow(view);VIRTUAL_CONTRACT_CHECK(NSEqualRects(window.frame,original)&&!window.parentWindow);method_setImplementation(method,originalMethod);recordedFullscreenWindow=nil;
    [window close];VIRTUAL_CONTRACT_CHECK([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);
    std::puts("virtual fullscreen routing: prepared candidate retired to original source, owned geometry routed to output; recorded original method only, no native fullscreen/Space/HID/GPU");
}}
#undef VIRTUAL_CONTRACT_CHECK
static void dormantActivationChecks(){@autoreleasepool{
    NSString *directory=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"macfx-virtual-dormant-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    assert([NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil]);
    NSString *file=[directory stringByAppendingPathComponent:@"source-control-dormant.json"],*status=[directory stringByAppendingPathComponent:@"source-status-dormant.json"];
    setenv("RESHADE_RENDER_SOURCE_CONTROL","virtual",1);setenv("RESHADE_RENDER_SOURCE_ACTIVATION_API","1",1);
    setenv("RESHADE_RENDER_SOURCE_CONTROL_FILE",file.fileSystemRepresentation,1);setenv("RESHADE_RENDER_SOURCE_STATUS_FILE",status.fileSystemRepresentation,1);
    setenv("RESHADE_RENDER_SOURCE_LAUNCH_ID","dormant",1);
    const auto write=[&](unsigned epoch,id source){assert((replaceFile([NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"launchId":@"dormant",@"epoch":@(epoch),
        @"revision":@"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",@"control":@"virtual",@"source":source}options:0 error:nil],file)));};
    const auto read=[&]()->NSDictionary*{return [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:status]options:0 error:nil];};
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(100,120,600,450)
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
    VirtualLowDPIView *view=[[VirtualLowDPIView alloc]initWithFrame:NSMakeRect(0,0,600,450)];view.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
    window.contentView=view;[window orderBack:nil];const NSRect original=window.frame;
    const NSSize minimum=window.contentMinSize,maximum=window.contentMaxSize;const auto behavior=window.collectionBehavior;
    const void *publisher=(__bridge const void*)view;write(1,NSNull.null);
    for(unsigned n=0;n<3;++n)macfx::pollVirtualSourceControl(false);
    assert(!macfx::virtualWindowEnabled()&&!macfx::virtualPresentationSource(view).active);
    assert(![NSFileManager.defaultManager fileExistsAtPath:status]&&NSEqualRects(window.frame,original)&&!window.parentWindow);
    write(2,@{@"multiplier":@3});macfx::pollVirtualSourceControl(true);
    macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);
    auto target=macfx::virtualPresentationSource(view);assert(target.active&&macfx::virtualWindowPrepared(view));
    assert(NSEqualRects(window.frame,original)&&!window.parentWindow&&window.collectionBehavior==behavior);
    assert(NSEqualSizes(window.contentMinSize,minimum)&&NSEqualSizes(window.contentMaxSize,maximum)&&target.view.window.visible&&target.view.window.alphaValue==0);
    macfx::virtualSourceFrameReady(view,target.view,view.bounds.size,publisher);
    assert([read()[@"reason"] hasPrefix:@"Waiting for "]&&!read()[@"observed"]);
    // Cancel while still prepared: no geometry was ever owned and no extra
    // completed frame is needed merely to confirm that unchanged Original.
    write(3,NSNull.null);macfx::pollVirtualSourceControl(false);
    assert(!macfx::virtualWindowEnabled()&&NSEqualRects(window.frame,original)&&!window.parentWindow);
    assert([read()[@"epoch"] unsignedIntValue]==3&&read()[@"applied"]==NSNull.null&&![read()[@"reason"]length]&&!read()[@"observed"]);
    write(4,@{@"multiplier":@3});macfx::pollVirtualSourceControl(true);macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);assert(macfx::virtualPresentationRequired(view));
    target=macfx::virtualPresentationSource(view);assert(target.active&&macfx::virtualWindowPrepared(view)&&NSEqualRects(window.frame,original));
    assert(!macfx::commitVirtualWindow(view,target.view)&&"hidden output cannot authorize source mutation");
    macfx::revealVirtualWindow(view);assert(target.view.window.visible&&NSEqualRects(window.frame,original)&&!window.parentWindow);
    // This helper test enters the trusted receipt seam directly. Only the
    // ViewPresentation fixture/real drawable callback can prove display time.
    assert(macfx::commitVirtualWindow(view,target.view)&&!macfx::virtualWindowPrepared(view));
    assert(window.parentWindow==target.view.window&&!NSEqualRects(window.frame,original));
    macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);
    macfx::virtualSourceFrameReady(view,target.view,NSMakeSize(600,450),publisher);assert([read()[@"reason"]length]);
    macfx::virtualSourceFrameReady(view,target.view,view.bounds.size,publisher);assert(![read()[@"reason"]length]&&[read()[@"applied"][@"virtual"]boolValue]);
    write(5,NSNull.null);macfx::pollVirtualSourceControl(false);assert(NSEqualRects(window.frame,original)&&[read()[@"reason"]length]);
    macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);macfx::virtualSourceFrameReady(view,target.view,view.bounds.size,publisher);
    assert(![read()[@"reason"]length]&&!macfx::virtualWindowEnabled()&&!window.parentWindow);
    write(6,@{@"height":@200});macfx::pollVirtualSourceControl(true);macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);assert(macfx::virtualPresentationRequired(view));
    target=macfx::virtualPresentationSource(view);assert(target.active&&macfx::virtualWindowPrepared(view));
    macfx::failVirtualWindowPreparation(view,target.view);
    assert(NSEqualRects(window.frame,original)&&!window.parentWindow&&![read()[@"reason"] hasPrefix:@"Waiting for "]);
    write(7,NSNull.null);macfx::pollVirtualSourceControl(false);assert(![read()[@"reason"]length]&&!macfx::virtualWindowEnabled());
    // Already-satisfied source never transfers geometry ownership. A later
    // independent game resize makes its old completed pixel receipt stale,
    // but Original can still acknowledge no allocation to restore without
    // asking an Off pipeline for a new processor/GPU callback.
    write(8,@{@"multiplier":@2});macfx::pollVirtualSourceControl(true);macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);
    target=macfx::virtualPresentationSource(view);assert(!target.active&&target.view==view);
    macfx::virtualSourceFrameReady(view,view,view.bounds.size,publisher);assert(![read()[@"reason"]length]&&read()[@"observed"]);
    [window setContentSize:NSMakeSize(640,480)];const NSRect gameResized=window.frame;macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);
    write(9,NSNull.null);macfx::pollVirtualSourceControl(false);
    assert(![read()[@"reason"]length]&&read()[@"applied"]==NSNull.null&&!read()[@"observed"]&&![read()[@"sessionReady"]boolValue]);
    assert(!macfx::virtualWindowEnabled()&&!window.parentWindow&&NSEqualRects(window.frame,gameResized));
    // Native Auto accepts a naturally smaller producer without enlarging the
    // game to the physical target. The receipt still comes from actual pixels.
    [window setContentSize:NSMakeSize(300,200)];const NSRect natural=window.frame;
    write(10,@{@"automatic":@YES});macfx::pollVirtualSourceControl(true);macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);
    assert(!macfx::virtualPresentationRequired(view));target=macfx::virtualPresentationSource(view);
    assert(!target.active&&target.view==view&&NSEqualRects(window.frame,natural));
    macfx::virtualSourceFrameReady(view,view,view.bounds.size,publisher);
    assert(![read()[@"reason"]length]&&[read()[@"applied"][@"width"]unsignedIntValue]==300&&[read()[@"observed"][@"height"]unsignedIntValue]==200);
    write(11,NSNull.null);macfx::pollVirtualSourceControl(false);assert(![read()[@"reason"]length]&&!read()[@"observed"]);
    for(NSWindow *candidate in NSApp.windows)assert(!macfx::isVirtualOutputWindow(candidate)||!candidate.visible);
    [window close];assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);
    std::puts("virtual dormant source: Off no owner, prepared geometry unchanged, cancellation/failure restore, trusted display seam, actual-extent ACK and re-enable");
}}
static void satisfiedSourceChecks(){@autoreleasepool{
    NSString *directory=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"macfx-virtual-satisfied-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    assert([NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil]);
    NSString *file=[directory stringByAppendingPathComponent:@"source-control-satisfied.json"],*status=[directory stringByAppendingPathComponent:@"source-status-satisfied.json"];
    setenv("RESHADE_RENDER_SOURCE_CONTROL_FILE",file.fileSystemRepresentation,1);setenv("RESHADE_RENDER_SOURCE_STATUS_FILE",status.fileSystemRepresentation,1);
    setenv("RESHADE_RENDER_SOURCE_LAUNCH_ID","satisfied",1);
    const auto write=[&](unsigned epoch,id source){assert((replaceFile([NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"launchId":@"satisfied",@"epoch":@(epoch),
        @"revision":@"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",@"control":@"virtual",@"source":source}options:0 error:nil],file)));};
    const auto read=[&]()->NSDictionary*{return [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:status]options:0 error:nil];};
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(100,120,600,450)
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
    VirtualFixedPublisherView *view=[[VirtualFixedPublisherView alloc]initWithFrame:NSMakeRect(0,0,600,450)];view.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
    window.contentView=view;[window orderBack:nil];const NSRect original=window.frame;
    write(1,@{@"multiplier":@2});
    assert(![NSFileManager.defaultManager fileExistsAtPath:status]&&!macfx::virtualSourceFramePending((__bridge const void*)view));
    const void *publisher=(__bridge const void*)view;
    macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);
    assert(!macfx::virtualPresentationRequired(view));
    auto target=macfx::virtualPresentationSource(view);
    assert(!target.active&&target.view==view&&NSEqualRects(window.frame,original)&&!window.parentWindow);
    assert([read()[@"reason"] hasPrefix:@"Waiting for "]&&read()[@"applied"]==NSNull.null&&!read()[@"observed"]);
    assert(macfx::virtualSourceFramePending((__bridge const void*)view));
    NSView *wrong=[NSView new];macfx::virtualSourceFrameReady(view,wrong,view.bounds.size,publisher);
    macfx::virtualSourceFrameReady(view,view,[view convertRectToBacking:view.bounds].size,publisher);
    assert([read()[@"reason"] hasPrefix:@"Waiting for "]&&!read()[@"observed"]);
    // Exercise the trusted GPU-completion entry; this window/helper fixture
    // does not claim to execute the producer's GPU command buffer itself.
    macfx::virtualSourceFrameReady(view,view,view.bounds.size,publisher);
    assert(![read()[@"reason"] length]&&![read()[@"applied"][@"virtual"]boolValue]&&[read()[@"sessionReady"]boolValue]);
    assert(close([read()[@"applied"][@"width"]doubleValue],600)&&close([read()[@"applied"][@"outputWidth"]doubleValue],1200));
    assert(close([read()[@"observed"][@"height"]doubleValue],450)&&!macfx::virtualSourceFramePending((__bridge const void*)view));
    for(NSWindow *candidate in NSApp.windows)assert(!macfx::isVirtualOutputWindow(candidate));
    // Original has no geometry/API work in this non-proxy case. It must
    // acknowledge the exact retained completed receipt without another frame;
    // All off may already have retired the ordinary processing presenter.
    write(2,NSNull.null);pump(.15);
    assert(![read()[@"reason"] length]&&read()[@"applied"]==NSNull.null&&[read()[@"epoch"]unsignedIntValue]==2);
    assert(close([read()[@"observed"][@"width"]doubleValue],600)&&!macfx::virtualSourceFramePending((__bridge const void*)view));
    assert(NSEqualRects(window.frame,original)&&!window.parentWindow);
    write(3,@{@"multiplier":@2});pump(.15);assert([read()[@"reason"] length]);
    macfx::virtualSourceFrameReady(view,view,view.bounds.size,publisher);assert(![read()[@"reason"] length]);
    // A later reduction needs a proxy. A completed old ordinary target cannot
    // acknowledge it before the replacement source/target is established.
    write(4,@{@"height":@200});pump(.15);assert(macfx::virtualPresentationRequired(view));
    macfx::virtualSourceFrameReady(view,view,view.bounds.size,publisher);assert([read()[@"reason"] length]);
    view.heldBounds=view.bounds;view.holdBounds=YES;
    target=macfx::virtualPresentationSource(view);assert(target.active&&target.view!=view);NSView *oldTarget=target.view;
    macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);
    // A publisher can retain its own extent despite the smaller window. The
    // actual completion must satisfy the source request, not only its measured
    // point-to-pixel convention and the replacement target identity.
    assert(!close(view.bounds.size.height,200));
    macfx::virtualSourceFrameReady(view,target.view,view.bounds.size,publisher);
    assert([read()[@"reason"] hasPrefix:@"Waiting for "]&&!read()[@"observed"]);
    view.holdBounds=NO;[view setBoundsSize:view.frame.size];
    macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);
    macfx::virtualSourceFrameReady(view,view,view.bounds.size,publisher);assert([read()[@"reason"] length]);
    macfx::virtualSourceFrameReady(view,target.view,view.bounds.size,publisher);assert(![read()[@"reason"] length]&&[read()[@"applied"][@"virtual"]boolValue]);
    write(5,NSNull.null);pump(.15);assert(NSEqualRects(window.frame,original));
    macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);
    macfx::virtualSourceFrameReady(view,target.view,view.bounds.size,publisher);assert(![read()[@"reason"] length]&&read()[@"applied"]==NSNull.null&&!window.parentWindow);
    write(6,@{@"multiplier":@2});pump(.15);target=macfx::virtualPresentationSource(view);
    assert(!target.active&&target.view==view&&!window.parentWindow&&NSEqualRects(window.frame,original));
    macfx::virtualSourceFrameReady(view,oldTarget,view.bounds.size,publisher);assert([read()[@"reason"] length]);
    macfx::virtualSourceFrameReady(view,view,view.bounds.size,publisher);assert(![read()[@"reason"] length]&&![read()[@"applied"][@"virtual"]boolValue]);
    // A stale geometry receipt cannot make Original succeed without a new
    // completion. No proxy is introduced to obtain that completion.
    [window setContentSize:NSMakeSize(640,480)];macfx::setVirtualPublisherExtent(view,publisher,view.bounds.size);
    write(7,NSNull.null);pump(.15);assert([read()[@"reason"] hasPrefix:@"Waiting for "]&&!read()[@"observed"]&&!window.parentWindow);
    macfx::virtualSourceFrameReady(view,view,view.bounds.size,publisher);assert(![read()[@"reason"] length]);
    write(8,@{@"multiplier":@2});pump(.15);assert(!macfx::virtualPresentationSource(view).active);
    macfx::virtualSourceFrameReady(view,view,view.bounds.size,publisher);assert(![read()[@"reason"] length]);
    const void *replacement=(__bridge const void*)wrong;macfx::setVirtualPublisherExtent(view,replacement,view.bounds.size);
    write(9,NSNull.null);pump(.15);assert([read()[@"reason"] hasPrefix:@"Waiting for "]&&!read()[@"observed"]);
    macfx::virtualSourceFrameReady(view,view,view.bounds.size,publisher);assert([read()[@"reason"] length]);
    macfx::virtualSourceFrameReady(view,view,view.bounds.size,replacement);assert(![read()[@"reason"] length]);
    // The legacy completion entry provides no publisher proof for reuse.
    write(10,@{@"multiplier":@2});pump(.15);macfx::virtualSourceFrameReady(view,view,view.bounds.size);
    assert(![read()[@"reason"] length]);write(11,NSNull.null);pump(.15);assert([read()[@"reason"] hasPrefix:@"Waiting for "]);
    [window close];assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);
    std::puts("virtual satisfied source: explicit completion, no-frame Original, unchanged publisher/geometry proof, stale rejection and proxy transition passed");
}}
static void publisherChecks(){@autoreleasepool{
    setenv("RESHADE_RENDER_SOURCE_CONTROL","virtual",1);
    NSWindow *partial=[[NSWindow alloc]initWithContentRect:NSMakeRect(100,120,600,450)
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];partial.releasedWhenClosed=NO;
    NSView *pane=[[NSView alloc]initWithFrame:NSMakeRect(0,0,300,450)];pane.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
    NSView *sibling=[[NSView alloc]initWithFrame:NSMakeRect(300,0,300,450)];[partial.contentView addSubview:pane];[partial.contentView addSubview:sibling];[partial orderBack:nil];
    const NSRect originalPartial=partial.frame;assert(!macfx::virtualPresentationRequired(pane));assert(!macfx::virtualPresentationSource(pane).active);
    assert(NSEqualRects(partial.frame,originalPartial)&&!partial.parentWindow&&sibling.window==partial);[partial close];
    NSString *directory=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"macfx-virtual-pixels-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    assert([NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil]);
    NSString *file=[directory stringByAppendingPathComponent:@"source-control-pixels.json"],*status=[directory stringByAppendingPathComponent:@"source-status-pixels.json"];
    setenv("RESHADE_RENDER_SOURCE_CONTROL_FILE",file.fileSystemRepresentation,1);setenv("RESHADE_RENDER_SOURCE_STATUS_FILE",status.fileSystemRepresentation,1);setenv("RESHADE_RENDER_SOURCE_LAUNCH_ID","pixels",1);
    const auto write=[&](unsigned epoch,id source){assert((replaceFile([NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"launchId":@"pixels",@"epoch":@(epoch),@"revision":@"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",@"control":@"virtual",@"source":source}options:0 error:nil],file)));};
    const auto read=[&]()->NSDictionary*{return [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:status]options:0 error:nil];};
    write(1,@{@"multiplier":@3});
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(100,120,600,450)
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
    VirtualLowDPIView *view=[[VirtualLowDPIView alloc]initWithFrame:NSMakeRect(0,0,600,450)];view.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;window.contentView=view;[window orderBack:nil];
    macfx::setVirtualPublisherPixelSpace(view,macfx::VirtualPublisherPixelSpace::Points);const NSRect original=window.frame;
    auto target=macfx::virtualPresentationSource(view);assert(target.active);
    const NSSize output=[target.view.window.contentView convertRectToBacking:target.view.window.contentView.bounds].size;
    assert(close(view.bounds.size.width,std::ceil(output.width/3))&&close(view.bounds.size.height,std::ceil(output.height/3)));
    macfx::virtualSourceFrameReady(view,target.view,[view convertRectToBacking:view.bounds].size);assert([read()[@"reason"] hasPrefix:@"Waiting for "]);
    macfx::virtualSourceFrameReady(view,target.view,view.bounds.size);assert(![read()[@"reason"] length]&&[read()[@"sessionReady"] boolValue]);
    assert(close([read()[@"observed"][@"width"]doubleValue],view.bounds.size.width));
    const auto maximum=unsigned(output.height*.75);write(2,@{@"height":@(maximum),@"maximum":@YES});pump(.15);
    assert(close(view.bounds.size.height,std::min(450.0,double(maximum))));macfx::virtualSourceFrameReady(view,target.view,view.bounds.size);assert(![read()[@"reason"] length]);
    write(3,NSNull.null);pump(.15);assert(NSEqualRects(window.frame,original)&&[read()[@"reason"] hasPrefix:@"Waiting for "]);
    macfx::virtualSourceFrameReady(view,target.view,[view convertRectToBacking:view.bounds].size);assert([read()[@"reason"] hasPrefix:@"Waiting for "]);
    macfx::virtualSourceFrameReady(view,target.view,view.bounds.size);assert(![read()[@"reason"] length]&&read()[@"applied"]==NSNull.null&&!window.parentWindow);
    assert(close([read()[@"observed"][@"width"]doubleValue],600));
    // The same view's OpenGL flag cannot choose a Metal publisher's units.
    // Explicit backing-pixel ingress still requires the backing-pixel receipt.
    view.wantsBestResolutionOpenGLSurface=NO;macfx::setVirtualPublisherPixelSpace(view,macfx::VirtualPublisherPixelSpace::Backing);
    write(4,@{@"multiplier":@3});pump(.15);target=macfx::virtualPresentationSource(view);assert(target.active);
    const NSSize backingOutput=[target.view.window.contentView convertRectToBacking:target.view.window.contentView.bounds].size;
    assert(close(view.bounds.size.width,std::ceil(backingOutput.width/3)/2));
    macfx::virtualSourceFrameReady(view,target.view,view.bounds.size);assert([read()[@"reason"] hasPrefix:@"Waiting for "]);
    macfx::virtualSourceFrameReady(view,target.view,[view convertRectToBacking:view.bounds].size);assert(![read()[@"reason"] length]);
    [window close];assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);
    std::puts("virtual publisher: partial-content window preserved; low-DPI sizing, exact receipts, Original restoration and explicit backing pixels passed");
}}
static void liveChecks(bool fullscreen){@autoreleasepool{
    NSString *directory=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"macfx-virtual-live-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    assert([NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil]);
    NSString *file=[directory stringByAppendingPathComponent:@"source-control-owned.json"],*status=[directory stringByAppendingPathComponent:@"source-status-owned.json"];
    setenv("RESHADE_RENDER_SOURCE_CONTROL","virtual",1);
    setenv("RESHADE_RENDER_SOURCE_CONTROL_FILE",file.fileSystemRepresentation,1);setenv("RESHADE_RENDER_SOURCE_STATUS_FILE",status.fileSystemRepresentation,1);
    setenv("RESHADE_RENDER_SOURCE_LAUNCH_ID","owned",1);
    const auto write=[&](unsigned epoch,id source){
        NSData *bytes=[NSJSONSerialization dataWithJSONObject:@{@"schema":@1,@"launchId":@"owned",@"control":@"virtual",@"epoch":@(epoch),
            @"revision":@"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",@"source":source} options:0 error:nil];
        assert(replaceFile(bytes,file));
    };
    const auto read=[&]()->NSDictionary *{return [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:status] options:0 error:nil];};
    write(1,@{@"multiplier":@2});
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(100,120,800,600)
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;
    VirtualInputView *view=[[VirtualInputView alloc]initWithFrame:NSMakeRect(0,0,800,600)];view.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;
    window.contentView=view;[window orderBack:nil];const NSRect original=window.frame;
    const NSSize originalPixels=[view convertRectToBacking:view.bounds].size;
    auto target=macfx::virtualPresentationSource(view);assert(target.active);NSView *firstTarget=target.view;
    assert([read()[@"reason"] hasPrefix:@"Waiting for "]&&macfx::virtualSourceFramePending((__bridge const void*)view));
    const auto receipt=[&](NSView *expected){macfx::virtualSourceFrameReady(view,expected,[view convertRectToBacking:view.bounds].size);};
    macfx::virtualSourceFrameReady(view,target.view,originalPixels);assert([read()[@"reason"] length]);
    receipt(target.view);assert(![read()[@"reason"] length]&&[read()[@"sessionReady"] boolValue]&&!macfx::virtualSourceFramePending((__bridge const void*)view));
    write(2,@{@"multiplier":@3});pump(.15);assert([read()[@"epoch"] unsignedIntValue]==2&&[read()[@"reason"] length]);
    assert(close([view convertRectToBacking:view.bounds].size.width,std::ceil(originalPixels.width/3)));
    receipt(target.view);assert(![read()[@"reason"] length]);
    // A larger maximum can increase the previous reduced allocation.
    write(3,@{@"height":@(unsigned(originalPixels.height*.75)),@"maximum":@YES});pump(.15);
    assert([view convertRectToBacking:view.bounds].size.height>originalPixels.height/2);receipt(target.view);
    const NSSize accepted=view.bounds.size;
    write(2,@{@"multiplier":@2});pump(.15);assert(NSEqualSizes(view.bounds.size,accepted));
    write(4,@{@"height":@480,@"multiplier":@2});pump(.15);assert(NSEqualSizes(view.bounds.size,accepted));
    write(5,@{@"multiplier":@2});pump(.15);receipt(target.view);macfx::revealVirtualWindow(view);
    if(fullscreen){
        assert(toggleFullscreen(window,target.view.window,true));
        write(6,@{@"multiplier":@3});pump(.15);receipt(target.view);assert(![read()[@"reason"] length]);
        const NSSize before=view.bounds.size;write(7,NSNull.null);pump(.15);
        assert([read()[@"reason"] hasPrefix:@"Exit fullscreen"]&&NSEqualSizes(view.bounds.size,before)&&macfx::virtualPresentationRequired(view));
        assert(toggleFullscreen(window,target.view.window,false));
    }
    // A mapped down owns its up; a source switch waits instead of changing the
    // coordinate map or destroying a window in the middle of that gesture.
    NSEvent *down=[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:NSMakePoint(200,150) modifierFlags:0 timestamp:1
        windowNumber:target.view.window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];
    assert(macfx::virtualMappedEvent(view,down));const NSSize reduced=view.bounds.size;
    write(8,NSNull.null);pump(.15);assert(NSEqualSizes(view.bounds.size,reduced)&&[read()[@"reason"] hasPrefix:@"Waiting for "]);
    NSEvent *up=[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:NSMakePoint(900,700) modifierFlags:0 timestamp:2
        windowNumber:target.view.window.windowNumber context:nil eventNumber:2 clickCount:1 pressure:0];
    assert(macfx::virtualMappedEvent(view,up));pump(.15);
    assert(NSEqualRects(window.frame,original)&&macfx::virtualPresentationRequired(view));
    assert([read()[@"reason"] hasPrefix:@"Waiting for "]&&read()[@"applied"]==NSNull.null);
    macfx::virtualSourceFrameReady(view,target.view,CGSizeMake(1,1));assert([read()[@"reason"] length]);
    receipt(target.view);assert(![read()[@"reason"] length]&&!target.view.window.visible&&!window.parentWindow&&!macfx::virtualPresentationRequired(view));
    assert([read()[@"observed"][@"width"] doubleValue]==originalPixels.width&&[read()[@"observed"][@"height"] doubleValue]==originalPixels.height);
    write(9,@{@"multiplier":@2});pump(.15);assert(macfx::virtualPresentationRequired(view));
    target=macfx::virtualPresentationSource(view);assert(target.active&&target.view!=firstTarget);
    macfx::stopVirtualWindow(view,firstTarget);assert(macfx::virtualPresentationSource(view).active);
    receipt(firstTarget);assert([read()[@"reason"] length]);receipt(target.view);assert(![read()[@"reason"] length]);
    // A full-size request also retires needless proxy work after its frame.
    const NSSize gameMinimum=NSMakeSize(100,90),gameMaximum=NSMakeSize(900,850);
    window.contentMinSize=gameMinimum;window.contentMaxSize=gameMaximum;
    write(10,@{@"multiplier":@1});pump(.15);assert(macfx::virtualPresentationRequired(view));receipt(target.view);
    assert(!macfx::virtualPresentationRequired(view)&&!target.view.window.visible&&[read()[@"applied"] isKindOfClass:NSDictionary.class]);
    assert(NSEqualSizes(window.contentMinSize,gameMinimum)&&NSEqualSizes(window.contentMaxSize,gameMaximum));
    [window close];assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);
    std::puts("virtual live source: resize, larger maximum, actual-frame ACK, invalid/stale preservation, gesture-safe Original, re-enable and stale-target retirement passed");
}}
static void checks(bool active,bool fullscreen){@autoreleasepool{
    if([NSProcessInfo.processInfo.arguments containsObject:@"--fullscreen-failure"]){fullscreenFailureChecks();return;}
    if([NSProcessInfo.processInfo.arguments containsObject:@"--resize-constraints"]){resizeConstraintChecks();return;}
    if([NSProcessInfo.processInfo.arguments containsObject:@"--prepared-fullscreen"]){preparedFullscreenChecks();return;}
    if(active){[NSApp activateIgnoringOtherApps:YES];pump(.15);}
    if([NSProcessInfo.processInfo.arguments containsObject:@"--dormant-activation"]){dormantActivationChecks();return;}
    if([NSProcessInfo.processInfo.arguments containsObject:@"--already-satisfied"]){satisfiedSourceChecks();return;}
    if([NSProcessInfo.processInfo.arguments containsObject:@"--publisher-contract"]){publisherChecks();return;}
    if([NSProcessInfo.processInfo.arguments containsObject:@"--live-source"]){liveChecks(fullscreen);return;}
    setenv("RESHADE_RENDER_SOURCE_CONTROL","virtual",1);
    if([NSProcessInfo.processInfo.arguments containsObject:@"--diagnostics"])setenv("RESHADE_DIAGNOSTICS_VIRTUAL_WINDOW","1",1);
    const BOOL divisorOne=[NSProcessInfo.processInfo.arguments containsObject:@"--unchanged-divisor"];
    const BOOL sameHeight=[NSProcessInfo.processInfo.arguments containsObject:@"--unchanged-height"];
    const BOOL sameMaximum=[NSProcessInfo.processInfo.arguments containsObject:@"--unchanged-maximum"];
    NSRect initial=NSMakeRect(100,120,800,600);
    // An active check opens under the pointer. The whole window stays on the
    // pointer's screen at integral points, so AppKit keeps its 800x600 content.
    if(active){const NSPoint pointer=NSEvent.mouseLocation;NSScreen *screen=NSScreen.mainScreen;
        for(NSScreen *candidate in NSScreen.screens)if(NSMouseInRect(pointer,candidate.frame,NO))screen=candidate;
        const NSRect bounds=screen.visibleFrame;const NSSize frame=[NSWindow frameRectForContentRect:initial styleMask:NSWindowStyleMaskTitled].size;
        initial.origin=NSMakePoint(std::round(std::clamp(pointer.x-400,NSMinX(bounds),NSMaxX(bounds)-frame.width)),
            std::round(std::clamp(pointer.y-300,NSMinY(bounds),NSMaxY(bounds)-frame.height)));}
    NSWindow *window=[[NSWindow alloc]initWithContentRect:initial
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.title=@"Virtual input prototype";
    window.acceptsMouseMovedEvents=YES;
    VirtualInputView *source=[[VirtualInputView alloc]initWithFrame:NSMakeRect(0,0,800,600)];
    source.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;window.contentView=source;
    [window makeKeyAndOrderFront:nil];[window makeFirstResponder:source];
    const NSRect original=window.frame;const auto behavior=window.collectionBehavior;
    if(sameHeight){const char *launch=std::getenv("RESHADE_RENDER_HEIGHT");assert(launch&&std::strtoul(launch,nullptr,10)==unsigned([source convertRectToBacking:source.bounds].size.height));}
    if(divisorOne||sameHeight||sameMaximum){
        assert(!macfx::virtualPresentationRequired(source));auto unchanged=macfx::virtualPresentationSource(source);
        assert(!unchanged.active&&unchanged.view==source&&NSEqualRects(window.frame,original));
        if(divisorOne)assert(!macfx::virtualWindowEnabled());[window close];std::puts("virtual window: unchanged allocation creates no proxy");return;
    }
    assert(macfx::virtualPresentationRequired(source));
    auto target=macfx::virtualPresentationSource(source,CGSizeMake(1600,1200));
    assert(target.active&&target.view&&target.view.window!=window&&macfx::isVirtualOutputWindow(target.view.window));
    assert(window.visible&&window.parentWindow==target.view.window);
    if(!close(source.bounds.size.width,400)||!close(source.bounds.size.height,300))std::fprintf(stderr,"virtual source=%.1fx%.1f output=%.1fx%.1f window=%s screen=%s scale=%.1f\n",
        source.bounds.size.width,source.bounds.size.height,target.view.bounds.size.width,target.view.bounds.size.height,NSStringFromRect(window.frame).UTF8String,NSStringFromRect(window.screen.frame).UTF8String,window.backingScaleFactor);
    assert(close(source.bounds.size.width,400)&&close(source.bounds.size.height,300));
    assert(close(target.view.bounds.size.width,800)&&close(target.view.bounds.size.height,600));
    assert(close(target.outputPixels.width,800*target.view.window.backingScaleFactor));
    assert(!target.view.window.visible);macfx::revealVirtualWindow(source);assert(target.view.window.visible);
    const NSPoint outputLocal=NSMakePoint(200,150),outputWindow=[target.view convertPoint:outputLocal toView:nil];
    NSEvent *event=[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:outputWindow modifierFlags:NSEventModifierFlagShift
        timestamp:1 windowNumber:target.view.window.windowNumber context:nil eventNumber:7 clickCount:2 pressure:.75];
    NSEvent *mapped=macfx::virtualMappedEvent(source,event);
    assert(mapped&&mapped!=event&&mapped.window==window&&mapped.windowNumber==window.windowNumber);
    assert(close(mapped.locationInWindow.x,100)&&close(mapped.locationInWindow.y,75));
    assert(mapped.clickCount==2&&close(mapped.pressure,.75)&&mapped.modifierFlags==event.modifierFlags);
    assert(close(mapped.deltaX,event.deltaX)&&close(mapped.deltaY,event.deltaY));
    assert(event.window==target.view.window&&close(event.locationInWindow.x,outputWindow.x));
    [window sendEvent:mapped];assert(source.clicks==1&&close(source.lastPoint.x,100)&&close(source.lastPoint.y,75));
    source.testFlipped=YES;mapped=macfx::virtualMappedEvent(source,event);[window sendEvent:mapped];
    assert(source.clicks==2&&close(source.lastPoint.x,100)&&close(source.lastPoint.y,225));source.testFlipped=NO;
    NSPoint screen=[target.view.window convertPointToScreen:outputWindow],sourceScreen,roundtrip;
    assert(macfx::virtualMapScreenPoint(source,screen,&sourceScreen));
    assert(macfx::virtualUnmapScreenPoint(source,sourceScreen,&roundtrip));assert(close(roundtrip.x,screen.x)&&close(roundtrip.y,screen.y));
    if(active){[NSApp activateIgnoringOtherApps:YES];[NSRunningApplication.currentApplication activateWithOptions:NSApplicationActivateAllWindows|NSApplicationActivateIgnoringOtherApps];
        [window makeKeyWindow];for(unsigned i=0;i<100&&!NSApp.isActive;++i)pump(.05);
        [window makeKeyWindow];pump(.1);assert(window.isKeyWindow);}
    NSEvent *motion=[NSEvent mouseEventWithType:NSEventTypeMouseMoved location:outputWindow modifierFlags:0 timestamp:2
        windowNumber:target.view.window.windowNumber context:nil eventNumber:8 clickCount:0 pressure:0];
    CGEventRef rawMotion=motion.CGEvent;CGEventSetIntegerValueField(rawMotion,kCGMouseEventDeltaX,80);CGEventSetIntegerValueField(rawMotion,kCGMouseEventDeltaY,-12);
    motion=[NSEvent eventWithCGEvent:rawMotion];assert(close(motion.deltaX,80)&&close(motion.deltaY,-12));
    NSEvent *mappedMotion=macfx::virtualMappedEvent(source,motion);assert(mappedMotion&&mappedMotion!=motion&&mappedMotion.window==window);
    assert(close(mappedMotion.deltaX,80)&&close(mappedMotion.deltaY,-12));
    if(active){const auto motionsBefore=source.motions;[window sendEvent:mappedMotion];
        if(source.motions!=motionsBefore+1)std::fprintf(stderr,"virtual motion active=%u key=%u motions=%u before=%u\n",NSApp.active,window.isKeyWindow,unsigned(source.motions),unsigned(motionsBefore));
        assert(source.motions==motionsBefore+1&&close(source.lastDelta.x,80)&&close(source.lastDelta.y,-12));}
    NSPoint polled=macfx::virtualMappedPollingPoint(screen);
    if(active)assert(close(polled.x,sourceScreen.x)&&close(polled.y,sourceScreen.y));
    else assert(close(polled.x,screen.x)&&close(polled.y,screen.y));
    NSPoint localInput=[window convertPointFromScreen:screen],localExpected=[window convertPointFromScreen:sourceScreen];
    NSPoint localPolled=macfx::virtualMappedWindowPollingPoint(window,localInput);
    if(active)assert(close(localPolled.x,localExpected.x)&&close(localPolled.y,localExpected.y));
    else assert(close(localPolled.x,localInput.x)&&close(localPolled.y,localInput.y));
    if(active){
        CGEventRef pointer=CGEventCreate(nullptr);const CGPoint position=CGEventGetLocation(pointer);CFRelease(pointer);
        NSPoint physical=NSMakePoint(position.x,NSMaxY(NSScreen.screens.firstObject.frame)-position.y),expected;
        assert(macfx::virtualMapScreenPoint(source,physical,&expected));
        NSPoint actual=NSEvent.mouseLocation;assert(close(actual.x,expected.x)&&close(actual.y,expected.y));
        NSPoint expectedWindow=[window convertPointFromScreen:expected],actualWindow=window.mouseLocationOutsideOfEventStream;
        assert(close(actualWindow.x,expectedWindow.x)&&close(actualWindow.y,expectedWindow.y));
    }
    const double desktopTop=NSMaxY(NSScreen.screens.firstObject.frame);
    CGPoint warped=macfx::virtualMappedWarpPoint(CGPointMake(sourceScreen.x,desktopTop-sourceScreen.y));
    if(active)assert(close(warped.x,screen.x)&&close(warped.y,desktopTop-screen.y));
    else assert(close(warped.x,sourceScreen.x)&&close(warped.y,desktopTop-sourceScreen.y));
    if(fullscreen){
        assert(toggleFullscreen(window,target.view.window,true));
        pump(.5);
        assert(window.isKeyWindow&&window.onActiveSpace&&window.parentWindow==target.view.window);target=macfx::virtualPresentationSource(source);
        assert(window.occlusionState&NSWindowOcclusionStateVisible);
        NSPoint center=NSMakePoint(NSMidX(target.view.bounds),NSMidY(target.view.bounds));
        NSPoint fullScreen=[target.view.window convertPointToScreen:[target.view convertPoint:center toView:nil]];
        assert(macfx::virtualMapScreenPoint(source,fullScreen,&sourceScreen));
        assert(macfx::virtualUnmapScreenPoint(source,sourceScreen,&roundtrip));
        assert(close(roundtrip.x,fullScreen.x)&&close(roundtrip.y,fullScreen.y));
        assert(toggleFullscreen(window,target.view.window,false));
        assert(window.isKeyWindow);target=macfx::virtualPresentationSource(source);
    }
    // A game-constrained source aspect uses the same fitted child for pixels and
    // pointer mapping, with clicks in the black host rejected.
    source.autoresizingMask=NSViewNotSizable;source.frame=NSMakeRect(0,0,400,200);
    target=macfx::virtualPresentationSource(source);assert(close(target.view.frame.origin.y,100));
    NSPoint bar=[target.view.window convertPointToScreen:NSMakePoint(200,30)];
    assert(!macfx::virtualMapScreenPoint(source,bar,&sourceScreen));
    NSPoint inside=[target.view.window convertPointToScreen:NSMakePoint(400,300)];
    assert(macfx::virtualMapScreenPoint(source,inside,&sourceScreen));
    NSEvent *title=[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:NSMakePoint(200,610) modifierFlags:0 timestamp:1
        windowNumber:target.view.window.windowNumber context:nil eventNumber:8 clickCount:1 pressure:1];
    assert(macfx::virtualMappedEvent(source,title)==title);
    NSEvent *border=[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:NSMakePoint(2,200) modifierFlags:0 timestamp:1
        windowNumber:target.view.window.windowNumber context:nil eventNumber:9 clickCount:1 pressure:1];
    assert(macfx::virtualMappedEvent(source,border)==border);
    const auto pointer=[&](NSEventType type,NSPoint point,NSInteger button=0,NSWindow *output=nil){
        if(!output)output=target.view.window;
        NSEvent *input=[NSEvent mouseEventWithType:type location:point modifierFlags:NSEventModifierFlagShift timestamp:3
            windowNumber:output.windowNumber context:nil eventNumber:10 clickCount:1 pressure:.5];
        CGEventRef raw=CGEventCreateCopy(input.CGEvent);CGEventSetIntegerValueField(raw,kCGMouseEventButtonNumber,button);
        NSEvent *copy=[NSEvent eventWithCGEvent:raw];CFRelease(raw);
        assert(copy.window==output&&copy.buttonNumber==button);return copy;
    };
    const NSPoint image=NSMakePoint(400,300),letterbox=NSMakePoint(400,30),outside=NSMakePoint(900,700);
    NSEvent *down=pointer(NSEventTypeLeftMouseDown,image),*ownedDown=macfx::virtualMappedEvent(source,down);
    assert(ownedDown&&ownedDown!=down&&ownedDown.window==window);
    NSEvent *drag=pointer(NSEventTypeLeftMouseDragged,letterbox),*ownedDrag=macfx::virtualMappedEvent(source,drag);
    assert(ownedDrag&&ownedDrag!=drag&&ownedDrag.window==window&&ownedDrag.type==drag.type);
    NSPoint dragPoint=[source convertPoint:ownedDrag.locationInWindow fromView:nil];
    assert(dragPoint.y>=0&&dragPoint.y<source.bounds.size.height);
    NSEvent *foreignButton=pointer(NSEventTypeRightMouseUp,letterbox,1);
    assert(macfx::virtualMappedEvent(source,foreignButton)==foreignButton);
    NSEvent *up=pointer(NSEventTypeLeftMouseUp,outside),*ownedUp=macfx::virtualMappedEvent(source,up);
    assert(ownedUp&&ownedUp!=up&&ownedUp.window==window&&ownedUp.type==up.type);
    NSPoint upPoint=[source convertPoint:ownedUp.locationInWindow fromView:nil];
    assert(close(upPoint.x,400)&&close(upPoint.y,200));
    assert(up.window==target.view.window&&close(up.locationInWindow.x,outside.x));
    NSEvent *unmatched=pointer(NSEventTypeLeftMouseUp,image);assert(macfx::virtualMappedEvent(source,unmatched)==unmatched);
    // A native title-bar or resize gesture never becomes a game gesture when
    // it subsequently enters the image. Black bars do not own a fresh press.
    const NSPoint chromePoints[]={NSMakePoint(200,610),NSMakePoint(2,200)};
    for(NSPoint chrome:chromePoints){
        NSEvent *nativeDown=pointer(NSEventTypeLeftMouseDown,chrome);assert(macfx::virtualMappedEvent(source,nativeDown)==nativeDown);
        NSEvent *nativeDrag=pointer(NSEventTypeLeftMouseDragged,image);assert(macfx::virtualMappedEvent(source,nativeDrag)==nativeDrag);
        assert(macfx::virtualMappedEvent(source,unmatched)==unmatched);
    }
    assert(!macfx::virtualMappedEvent(source,pointer(NSEventTypeLeftMouseDown,letterbox)));
    assert(macfx::virtualMappedEvent(source,unmatched)==unmatched);
    // Independent buttons retain their own receipt until their matching up.
    assert(macfx::virtualMappedEvent(source,pointer(NSEventTypeLeftMouseDown,image)));
    assert(macfx::virtualMappedEvent(source,pointer(NSEventTypeRightMouseDown,image,1)));
    NSEvent *rightUp=pointer(NSEventTypeRightMouseUp,outside,1),*mappedRightUp=macfx::virtualMappedEvent(source,rightUp);
    assert(mappedRightUp&&mappedRightUp!=rightUp&&mappedRightUp.window==window);
    assert(macfx::virtualMappedEvent(source,drag));ownedUp=macfx::virtualMappedEvent(source,up);assert(ownedUp&&ownedUp!=up);
    assert(macfx::virtualMappedEvent(source,pointer(NSEventTypeOtherMouseDown,image,3)));
    NSEvent *otherUp=pointer(NSEventTypeOtherMouseUp,outside,4);assert(macfx::virtualMappedEvent(source,otherUp)==otherUp);
    otherUp=pointer(NSEventTypeOtherMouseUp,outside,3);NSEvent *mappedOtherUp=macfx::virtualMappedEvent(source,otherUp);
    assert(mappedOtherUp&&mappedOtherUp!=otherUp&&mappedOtherUp.window==window);
    NSWindow *second=[[NSWindow alloc]initWithContentRect:NSMakeRect(40,50,800,600) styleMask:NSWindowStyleMaskTitled
        backing:NSBackingStoreBuffered defer:NO];second.releasedWhenClosed=NO;
    VirtualInputView *secondSource=[[VirtualInputView alloc]initWithFrame:NSMakeRect(0,0,800,600)];
    secondSource.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;second.contentView=secondSource;[second orderBack:nil];
    const auto secondBehavior=second.collectionBehavior;
    auto secondTarget=macfx::virtualPresentationSource(secondSource);assert(secondTarget.active);
    assert(macfx::virtualMappedEvent(source,pointer(NSEventTypeLeftMouseDown,image)));
    NSEvent *secondUp=pointer(NSEventTypeLeftMouseUp,image,0,secondTarget.view.window);
    assert(!macfx::virtualMappedEvent(source,secondUp));assert(macfx::virtualMappedEvent(secondSource,secondUp)==secondUp);
    NSEvent *secondDown=pointer(NSEventTypeLeftMouseDown,image,0,secondTarget.view.window);
    assert(macfx::virtualMappedEvent(secondSource,secondDown));
    // An unrelated game policy must not prevent restoration of the helper's
    // fullscreen/cycling policies, including AppKit's child-window side effect.
    const auto expectedSecondBehavior=(secondBehavior&~NSWindowCollectionBehaviorFullScreenAllowsTiling)|NSWindowCollectionBehaviorFullScreenDisallowsTiling;
    second.collectionBehavior=(second.collectionBehavior&~NSWindowCollectionBehaviorFullScreenAllowsTiling)|NSWindowCollectionBehaviorFullScreenDisallowsTiling;
    macfx::stopVirtualWindow(secondSource);assert(second.collectionBehavior==expectedSecondBehavior);
    assert(!macfx::virtualMappedEvent(secondSource,secondUp));[second close];
    NSWindow *changed=[[NSWindow alloc]initWithContentRect:NSMakeRect(40,50,800,600) styleMask:NSWindowStyleMaskTitled
        backing:NSBackingStoreBuffered defer:NO];changed.releasedWhenClosed=NO;
    VirtualInputView *changedSource=[[VirtualInputView alloc]initWithFrame:NSMakeRect(0,0,800,600)];
    changedSource.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;changed.contentView=changedSource;[changed orderBack:nil];
    const auto changedBehavior=changed.collectionBehavior;
    assert(macfx::virtualPresentationSource(changedSource).active);
    const auto replacedPolicies=NSWindowCollectionBehaviorFullScreenPrimary|NSWindowCollectionBehaviorFullScreenAuxiliary|
        NSWindowCollectionBehaviorFullScreenNone|NSWindowCollectionBehaviorParticipatesInCycle|NSWindowCollectionBehaviorIgnoresCycle;
    changed.collectionBehavior=(changed.collectionBehavior&~replacedPolicies)|NSWindowCollectionBehaviorFullScreenNone|NSWindowCollectionBehaviorParticipatesInCycle;
    macfx::stopVirtualWindow(changedSource);
    assert(changed.collectionBehavior==((changedBehavior&~replacedPolicies)|NSWindowCollectionBehaviorFullScreenNone|NSWindowCollectionBehaviorParticipatesInCycle));
    [changed close];
    ownedUp=macfx::virtualMappedEvent(source,up);assert(ownedUp&&ownedUp!=up&&ownedUp.window==window);
    std::puts("virtual gestures: owned drag/up outside image, independent buttons/windows, native chrome and retirement passed");
    NSWindow *unrelated=nil;
    if(active){
        unrelated=[[NSWindow alloc]initWithContentRect:NSMakeRect(30,40,250,150) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        unrelated.releasedWhenClosed=NO;unrelated.title=@"Independent window";[unrelated orderFront:nil];[window makeKeyWindow];
        NSWindow *output=target.view.window;const NSSize sourceExtent=source.bounds.size;
        assert(!macfx::virtualWindowSuspended(window)&&!macfx::virtualWindowSuspended(output));
        [output miniaturize:nil];for(unsigned i=0;i<300&&(!window.miniaturized||!output.miniaturized);++i)pump(.01);
        assert(window.miniaturized&&output.miniaturized&&macfx::virtualWindowSuspended(window)&&macfx::virtualWindowSuspended(output));
        assert(macfx::virtualPresentationRequired(source));macfx::revealVirtualWindow(source);assert(output.miniaturized);
        [output deminiaturize:nil];for(unsigned i=0;i<300&&(window.miniaturized||output.miniaturized||macfx::virtualWindowSuspended(window));++i)pump(.01);
        assert(!window.miniaturized&&!output.miniaturized&&!macfx::virtualWindowSuspended(window)&&!macfx::virtualWindowSuspended(output));
        assert(window.parentWindow==output&&NSEqualSizes(source.bounds.size,sourceExtent)&&macfx::virtualPresentationSource(source).active);
        [unrelated makeKeyAndOrderFront:nil];pump(.05);assert(unrelated.keyWindow);
        [NSApp postEvent:motion atStart:NO];pump(.05);assert(unrelated.keyWindow);
        __block bool didReveal=false;dispatch_after(dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_MSEC),dispatch_get_main_queue(),^{macfx::revealVirtualWindow(source);didReveal=true;});
        pump(.1);assert(didReveal&&unrelated.keyWindow);
    }
    const NSRect beforeStopFrame=window.frame,outputBeforeStopFrame=target.view.window.frame;
    const auto beforeStopBehavior=window.collectionBehavior;
    macfx::stopVirtualWindow(source);
    std::fprintf(stderr,"virtual stop restoration: source before=%s after=%s original=%s output before=%s behavior before=0x%llx after=0x%llx original=0x%llx targetVisible=%d parent=%p\n",
        NSStringFromRect(beforeStopFrame).UTF8String,NSStringFromRect(window.frame).UTF8String,
        NSStringFromRect(original).UTF8String,NSStringFromRect(outputBeforeStopFrame).UTF8String,
        static_cast<unsigned long long>(beforeStopBehavior),static_cast<unsigned long long>(window.collectionBehavior),
        static_cast<unsigned long long>(behavior),int(target.view.window.visible),(__bridge void *)window.parentWindow);
    assert(NSEqualRects(window.frame,original));
    assert(window.collectionBehavior==behavior);
    assert(!target.view.window.visible);
    assert(!window.parentWindow);
    assert(!macfx::virtualPresentationSource(source).active);
    assert(!macfx::virtualPresentationRequired(source));
    if(active)assert(unrelated.keyWindow);[unrelated close];
    polled=macfx::virtualMappedPollingPoint(screen);assert(close(polled.x,screen.x)&&close(polled.y,screen.y));
    [window close];std::printf("virtual window: resize, reveal, event dispatch, aspect fit, restore passed; polling/warp %s; fullscreen %s; minimize/focus %s\n",active?"passed":"inactive passthrough",fullscreen?"passed":"not requested",active?"passed":"not requested");
}}
@interface VirtualAppDelegate:NSObject<NSApplicationDelegate>
@property BOOL active,fullscreen;
@end
@implementation VirtualAppDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)note {
    [self performSelector:@selector(runChecks) withObject:nil afterDelay:.1];
}
- (void)runChecks {checks(self.active,self.fullscreen);[NSApp terminate:nil];}
@end
// Render-source sizes and the virtual control are launch settings
// (native-config.hpp), so each mode runs as a phase launched with its own.
// Source-control commands stay per-check.
static int launchMode(int argc,const char **argv){
    const auto has=[&](const char *flag){for(int i=1;i<argc;++i)if(!std::strcmp(argv[i],flag))return true;return false;};
    const char *multiplier=has("--prepared-fullscreen")||has("--dormant-activation")?nullptr:has("--unchanged-divisor")?"1":has("--publisher-contract")?"3":"2";
    // The check window's 600-point source on the first screen.
    std::string height;if(has("--unchanged-height")){[NSApplication sharedApplication];height=std::to_string(unsigned(600*NSScreen.screens.firstObject.backingScaleFactor));}
    return fixture::runPhase("checks",{{"RESHADE_RENDER_MULTIPLIER",multiplier},{"RESHADE_RENDER_HEIGHT",height.empty()?nullptr:height.c_str()},
        {"RESHADE_RENDER_MAX_HEIGHT",has("--unchanged-maximum")?"16384":nullptr},{"RESHADE_RENDER_AUTO",nullptr},{"RESHADE_RENDER_SOURCE_CONTROL","virtual"}},std::vector<std::string>(argv+1,argv+argc));
}
int main(int argc,const char **argv){@autoreleasepool{
    if(fixture::phase(argc,const_cast<char**>(argv)).name.empty())return launchMode(argc,argv);
    VirtualAppDelegate *delegate=[VirtualAppDelegate new];for(int i=1;i<argc;++i){delegate.active|=!std::strcmp(argv[i],"--active");delegate.fullscreen|=!std::strcmp(argv[i],"--fullscreen");}
    delegate.active|=delegate.fullscreen;[NSApplication sharedApplication];
    [NSApp setActivationPolicy:delegate.active?NSApplicationActivationPolicyRegular:NSApplicationActivationPolicyAccessory];NSApp.delegate=delegate;[NSApp run];
}}
