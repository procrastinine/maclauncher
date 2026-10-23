#include "virtual-window.hpp"
#include "resolution-scale.hpp"
#include "source-control.hpp"
#include "publisher-pixels.hpp"
#import <objc/runtime.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <map>
#include <set>
#include <mutex>
#include <atomic>
#include <memory>
#include <cstdio>

@class MacFXVirtualSession,MacFXVirtualControl;
@interface MacFXVirtualLink : NSObject
@property(nonatomic,weak) NSWindow *source;
@end
@implementation MacFXVirtualLink
@end
@interface MacFXVirtualOutputWindow : NSWindow
@end
@implementation MacFXVirtualOutputWindow
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end
@interface MacFXVirtualHost : NSView
@end
@implementation MacFXVirtualHost
- (BOOL)isOpaque { return YES; }
- (void)drawRect:(NSRect)rect { [NSColor.blackColor setFill];NSRectFill(rect); }
@end
@interface MacFXVirtualEventData : NSObject {
@public CGEventRef quartz;
}
@property(nonatomic,weak) NSWindow *window;
@property(nonatomic) NSPoint point;
@end
@implementation MacFXVirtualEventData
- (void)dealloc { if(quartz)CFRelease(quartz); }
@end
@interface MacFXVirtualPublisherPixels : NSObject {
@public macfx::PublisherPixelMapping mapping;
@public const void *publisher;
}
@end
@implementation MacFXVirtualPublisherPixels
@end

namespace {
char sessionKey,outputKey,eventKey,controlKey,publisherPixelSpaceKey,publisherPixelsKey,publisherIdentityKey;
__weak MacFXVirtualControl *activeSourceControl=nil;
std::atomic<const void*> pendingSource{nullptr};
std::atomic<bool>activationRequested{false};
std::atomic<bool>activationOwned{false};
std::shared_ptr<macfx::SourceControlReader>activationReader;
std::optional<macfx::SourceControlCommand>activationCommand;
bool activationEnabled(){static const bool enabled=[](){const char *flag=std::getenv("RESHADE_RENDER_SOURCE_ACTIVATION_API"),*kind=std::getenv("RESHADE_RENDER_SOURCE_CONTROL");
    return flag&&!std::strcmp(flag,"1")&&kind&&!std::strcmp(kind,"virtual");}();return enabled;}
void pollActivationCommand();
void setFramePending(const void *source,bool pending){
    if(pending)pendingSource.store(source,std::memory_order_release);
    else pendingSource.compare_exchange_strong(source,nullptr,std::memory_order_acq_rel);
}
struct InputCounts {std::atomic<uint64_t> polls{0},windowPolls{0},warps{0},events{0},mapped{0},bars{0},chrome{0};};
struct InputGeometry {NSRect output,source;NSPoint windowOrigin;void *window=nullptr;double desktopTop=0;bool active=false;std::shared_ptr<InputCounts> counts;};
std::mutex &inputMutex(){static auto *value=new std::mutex;return *value;}
std::map<void*,InputGeometry> &inputGeometries(){static auto *value=new std::map<void*,InputGeometry>;return *value;}
bool translatePoint(NSPoint point,const NSRect &from,const NSRect &to,NSPoint &mapped){
    if(!NSPointInRect(point,from)||from.size.width<=0||from.size.height<=0)return false;
    mapped=NSMakePoint(to.origin.x+(point.x-from.origin.x)*to.size.width/from.size.width,
        to.origin.y+(point.y-from.origin.y)*to.size.height/from.size.height);return true;
}
IMP originalMouseLocation=nullptr;
IMP originalWindowMouseLocation=nullptr;
thread_local bool samplingPhysicalMouse=false;
IMP originalToggleFullscreen=nullptr;
void toggleFullscreen(id window,SEL selector,id sender);
NSPoint pollingMouseLocation(id object,SEL selector){
    const auto original=reinterpret_cast<NSPoint(*)(id,SEL)>(originalMouseLocation);
    const NSPoint point=original(object,selector);return samplingPhysicalMouse?point:macfx::virtualMappedPollingPoint(point);
}
NSPoint windowPollingMouseLocation(id object,SEL selector){
    const auto original=reinterpret_cast<NSPoint(*)(id,SEL)>(originalWindowMouseLocation);
    if(samplingPhysicalMouse)return original(object,selector);
    struct Sample{Sample(){samplingPhysicalMouse=true;}~Sample(){samplingPhysicalMouse=false;}} sample;
    const NSPoint physical=original(object,selector);return macfx::virtualMappedWindowPollingPoint(object,physical);
}
void installPollingHook(){static dispatch_once_t once;dispatch_once(&once,^{
    Method method=class_getClassMethod(NSEvent.class,@selector(mouseLocation));
    originalMouseLocation=method_setImplementation(method,reinterpret_cast<IMP>(pollingMouseLocation));
    method=class_getInstanceMethod(NSWindow.class,@selector(mouseLocationOutsideOfEventStream));
    originalWindowMouseLocation=method_setImplementation(method,reinterpret_cast<IMP>(windowPollingMouseLocation));
    method=class_getInstanceMethod(NSWindow.class,@selector(toggleFullScreen:));
    originalToggleFullscreen=method_setImplementation(method,reinterpret_cast<IMP>(toggleFullscreen));
});}
MacFXVirtualEventData *eventData(id event){return objc_getAssociatedObject(event,&eventKey);}
id eventWindow(id event,SEL){return eventData(event).window;}
NSInteger eventWindowNumber(id event,SEL){return eventData(event).window.windowNumber;}
NSPoint eventPoint(id event,SEL){return eventData(event).point;}
CGEventRef eventQuartz(id event,SEL){return eventData(event)->quartz;}
// A distinct eventWithCGEvent copy keeps AppKit's concrete event storage and
// every original field. Its per-copy subclass overrides only geometry getters;
// no shared AppKit class or original event is modified.
Class mappedEventClass(Class base){
    NSString *name=[@"MacFXVirtual_" stringByAppendingString:NSStringFromClass(base)];
    Class result=NSClassFromString(name);if(result)return result;
    result=objc_allocateClassPair(base,name.UTF8String,0);if(!result)return Nil;
    const struct {SEL selector;IMP implementation;} entries[]={
        {@selector(window),(IMP)eventWindow},{@selector(windowNumber),(IMP)eventWindowNumber},
        {@selector(locationInWindow),(IMP)eventPoint},{@selector(CGEvent),(IMP)eventQuartz}};
    for(const auto &entry:entries){Method method=class_getInstanceMethod(base,entry.selector);
        if(!method||!class_addMethod(result,entry.selector,entry.implementation,method_getTypeEncoding(method))){objc_disposeClassPair(result);return Nil;}}
    objc_registerClassPair(result);return result;
}
bool validSize(CGSize size){return std::isfinite(size.width)&&std::isfinite(size.height)&&size.width>=1&&size.height>=1;}
bool ownsSourceGeometry(NSView *view);
NSSize publisherPixels(NSView *view){
    if(MacFXVirtualPublisherPixels *actual=objc_getAssociatedObject(view,&publisherPixelsKey)){
        const auto pixels=actual->mapping.pixels({view.bounds.size.width,view.bounds.size.height},ownsSourceGeometry(view));
        return NSMakeSize(pixels.width,pixels.height);
    }
    NSNumber *space=objc_getAssociatedObject(view,&publisherPixelSpaceKey);
    return space&&space.unsignedIntegerValue==unsigned(macfx::VirtualPublisherPixelSpace::Points)?view.bounds.size:[view convertRectToBacking:view.bounds].size;
}
bool coversWindowContent(NSView *view){
    NSView *content=view.window.contentView;if(!content)return false;
    const NSRect actual=[view convertRect:view.bounds toView:content],required=content.bounds;
    return std::abs(NSMinX(actual)-NSMinX(required))<=1&&std::abs(NSMinY(actual)-NSMinY(required))<=1&&
        std::abs(NSMaxX(actual)-NSMaxX(required))<=1&&std::abs(NSMaxY(actual)-NSMaxY(required))<=1;
}
NSSize sourceOutputPixels(NSView *view){return [view.window.contentView convertRectToBacking:view.window.contentView.bounds].size;}
bool sourceControlView(NSView *view){
    NSWindow *window=view.window;
    return window&&window.visible&&!window.miniaturized&&!window.sheetParent&&!window.parentWindow&&view.superview&&
        !view.hiddenOrHasHiddenAncestor&&view.boundsRotation==0&&view.frameRotation==0&&coversWindowContent(view);
}
bool sameSourceSize(NSSize left,NSSize right){return validSize(left)&&validSize(right)&&
    std::abs(left.width-right.width)<1&&std::abs(left.height-right.height)<1;}
bool requestedSourceSize(NSView *view,const macfx::RenderSourceRequest &request,NSSize pixels){
    const NSSize output=sourceOutputPixels(view);
    if(!validSize(output)||!validSize(pixels))return false;
    const auto desired=macfx::renderSourceSize(request,output.width,output.height,pixels.width,pixels.height);
    if(request.automatic)return pixels.width<=desired.width&&pixels.height<=desired.height;
    return sameSourceSize(pixels,NSMakeSize(desired.width,desired.height));
}
bool mouseType(NSEventType type){switch(type){
    case NSEventTypeLeftMouseDown:case NSEventTypeLeftMouseUp:case NSEventTypeRightMouseDown:case NSEventTypeRightMouseUp:
    case NSEventTypeOtherMouseDown:case NSEventTypeOtherMouseUp:case NSEventTypeMouseMoved:case NSEventTypeLeftMouseDragged:
    case NSEventTypeRightMouseDragged:case NSEventTypeOtherMouseDragged:case NSEventTypeScrollWheel:return true;
    default:return false;}}
MacFXVirtualSession *session(NSView *view);
MacFXVirtualControl *control(NSView *view);
macfx::RenderSourceRequest sourceRequest(NSView *view);
}

@interface MacFXVirtualSession : NSObject<NSWindowDelegate> {
@public std::shared_ptr<InputCounts> inputCounts;
@public std::set<NSInteger> pressedButtons;
}
@property(nonatomic,weak) NSView *source;
@property(nonatomic,weak) NSWindow *sourceWindow;
@property(nonatomic,strong) MacFXVirtualOutputWindow *output;
@property(nonatomic,strong) MacFXVirtualHost *host;
@property(nonatomic,strong) NSView *image;
@property(nonatomic,strong) id monitor;
@property(nonatomic,strong) NSMutableArray *observers;
@property(nonatomic) NSRect originalFrame;
@property(nonatomic) NSSize originalMin,originalMax,expectedContent;
@property(nonatomic) NSWindowCollectionBehavior originalBehavior,appliedBehavior;
@property(nonatomic) BOOL applying,stopped,revealed,fullscreenTransition,suspended,suspendKeyOwned,fullscreenKeyOwned;
@property(nonatomic) BOOL geometryOwned,prepared;
@property(nonatomic) unsigned diagnosticRecords;
- (instancetype)initWithView:(NSView *)view;
- (void)refresh;
- (void)resizeSource;
- (BOOL)commitGeometry;
- (macfx::RenderSourceSize)requestedSize:(const macfx::RenderSourceRequest &)request;
- (void)stop;
- (BOOL)map:(NSPoint)point fromOutput:(BOOL)fromOutput result:(NSPoint *)result;
- (void)diagnose:(const char *)event;
- (BOOL)ownsCurrentKey;
- (void)restoreOwnedKey:(BOOL)previouslyOwned;
- (void)beginSuspension;
- (void)finishSuspension;
@end

@interface MacFXVirtualControl : NSObject {
@public std::shared_ptr<macfx::SourceControlReader> reader;
@public std::optional<macfx::SourceControlCommand> accepted,pending;
@public const void *sourceIdentity;
}
@property(nonatomic,weak) NSView *source;
@property(nonatomic,strong) NSTimer *timer;
@property(nonatomic,strong) id closingObserver;
@property(nonatomic) BOOL readyForSession,waitingForFrame,restoringOriginal,closed,rejected,sessionReady;
@property(nonatomic) CGSize completedSource,completedOutput;
@property(nonatomic) const void *completedPublisher;
- (instancetype)initWithView:(NSView *)view;
- (void)poll;
- (void)applyPending;
- (void)sessionStopped:(MacFXVirtualSession *)owner;
- (void)sessionCreated;
- (void)frameReady:(CGSize)pixels target:(NSView *)target publisher:(const void *)publisher;
- (void)revealed:(MacFXVirtualSession *)owner;
- (void)status:(NSString *)reason;
- (void)close;
@end

@implementation MacFXVirtualSession
- (instancetype)initWithView:(NSView *)view {
    self=[super init];if(!self)return nil;
    NSWindow *source=view.window;
    if(!macfx::virtualPresentationRequired(view))return nil;
    if(activationEnabled()&&!macfx::virtualPublisherIdentity(view))return nil;
    _source=view;_sourceWindow=source;_originalFrame=source.frame;
    const char *diagnostics=std::getenv("RESHADE_DIAGNOSTICS_VIRTUAL_WINDOW");
    if(diagnostics&&*diagnostics&&std::strcmp(diagnostics,"0"))inputCounts=std::make_shared<InputCounts>();
    _originalBehavior=source.collectionBehavior;_originalMin=source.contentMinSize;_originalMax=source.contentMaxSize;
    _observers=[NSMutableArray new];
    NSRect content=[source contentRectForFrameRect:source.frame];
    NSWindowStyleMask style=source.styleMask&(NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable);
    if(!(style&NSWindowStyleMaskTitled))style=NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable;
    _output=[[MacFXVirtualOutputWindow alloc]initWithContentRect:content styleMask:style backing:NSBackingStoreBuffered defer:NO];
    _output.releasedWhenClosed=NO;_output.title=source.title;_output.delegate=self;
    // This is the original full-size content in points, not the reduced
    // producer extent. Preserve its native resize contract on the window
    // which now receives AppKit's title-bar, zoom and resize gestures.
    _output.contentMinSize=source.contentMinSize;_output.contentMaxSize=source.contentMaxSize;
    const NSSize aspect=source.contentAspectRatio;
    if(aspect.width>0&&aspect.height>0)_output.contentAspectRatio=aspect;
    else _output.contentResizeIncrements=source.contentResizeIncrements;
    _output.collectionBehavior=(source.collectionBehavior&~(NSWindowCollectionBehaviorFullScreenAuxiliary|NSWindowCollectionBehaviorFullScreenNone))|NSWindowCollectionBehaviorFullScreenPrimary;
    _output.acceptsMouseMovedEvents=YES;_output.restorable=NO;_output.opaque=YES;_output.backgroundColor=NSColor.blackColor;
    _host=[[MacFXVirtualHost alloc]initWithFrame:NSMakeRect(0,0,content.size.width,content.size.height)];
    _host.autoresizingMask=NSViewWidthSizable|NSViewHeightSizable;_output.contentView=_host;
    _image=[[NSView alloc]initWithFrame:_host.bounds];[_host addSubview:_image];
    MacFXVirtualLink *link=[MacFXVirtualLink new];link.source=source;
    objc_setAssociatedObject(_output,&outputKey,link,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    // Live activation prepares only the hidden output. The original renderer,
    // window geometry, Space and responder stay untouched until its prepared
    // replacement satisfies the visible or externally covered commit gate.
    _prepared=activationEnabled();_output.ignoresMouseEvents=_prepared;_expectedContent=[source contentRectForFrameRect:source.frame].size;
    if(_prepared){
        // Give CA a live window host before its first drawable, while the
        // original remains the sole visible/key/input-owning game window.
        _output.alphaValue=0;_output.opaque=NO;_output.backgroundColor=NSColor.clearColor;
        [_output orderWindow:NSWindowBelow relativeTo:source.windowNumber];
    }
    if(!_prepared)[self commitGeometry];[self refresh];
    [self diagnose:"created"];
    installPollingHook();
    __weak MacFXVirtualSession *weakSelf=self;
    _monitor=[NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskAny handler:^NSEvent *(NSEvent *event){
        MacFXVirtualSession *owner=weakSelf;if(!owner||owner.stopped||owner.suspended||!owner.geometryOwned)return event;
        if(event.type==NSEventTypeKeyDown&&event.window==owner.sourceWindow&&
           (event.modifierFlags&(NSEventModifierFlagCommand|NSEventModifierFlagControl))==(NSEventModifierFlagCommand|NSEventModifierFlagControl)&&
           [event.charactersIgnoringModifiers.lowercaseString isEqualToString:@"f"]){[owner.output toggleFullScreen:nil];return nil;}
        if(event.window!=owner.output||!mouseType(event.type))return event;
        if(owner->inputCounts)owner->inputCounts->events.fetch_add(1,std::memory_order_relaxed);
        NSEvent *mapped=macfx::virtualMappedEvent(owner.source,event);
        if(owner->inputCounts&&owner->inputCounts->events.load(std::memory_order_relaxed)<=16){
            std::fprintf(stderr,"{\"kind\":\"virtual-input\",\"at_s\":%.6f,\"type\":%lu,\"originalWindow\":%ld,\"mappedWindow\":%ld,\"delta\":[%.3f,%.3f],\"mappedDelta\":[%.3f,%.3f],\"sourceKey\":%d,\"sourceOnActiveSpace\":%d,\"acceptsMoved\":%d,\"firstResponder\":\"%s\"}\n",
                NSProcessInfo.processInfo.systemUptime,static_cast<unsigned long>(event.type),long(event.windowNumber),long(mapped.windowNumber),event.deltaX,event.deltaY,mapped.deltaX,mapped.deltaY,
                owner.sourceWindow.keyWindow,owner.sourceWindow.onActiveSpace,owner.sourceWindow.acceptsMouseMovedEvents,NSStringFromClass(owner.sourceWindow.firstResponder.class).UTF8String?:"");
        }
        if(mapped==event){if(owner->inputCounts)owner->inputCounts->chrome.fetch_add(1,std::memory_order_relaxed);return event;}
        if(owner->inputCounts)(mapped?owner->inputCounts->mapped:owner->inputCounts->bars).fetch_add(1,std::memory_order_relaxed);
        if(mapped){
            // Hover and background scrolling keep the current key window.
            // A button press on the owned image is an explicit focus action.
            if(event.type==NSEventTypeLeftMouseDown||event.type==NSEventTypeRightMouseDown||event.type==NSEventTypeOtherMouseDown)
                [owner.sourceWindow makeKeyWindow];
            [owner.sourceWindow sendEvent:mapped];
        }
        return nil;
    }];
    NSNotificationCenter *center=NSNotificationCenter.defaultCenter;
    for(NSString *name in @[NSWindowWillCloseNotification,NSWindowDidResizeNotification,NSWindowDidMoveNotification,NSWindowWillEnterFullScreenNotification,
        NSWindowWillMiniaturizeNotification,NSWindowDidMiniaturizeNotification,NSWindowDidDeminiaturizeNotification,NSWindowDidBecomeKeyNotification,NSWindowDidResignKeyNotification,
        NSWindowDidChangeOcclusionStateNotification,NSWindowDidChangeScreenNotification]){
        id observer=[center addObserverForName:name object:source queue:nil usingBlock:^(NSNotification *note){
            MacFXVirtualSession *owner=weakSelf;if(!owner||owner.stopped||owner.applying)return;
            if([note.name isEqualToString:NSWindowWillCloseNotification]||[note.name isEqualToString:NSWindowWillEnterFullScreenNotification]||
               owner.prepared&&([note.name isEqualToString:NSWindowWillMiniaturizeNotification]||[note.name isEqualToString:NSWindowDidMoveNotification])){[owner stop];return;}
            if([note.name isEqualToString:NSWindowWillMiniaturizeNotification]){[owner beginSuspension];}
            else if([note.name isEqualToString:NSWindowDidResizeNotification]){
                NSSize actual=[owner.sourceWindow contentRectForFrameRect:owner.sourceWindow.frame].size;
                if(std::abs(actual.width-owner.expectedContent.width)>1||std::abs(actual.height-owner.expectedContent.height)>1){
                    owner.originalFrame=owner.sourceWindow.frame;[owner stop];return;}
                [owner refresh];
            }else if([note.name isEqualToString:NSWindowDidMiniaturizeNotification]){if(owner.revealed&&!owner.output.miniaturized)[owner.output miniaturize:nil];}
            else if([note.name isEqualToString:NSWindowDidDeminiaturizeNotification]){if(owner.revealed&&owner.output.miniaturized)[owner.output deminiaturize:nil];[owner finishSuspension];}
            else if([note.name isEqualToString:NSWindowDidBecomeKeyNotification]&&owner.revealed)[owner.output orderWindow:NSWindowAbove relativeTo:owner.sourceWindow.windowNumber];
            [owner refresh];
            [owner diagnose:note.name.UTF8String];
        }];[_observers addObject:observer];
    }
    return self;
}
- (void)resizeSource {
    if(_stopped||_applying||!_geometryOwned)return;
    NSWindow *window=_sourceWindow;NSView *source=_source;if(!window||!source){[self stop];return;}
    MacFXVirtualControl *channel=control(source);
    const auto requested=sourceRequest(source);
    const auto desired=[self requestedSize:requested];
    if(!validSize(CGSizeMake(desired.width,desired.height))){[self stop];return;}
    const NSSize pixels=publisherPixels(source),content=window.contentView.bounds.size;
    if(!validSize(pixels)||!validSize(content)){[self stop];return;}
    const auto converted=macfx::publisherPointExtent({desired.width,desired.height},
        {pixels.width,pixels.height},{content.width,content.height});
    NSSize size=NSMakeSize(converted.width,converted.height);
    _applying=YES;
    if(channel.restoringOriginal)[window setFrame:_originalFrame display:NO];
    else{
        [window setContentSize:size];
        NSRect frame=window.frame;frame.origin=_output.frame.origin;[window setFrame:frame display:NO];
    }
    _expectedContent=[window contentRectForFrameRect:window.frame].size;_applying=NO;
}
- (BOOL)commitGeometry {
    if(_stopped)return NO;if(_geometryOwned)return YES;
    NSWindow *window=_sourceWindow;
    if(!window||!sourceControlView(_source)||(window.styleMask&NSWindowStyleMaskFullScreen))return NO;
    _originalFrame=[window frameRectForContentRect:[_output contentRectForFrameRect:_output.frame]];
    _applying=YES;
    window.collectionBehavior=(window.collectionBehavior&~(NSWindowCollectionBehaviorFullScreenPrimary|NSWindowCollectionBehaviorFullScreenNone|
        NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorMoveToActiveSpace))|NSWindowCollectionBehaviorFullScreenAuxiliary;
    [_output addChildWindow:window ordered:NSWindowBelow];_appliedBehavior=window.collectionBehavior;
    window.contentMinSize=NSMakeSize(1,1);window.contentMaxSize=NSMakeSize(100000,100000);
    _geometryOwned=YES;_prepared=NO;_output.ignoresMouseEvents=NO;_applying=NO;[self resizeSource];[self refresh];return !_stopped;
}
- (macfx::RenderSourceSize)requestedSize:(const macfx::RenderSourceRequest &)request {
    const NSSize output=[_host convertRectToBacking:_host.bounds].size;
    // Infer the unreduced publisher from current point-to-pixel units, rather
    // than its last reduced frame or a backing scale cached on another screen.
    const NSSize pixels=publisherPixels(_source),content=_sourceWindow.contentView.bounds.size;
    if(!validSize(pixels)||!validSize(content))return {0,0};
    return macfx::renderSourceSize(request,output.width,output.height,
        _host.bounds.size.width*pixels.width/content.width,_host.bounds.size.height*pixels.height/content.height);
}
- (void)refresh {
    if(_stopped)return;NSView *source=_source;if(!source||!source.window){[self stop];return;}
    const NSSize available=_host.bounds.size,actual=source.bounds.size;
    if(!validSize(available)||!validSize(actual)){[self stop];return;}
    const double factor=std::min(available.width/actual.width,available.height/actual.height);
    const NSSize fit=NSMakeSize(actual.width*factor,actual.height*factor);
    _image.frame=NSMakeRect((available.width-fit.width)*.5,(available.height-fit.height)*.5,fit.width,fit.height);
    _output.title=_sourceWindow.title;
    InputGeometry geometry;
    geometry.output=[_output convertRectToScreen:[_image convertRect:_image.bounds toView:nil]];
    geometry.source=[_sourceWindow convertRectToScreen:[source convertRect:source.bounds toView:nil]];
    geometry.windowOrigin=[_sourceWindow convertPointToScreen:NSZeroPoint];geometry.window=(__bridge void*)_sourceWindow;
    geometry.counts=inputCounts;
    geometry.desktopTop=NSMaxY(NSScreen.screens.firstObject.frame);
    geometry.active=_geometryOwned&&_revealed&&!_suspended&&_output.visible&&!_output.miniaturized&&NSApp.active&&_sourceWindow.isKeyWindow;
    {std::lock_guard<std::mutex> guard(inputMutex());inputGeometries()[(__bridge void*)self]=geometry;}
}
- (BOOL)ownsCurrentKey {NSWindow *key=NSApp.keyWindow;return key&&(key==_sourceWindow||key==_output);}
- (void)restoreOwnedKey:(BOOL)previouslyOwned {
    NSWindow *source=_sourceWindow,*key=NSApp.keyWindow;
    if(!NSApp.active||!source.visible||source.miniaturized||_suspended||source==key)return;
    // An unrelated dialog/window may have acquired focus while GPU work or an
    // AppKit transition was pending. Its ownership takes precedence.
    if(key&&key!=source&&key!=_output)return;
    if(previouslyOwned||key==_output)[source makeKeyWindow];
}
- (void)beginSuspension {
    if(_stopped)return;if(!_suspended)_suspendKeyOwned=[self ownsCurrentKey];_suspended=YES;[self refresh];[self diagnose:"will-minimize"];
}
- (void)finishSuspension {
    if(_stopped)return;_suspended=_sourceWindow.miniaturized||_output.miniaturized;
    if(!_suspended)[self restoreOwnedKey:_suspendKeyOwned];[self refresh];[self diagnose:_suspended?"resume-pending":"resumed"];
}
- (void)diagnose:(const char *)event {
    if(!inputCounts||_diagnosticRecords++>=128)return;
    NSWindow *source=_sourceWindow,*output=_output;
    NSRect sf=source.frame,of=output.frame,fit=_image.frame;NSSize extent=_source.bounds.size;
    std::fprintf(stderr,"{\"kind\":\"virtual-window\",\"at_s\":%.6f,\"event\":\"%s\",\"source\":%ld,\"output\":%ld,\"sourceVisible\":%d,\"sourceOnActiveSpace\":%d,\"sourceOcclusion\":%lu,\"sourceKey\":%d,\"sourceParent\":%ld,\"sourceCollection\":%lu,\"sourceFrame\":[%.3f,%.3f,%.3f,%.3f],\"sourceExtent\":[%.3f,%.3f],\"outputVisible\":%d,\"outputOnActiveSpace\":%d,\"outputOcclusion\":%lu,\"outputFullscreen\":%d,\"outputFrame\":[%.3f,%.3f,%.3f,%.3f],\"imageFrame\":[%.3f,%.3f,%.3f,%.3f],\"polls\":%llu,\"windowPolls\":%llu,\"warps\":%llu,\"events\":%llu,\"mapped\":%llu,\"bars\":%llu,\"chrome\":%llu}\n",
        NSProcessInfo.processInfo.systemUptime,event,long(source.windowNumber),long(output.windowNumber),source.visible,source.onActiveSpace,static_cast<unsigned long>(source.occlusionState),source.keyWindow,long(source.parentWindow.windowNumber),static_cast<unsigned long>(source.collectionBehavior),
        sf.origin.x,sf.origin.y,sf.size.width,sf.size.height,extent.width,extent.height,output.visible,output.onActiveSpace,static_cast<unsigned long>(output.occlusionState),bool(output.styleMask&NSWindowStyleMaskFullScreen),
        of.origin.x,of.origin.y,of.size.width,of.size.height,fit.origin.x,fit.origin.y,fit.size.width,fit.size.height,
        static_cast<unsigned long long>(inputCounts->polls.load()),static_cast<unsigned long long>(inputCounts->windowPolls.load()),static_cast<unsigned long long>(inputCounts->warps.load()),static_cast<unsigned long long>(inputCounts->events.load()),static_cast<unsigned long long>(inputCounts->mapped.load()),static_cast<unsigned long long>(inputCounts->bars.load()),static_cast<unsigned long long>(inputCounts->chrome.load()));
}
- (BOOL)map:(NSPoint)point fromOutput:(BOOL)fromOutput result:(NSPoint *)result {
    if(_stopped||!result||!_source.window)return NO;[self refresh];
    NSRect sourceBounds=_source.bounds,targetBounds=_image.bounds;
    if(!validSize(sourceBounds.size)||!validSize(targetBounds.size))return NO;
    if(fromOutput){
        NSPoint local=[_image convertPoint:[_output convertPointFromScreen:point] fromView:nil];
        if(!NSPointInRect(local,targetBounds))return NO;
        double u=(local.x-targetBounds.origin.x)/targetBounds.size.width,v=(local.y-targetBounds.origin.y)/targetBounds.size.height;
        if(_source.isFlipped)v=1-v;
        NSPoint mapped=NSMakePoint(sourceBounds.origin.x+u*sourceBounds.size.width,sourceBounds.origin.y+v*sourceBounds.size.height);
        *result=[_sourceWindow convertPointToScreen:[_source convertPoint:mapped toView:nil]];
    }else{
        NSPoint local=[_source convertPoint:[_sourceWindow convertPointFromScreen:point] fromView:nil];
        if(!NSPointInRect(local,sourceBounds))return NO;
        double u=(local.x-sourceBounds.origin.x)/sourceBounds.size.width,v=(local.y-sourceBounds.origin.y)/sourceBounds.size.height;
        if(_source.isFlipped)v=1-v;
        NSPoint mapped=NSMakePoint(targetBounds.origin.x+u*targetBounds.size.width,targetBounds.origin.y+v*targetBounds.size.height);
        *result=[_output convertPointToScreen:[_image convertPoint:mapped toView:nil]];
    }return YES;
}
- (void)windowDidResize:(NSNotification *)note {if(!_applying&&_geometryOwned){
    if(!_fullscreenTransition&&!(_output.styleMask&NSWindowStyleMaskFullScreen))
        _originalFrame=[_sourceWindow frameRectForContentRect:[_output contentRectForFrameRect:_output.frame]];
    [self resizeSource];[self refresh];}}
- (void)windowDidChangeBackingProperties:(NSNotification *)note {[self resizeSource];[self refresh];}
- (void)windowDidMove:(NSNotification *)note {if(!_applying&&_geometryOwned){_applying=YES;[_sourceWindow setFrameOrigin:_output.frame.origin];_applying=NO;
    if(!_fullscreenTransition&&!(_output.styleMask&NSWindowStyleMaskFullScreen))
        _originalFrame=[_sourceWindow frameRectForContentRect:[_output contentRectForFrameRect:_output.frame]];
    [self refresh];}}
- (void)windowWillEnterFullScreen:(NSNotification *)note {_fullscreenKeyOwned=[self ownsCurrentKey];_fullscreenTransition=YES;[self diagnose:"will-enter-fullscreen"];}
- (void)windowWillExitFullScreen:(NSNotification *)note {_fullscreenKeyOwned=[self ownsCurrentKey];_fullscreenTransition=YES;[self diagnose:"will-exit-fullscreen"];}
- (void)windowDidEnterFullScreen:(NSNotification *)note {_fullscreenTransition=NO;[self restoreOwnedKey:_fullscreenKeyOwned];[self resizeSource];[self refresh];[self diagnose:"entered-fullscreen"];
    __weak MacFXVirtualSession *weakSelf=self;dispatch_after(dispatch_time(DISPATCH_TIME_NOW,300*NSEC_PER_MSEC),dispatch_get_main_queue(),^{[weakSelf diagnose:"fullscreen-settled"];});}
- (void)windowDidExitFullScreen:(NSNotification *)note {_fullscreenTransition=NO;[self restoreOwnedKey:_fullscreenKeyOwned];[self windowDidResize:note];[self diagnose:"exited-fullscreen"];}
- (void)windowDidFailToEnterFullScreen:(NSWindow *)window {
    if(_stopped||window!=_output)return;_fullscreenTransition=NO;
    [self restoreOwnedKey:_fullscreenKeyOwned];
    [self windowDidResize:[NSNotification notificationWithName:NSWindowDidResizeNotification object:window]];[self diagnose:"failed-enter-fullscreen"];
}
- (void)windowDidFailToExitFullScreen:(NSWindow *)window {
    if(_stopped||window!=_output)return;_fullscreenTransition=NO;
    [self restoreOwnedKey:_fullscreenKeyOwned];
    [self windowDidResize:[NSNotification notificationWithName:NSWindowDidResizeNotification object:window]];[self diagnose:"failed-exit-fullscreen"];
}
- (BOOL)windowShouldClose:(NSWindow *)sender {[_sourceWindow performClose:sender];return NO;}
- (void)windowWillMiniaturize:(NSNotification *)note {if(_prepared)[self stop];else [self beginSuspension];}
- (void)windowDidMiniaturize:(NSNotification *)note {if(!_applying){_applying=YES;if(!_sourceWindow.miniaturized)[_sourceWindow miniaturize:nil];_applying=NO;[self refresh];[self diagnose:"minimized"];}}
- (void)windowDidDeminiaturize:(NSNotification *)note {if(!_applying){_applying=YES;if(_sourceWindow.miniaturized)[_sourceWindow deminiaturize:nil];_applying=NO;[self finishSuspension];}}
- (void)stop {
    if(_stopped)return;const BOOL keyOwned=[self ownsCurrentKey];_stopped=YES;_applying=YES;
    pressedButtons.clear();
    {std::lock_guard<std::mutex> guard(inputMutex());inputGeometries().erase((__bridge void*)self);}
    if(_monitor){[NSEvent removeMonitor:_monitor];_monitor=nil;}
    for(id observer in _observers)[NSNotificationCenter.defaultCenter removeObserver:observer];[_observers removeAllObjects];
    NSWindow *source=_sourceWindow;
    [self diagnose:"stopped"];
    if(source.parentWindow==_output)[_output removeChildWindow:source];
    if(source&&_geometryOwned){
        const auto current=source.collectionBehavior;auto restored=current;
        const NSWindowCollectionBehavior ownedGroups[]={
            NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorMoveToActiveSpace,
            NSWindowCollectionBehaviorFullScreenPrimary|NSWindowCollectionBehaviorFullScreenAuxiliary|NSWindowCollectionBehaviorFullScreenNone,
            NSWindowCollectionBehaviorParticipatesInCycle|NSWindowCollectionBehaviorIgnoresCycle};
        for(const auto mask:ownedGroups){
            // Restore a policy only while it remains the helper's applied
            // policy. Independent game changes and other flags stay intact.
            if((current&mask)==(_appliedBehavior&mask))restored=(restored&~mask)|(_originalBehavior&mask);
        }
        if(restored!=current)source.collectionBehavior=restored;
        if(NSEqualSizes(source.contentMinSize,NSMakeSize(1,1)))source.contentMinSize=_originalMin;
        if(NSEqualSizes(source.contentMaxSize,NSMakeSize(100000,100000)))source.contentMaxSize=_originalMax;
        [source setFrame:_originalFrame display:NO];
    }
    _output.delegate=nil;[_output orderOut:nil];[_output close];
    [self restoreOwnedKey:keyOwned];_applying=NO;
    [control(_source) sessionStopped:self];
}
- (void)dealloc {
    {std::lock_guard<std::mutex> guard(inputMutex());inputGeometries().erase((__bridge void*)self);}
    if(_monitor)[NSEvent removeMonitor:_monitor];
    for(id observer in _observers)[NSNotificationCenter.defaultCenter removeObserver:observer];
    NSWindow *output=_output,*source=_sourceWindow;if(output){output.delegate=nil;void(^close)(void)=^{if(source.parentWindow==output)[output removeChildWindow:source];[output orderOut:nil];[output close];};
        if(NSThread.isMainThread)close();else dispatch_async(dispatch_get_main_queue(),close);}
}
@end

@implementation MacFXVirtualControl
- (instancetype)initWithView:(NSView *)view {
    self=[super init];if(!self)return nil;
    // One per-launch control file cannot independently own two windows. A
    // later selected window may take over after the original window closes.
    if(activeSourceControl&&!activeSourceControl.closed)return nil;
    reader=activationEnabled()?activationReader:std::make_shared<macfx::SourceControlReader>();if(!reader||!reader->configured())return nil;
    if(activationEnabled()&&activationCommand)pending=*activationCommand;
    _source=view;sourceIdentity=(__bridge const void*)view;_readyForSession=YES;activeSourceControl=self;
    if(activationEnabled())activationOwned.store(true,std::memory_order_release);
    __weak MacFXVirtualControl *weakSelf=self;
    if(!activationEnabled()){
        _timer=[NSTimer timerWithTimeInterval:.1 repeats:YES block:^(NSTimer *){[weakSelf poll];}];
        [NSRunLoop.mainRunLoop addTimer:_timer forMode:NSRunLoopCommonModes];
    }
    _closingObserver=[NSNotificationCenter.defaultCenter addObserverForName:NSWindowWillCloseNotification object:view.window queue:nil
        usingBlock:^(NSNotification *){[weakSelf close];}];
    return self;
}
- (void)close {
    if(_closed)return;_closed=YES;[_timer invalidate];_timer=nil;
    setFramePending(sourceIdentity,false);
    if(activeSourceControl==self)activeSourceControl=nil;
    if(activationEnabled())activationOwned.store(false,std::memory_order_release);
    if(_closingObserver){[NSNotificationCenter.defaultCenter removeObserver:_closingObserver];_closingObserver=nil;}
}
- (void)dealloc {setFramePending(sourceIdentity,false);[_timer invalidate];if(_closingObserver)[NSNotificationCenter.defaultCenter removeObserver:_closingObserver];}
- (void)poll {
    if(_closed)return;
    if(!_source||!_source.window){[self close];return;}
    try {
        if(activationEnabled())pollActivationCommand();
        else if(auto command=reader->poll()){
            if(pending&&command->epoch<=pending->epoch)return;
            pending=std::move(command);_rejected=NO;
        }
        if(pending)[self applyPending];
        if(accepted&&accepted->source&&accepted->source->multiplier.value_or(0)!=1&&_readyForSession&&!_waitingForFrame&&!_rejected){
            MacFXVirtualSession *owner=session(_source);
            const NSSize output=owner&&!owner.stopped?[owner.image convertRectToBacking:owner.image.bounds].size:sourceOutputPixels(_source);
            if(!sameSourceSize(_completedSource,publisherPixels(_source))||!sameSourceSize(_completedOutput,output)){
                _waitingForFrame=YES;_completedSource=CGSizeZero;_completedOutput=CGSizeZero;_completedPublisher=nullptr;
                setFramePending(sourceIdentity,true);[self status:@"Waiting for a completed frame at the requested render source size."];
            }
        }
    }catch(const std::exception &error){
        // A malformed file cannot replace accepted settings. Keep the error
        // latched until another valid candidate, without per-frame writes.
        if(accepted&&!_rejected){[self status:[NSString stringWithUTF8String:error.what()]];_rejected=YES;}
    }
}
- (void)status:(NSString *)reason {
    if(!accepted)return;
    MacFXVirtualSession *owner=session(_source);id applied=NSNull.null;
    if(accepted->source&&owner&&!owner.stopped){
        const NSSize actual=publisherPixels(_source);
        const NSSize output=[owner.image convertRectToBacking:owner.image.bounds].size;
        applied=@{@"width":@(std::round(actual.width)),@"height":@(std::round(actual.height)),
            @"outputWidth":@(std::round(output.width)),@"outputHeight":@(std::round(output.height)),@"virtual":@YES};
    }else if(accepted->source&&!_waitingForFrame&&validSize(_completedSource)){
        applied=@{@"width":@(std::round(_completedSource.width)),@"height":@(std::round(_completedSource.height)),
            @"outputWidth":@(std::round(_completedOutput.width)),@"outputHeight":@(std::round(_completedOutput.height)),@"virtual":@NO};
    }
    std::optional<macfx::RenderSourceSize> observed;
    if(!_waitingForFrame&&validSize(_completedSource))observed=macfx::RenderSourceSize{_completedSource.width,_completedSource.height};
    reader->writeStatus(*accepted,applied,reason,_sessionReady,observed);
}
- (void)applyPending {
    if(!pending||_closed)return;NSView *view=_source;NSWindow *window=view.window;
    MacFXVirtualSession *owner=session(view);
    const auto reject=[&](NSString *reason){reader->writeStatus(*pending,NSNull.null,reason,_sessionReady);pending.reset();_rejected=YES;};
    if(!window||!view.superview||window.sheetParent){reject(@"The game view is no longer attached to its window.");return;}
    // Complete any existing pointer gesture and AppKit transition before
    // changing the coordinate map or retiring its owning output window.
    if(owner&&!owner.stopped&&(!owner->pressedButtons.empty()||owner.suspended||owner.fullscreenTransition)){
        reader->writeStatus(*pending,NSNull.null,@"Waiting for the current window transition or pointer gesture.",_sessionReady);return;
    }
    // A real selected publisher may already be at the requested pixel extent
    // without a proxy (for example a low-DPI renderer on a Retina display).
    // Layout starts the wait; only a completed producer texture can end it.
    if(pending->source&&(!owner||owner.stopped)&&pending->source->multiplier.value_or(0)!=1&&
       sourceControlView(view)&&requestedSourceSize(view,*pending->source,publisherPixels(view))){
        accepted=std::move(pending);pending.reset();reader->accept(*accepted);
        _readyForSession=YES;_waitingForFrame=YES;_restoringOriginal=NO;_completedSource=CGSizeZero;_completedOutput=CGSizeZero;_completedPublisher=nullptr;
        setFramePending(sourceIdentity,true);[self status:@"Waiting for a completed frame at the requested render source size."];return;
    }
    bool equivalentToOriginal=pending->source&&pending->source->multiplier.value_or(0)==1;
    if(pending->source&&owner&&!owner.stopped){
        const auto desired=[owner requestedSize:*pending->source];
        const NSSize output=[owner.host convertRectToBacking:owner.host.bounds].size;
        equivalentToOriginal=std::abs(desired.width-output.width)<1&&std::abs(desired.height-output.height)<1;
    }
    if(!pending->source||equivalentToOriginal){
        if(activationEnabled()&&(!owner||owner.stopped||!owner.geometryOwned)&&(!pending->source||pending->source->multiplier.value_or(0)==1)){
            // Original without geometry ownership needs no processor or
            // synthetic completed frame, including after an independent game
            // resize made an earlier non-proxy receipt stale. It confirms only
            // that no source API allocation needs restoration.
            accepted=std::move(pending);pending.reset();reader->accept(*accepted);
            _readyForSession=NO;_sessionReady=NO;_waitingForFrame=NO;_restoringOriginal=YES;_completedSource=CGSizeZero;_completedOutput=CGSizeZero;_completedPublisher=nullptr;
            setFramePending(sourceIdentity,false);
            if(owner&&!owner.stopped)[owner stop];_restoringOriginal=NO;[self status:@""];[self close];return;
        }
        if(activationEnabled()&&owner&&!owner.stopped&&!owner.geometryOwned){
            // A non-null adaptive/height request can become satisfied before
            // this prepared proxy takes ownership. Retire only that untouched
            // proxy; keep the request alive and await its real non-proxy frame.
            accepted=std::move(pending);pending.reset();reader->accept(*accepted);
            _restoringOriginal=YES;[owner stop];_restoringOriginal=NO;_readyForSession=YES;_waitingForFrame=YES;_sessionReady=NO;
            _completedSource=CGSizeZero;_completedOutput=CGSizeZero;_completedPublisher=nullptr;setFramePending(sourceIdentity,true);
            [self status:@"Waiting for a completed frame at the requested render source size."];return;
        }
        if(owner&&!owner.stopped&&(owner.output.styleMask&NSWindowStyleMaskFullScreen)){
            reject(@"Exit fullscreen before restoring the original game window.");return;
        }
        // Original changes no allocation when no proxy owns the source. Reuse
        // an actual prior completion only with the same proven publisher and
        // unchanged source/output geometry; Off needs no new processor frame.
        const bool reuse=(!owner||owner.stopped)&&!_waitingForFrame&&_completedPublisher&&
            _completedPublisher==macfx::virtualPublisherIdentity(view)&&sourceControlView(view)&&
            sameSourceSize(_completedSource,publisherPixels(view))&&sameSourceSize(_completedOutput,sourceOutputPixels(view));
        accepted=std::move(pending);pending.reset();reader->accept(*accepted);
        if(reuse){_readyForSession=NO;_restoringOriginal=NO;setFramePending(sourceIdentity,false);[self status:@""];if(activationEnabled())[self close];return;}
        _readyForSession=NO;_waitingForFrame=YES;_restoringOriginal=owner&&!owner.stopped;_completedSource=CGSizeZero;_completedOutput=CGSizeZero;
        _completedPublisher=nullptr;
        setFramePending(sourceIdentity,_waitingForFrame);
        if(_restoringOriginal){
            // Keep the same proxy and presenter until the full-sized source
            // really produces a completed frame; do not flash an old reduced
            // raw drawable while its replacement is being allocated.
            [owner resizeSource];[owner refresh];
            [self status:@"Waiting for a completed frame at the original render source size."];
        }else [self status:@"Waiting for a completed frame at the original render source size."];
        return;
    }
    if((!owner||owner.stopped)&&(window.styleMask&NSWindowStyleMaskFullScreen)){
        reject(@"Exit fullscreen before enabling a virtual render source.");return;
    }
    if((!owner||owner.stopped)&&(window.parentWindow||!window.visible||window.miniaturized)){
        reject(@"Restore the game window before enabling a virtual render source.");return;
    }
    accepted=std::move(pending);pending.reset();reader->accept(*accepted);
    _readyForSession=YES;_waitingForFrame=YES;_restoringOriginal=NO;_completedSource=CGSizeZero;_completedOutput=CGSizeZero;_completedPublisher=nullptr;
    setFramePending(sourceIdentity,true);
    if(owner&&!owner.stopped){[owner resizeSource];[owner refresh];}
    [self status:@"Waiting for a completed frame at the new render source size."];
}
- (void)sessionCreated {
    if(_closed||!accepted||!accepted->source)return;
    _waitingForFrame=YES;_completedSource=CGSizeZero;_completedOutput=CGSizeZero;_completedPublisher=nullptr;
    setFramePending(sourceIdentity,true);[self status:@"Waiting for a completed frame at the new render source size."];
}
- (void)sessionStopped:(MacFXVirtualSession *)owner {
    const BOOL restored=_restoringOriginal;
    _readyForSession=restored&&accepted&&accepted->source&&accepted->source->multiplier.value_or(0)!=1;_waitingForFrame=NO;
    setFramePending(sourceIdentity,false);
    _restoringOriginal=NO;
    if(accepted&&accepted->source&&!_rejected&&!restored)[self status:@"The virtual render source was detached. Apply a new source setting to enable it again."];
}
- (void)frameReady:(CGSize)pixels target:(NSView *)target publisher:(const void *)publisher {
    if(_closed||!_waitingForFrame||!accepted)return;
    MacFXVirtualSession *owner=session(_source);
    const bool proxy=owner&&!owner.stopped;
    if(proxy){if(owner.image!=target||owner.suspended||owner.fullscreenTransition||owner.prepared)return;}
    else if(target!=_source||!sourceControlView(_source))return;
    const NSSize actual=publisherPixels(_source);
    if(!sameSourceSize(pixels,actual))return;
    if(proxy&&accepted->source&&accepted->source->multiplier.value_or(0)!=1){
        const auto desired=[owner requestedSize:*accepted->source];
        if(accepted->source->automatic?pixels.width>desired.width||pixels.height>desired.height:!sameSourceSize(pixels,NSMakeSize(desired.width,desired.height)))return;
    }
    if(!proxy&&accepted->source&&accepted->source->multiplier.value_or(0)!=1&&!requestedSourceSize(_source,*accepted->source,pixels))return;
    // The frame receipt comes from the producer texture after GPU completion;
    // requested JSON and layout notifications cannot acknowledge allocation.
    _waitingForFrame=NO;_completedSource=pixels;_completedOutput=proxy?[owner.image convertRectToBacking:owner.image.bounds].size:sourceOutputPixels(_source);_sessionReady=YES;
    _completedPublisher=publisher;
    setFramePending(sourceIdentity,false);
    if(_restoringOriginal){[owner stop];_restoringOriginal=NO;}
    if(!_rejected)[self status:@""];
    if(activationEnabled()&&!accepted->source)[self close];
}
- (void)revealed:(MacFXVirtualSession *)owner {if(_waitingForFrame&&!_rejected)[self status:_restoringOriginal?
    @"Waiting for a completed frame at the original render source size.":@"Waiting for a completed frame at the new render source size."];}
@end

namespace {
void pollActivationCommand(){
    if(!activationReader)return;
    if(auto command=activationReader->poll()){
        activationReader->accept(*command);activationCommand=*command;
        activationRequested.store(command->source&&command->source->multiplier.value_or(0)!=1,std::memory_order_release);
        MacFXVirtualControl *owner=activeSourceControl;
        if(owner&&!owner.closed){owner->pending=*command;owner.rejected=NO;}
        else if(!command->source||command->source->multiplier.value_or(0)==1)
            activationReader->writeStatus(*command,NSNull.null,@"");
    }
}
MacFXVirtualSession *session(NSView *view){
    NSWindow *window=view.window;if(!window)return nil;
    MacFXVirtualLink *link=objc_getAssociatedObject(window,&outputKey);
    return objc_getAssociatedObject(link?link.source:window,&sessionKey);
}
MacFXVirtualControl *control(NSView *view){
    NSWindow *window=view.window;if(!window)return nil;
    MacFXVirtualLink *link=objc_getAssociatedObject(window,&outputKey);
    return objc_getAssociatedObject(link?link.source:window,&controlKey);
}
bool ownsSourceGeometry(NSView *view){MacFXVirtualSession *owner=session(view);return owner&&!owner.stopped&&owner.geometryOwned;}
macfx::RenderSourceRequest sourceRequest(NSView *view){
    MacFXVirtualControl *owner=control(view);
    if(owner&&!owner.closed&&owner->accepted)return owner->accepted->source.value_or(macfx::RenderSourceRequest{});
    if(activationEnabled()&&activationCommand)return activationCommand->source.value_or(macfx::RenderSourceRequest{});
    return macfx::launchRenderSourceRequest();
}
void toggleFullscreen(id window,SEL selector,id sender){
    MacFXVirtualSession *owner=objc_getAssociatedObject(window,&sessionKey);
    if(owner&&!owner.stopped&&owner.geometryOwned){[owner.output toggleFullScreen:sender];return;}
    // A hidden candidate has not taken over the native window. Retire it and
    // let AppKit handle the publisher's own fullscreen request unchanged.
    if(owner&&!owner.stopped)[owner stop];
    reinterpret_cast<void(*)(id,SEL,id)>(originalToggleFullscreen)(window,selector,sender);
}
}
bool macfx::virtualWindowEnabled() noexcept {
    if(activationEnabled())return activationRequested.load(std::memory_order_acquire)||activationOwned.load(std::memory_order_acquire);
    const char *control=std::getenv("RESHADE_RENDER_SOURCE_CONTROL");
    try{return control&&!std::strcmp(control,"virtual")&&
        (resolutionAutomatic()||resolutionHeight()||resolutionMaxHeight()||resolutionMultiplier().value_or(1)>1);}catch(...){return false;}
}
void macfx::pollVirtualSourceControl(bool processing){
    if(!NSThread.isMainThread||!activationEnabled())return;
    MacFXVirtualControl *owner=activeSourceControl;
    // The existing window metadata timer is the only scheduler. Dormant Off
    // does not even construct/open a reader until actual processing is needed.
    if(!processing&&!activationRequested.load(std::memory_order_acquire)&&(!owner||owner.closed))return;
    try{
        if(!activationReader){auto reader=std::make_shared<SourceControlReader>();if(!reader->configured())return;activationReader=std::move(reader);}
        if(owner&&!owner.closed)[owner poll];else pollActivationCommand();
    }catch(...){/* Preserve the accepted source on malformed/replaced input. */}
}
void macfx::setVirtualPublisherPixelSpace(NSView *view,VirtualPublisherPixelSpace space){
    setVirtualPublisherPixelSpace(view,space,nullptr);
}
void macfx::setVirtualPublisherPixelSpace(NSView *view,VirtualPublisherPixelSpace space,const void *publisher){
    if(!NSThread.isMainThread||!view||!virtualWindowEnabled())return;
    if(publisher&&[(NSValue*)objc_getAssociatedObject(view,&publisherIdentityKey) pointerValue]!=publisher)
        objc_setAssociatedObject(view,&publisherIdentityKey,[NSValue valueWithPointer:publisher],OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    NSNumber *previous=objc_getAssociatedObject(view,&publisherPixelSpaceKey);
    const bool measured=objc_getAssociatedObject(view,&publisherPixelsKey)!=nil;
    if(!measured&&((previous&&previous.unsignedIntegerValue==unsigned(space))||(!previous&&space==VirtualPublisherPixelSpace::Backing)))return;
    // A renderer changing its allocation convention retires the old proxy
    // rather than acknowledging a frame against an obsolete pixel contract.
    if(MacFXVirtualSession *owner=session(view);owner&&!owner.stopped)[owner stop];
    objc_setAssociatedObject(view,&publisherPixelsKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(view,&publisherPixelSpaceKey,@(unsigned(space)),OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
void macfx::setVirtualPublisherExtent(NSView *view,const void *publisher,CGSize pixels){
    if(!NSThread.isMainThread||!view||!publisher||!virtualWindowEnabled())return;
    MacFXVirtualPublisherPixels *actual=objc_getAssociatedObject(view,&publisherPixelsKey);
    const bool owned=ownsSourceGeometry(view);
    if(!actual){actual=[MacFXVirtualPublisherPixels new];objc_setAssociatedObject(view,&publisherPixelsKey,actual,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
    else if(actual->publisher!=publisher&&!owned)actual->mapping={};
    actual->publisher=publisher;
    const NSSize points=view.bounds.size,backing=[view convertRectToBacking:view.bounds].size;
    actual->mapping.observe({points.width,points.height},{pixels.width,pixels.height},{backing.width,backing.height},owned);
}
const void *macfx::virtualPublisherIdentity(NSView *view) noexcept {
    if(!NSThread.isMainThread||!view)return nullptr;
    MacFXVirtualPublisherPixels *actual=objc_getAssociatedObject(view,&publisherPixelsKey);
    return actual?actual->publisher:[(NSValue*)objc_getAssociatedObject(view,&publisherIdentityKey) pointerValue];
}
bool macfx::virtualPresentationRequired(NSView *view) noexcept {
    if(!NSThread.isMainThread||!view||!virtualWindowEnabled()||isVirtualOutputWindow(view.window))return false;
    MacFXVirtualSession *owner=session(view);MacFXVirtualControl *channel=control(view);
    if(activationEnabled()&&owner.stopped&&(!channel||channel.closed)){owner=nil;channel=nil;}
    if(owner&&!owner.stopped)return true;
    if(owner&&owner.stopped&&(!channel||!channel.readyForSession))return false;
    if(channel&&(channel.closed||channel->accepted&&(!channel->accepted->source||!channel.readyForSession)))return false;
    NSWindow *window=view.window;
    if(!window||window.isMiniaturized||!window.visible||window.sheetParent||window.parentWindow||!view.superview||
       view.frameRotation!=0||view.boundsRotation!=0||(window.styleMask&NSWindowStyleMaskFullScreen))return false;
    // Resizing the whole window cannot safely resize just one renderer pane
    // or preserve siblings which are absent from that pane's captured image.
    if(!coversWindowContent(view))return false;
    const NSSize current=publisherPixels(view);
    const NSSize available=[window.contentView convertRectToBacking:window.contentView.bounds].size;
    if(!validSize(current)||!validSize(available))return false;
    try{const auto request=sourceRequest(view);const auto desired=renderSourceSize(request,available.width,available.height,current.width,current.height);
        if(request.automatic&&current.width<=desired.width&&current.height<=desired.height)return false;
        return validSize(CGSizeMake(desired.width,desired.height))&&
            (std::abs(desired.width-current.width)>=1||std::abs(desired.height-current.height)>=1);
    }catch(...){return false;}
}
bool macfx::virtualWindowSuspended(NSWindow *window) noexcept {
    if(!NSThread.isMainThread||!window)return false;
    MacFXVirtualLink *link=objc_getAssociatedObject(window,&outputKey);
    MacFXVirtualSession *owner=objc_getAssociatedObject(link?link.source:window,&sessionKey);
    return owner&&!owner.stopped&&(owner.suspended||owner.sourceWindow.miniaturized||owner.output.miniaturized);
}
bool macfx::isVirtualOutputWindow(NSWindow *window) noexcept {return window&&objc_getAssociatedObject(window,&outputKey)!=nil;}
macfx::VirtualPresentationTarget macfx::virtualPresentationSource(NSView *view,CGSize){
    if(!NSThread.isMainThread)throw std::runtime_error("Virtual window layout requires the main thread");
    if(!view||isVirtualOutputWindow(view.window)||!virtualWindowEnabled())return {view,CGSizeZero,false};
    MacFXVirtualSession *owner=session(view);
    MacFXVirtualControl *channel=control(view);
    if(channel.closed){objc_setAssociatedObject(view.window,&controlKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);channel=nil;}
    // This entry is reached only by a selected actual presentation. Explicit
    // source sizing can need a completed receipt even when its allocation is
    // already correct. Initial Auto/All off never reaches this allocation.
    const char *controlFile=std::getenv("RESHADE_RENDER_SOURCE_CONTROL_FILE");
    if(!channel&&controlFile&&*controlFile&&sourceControlView(view)){
        channel=[[MacFXVirtualControl alloc]initWithView:view];
        if(channel)objc_setAssociatedObject(view.window,&controlKey,channel,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    [channel poll];
    if(owner.stopped&&channel.readyForSession){
        objc_setAssociatedObject(view.window,&sessionKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);owner=nil;
    }
    if(!owner){owner=[[MacFXVirtualSession alloc]initWithView:view];if(!owner)return {view,CGSizeZero,false};
        objc_setAssociatedObject(view.window,&sessionKey,owner,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        // An existing proxy can retain its channel across Original/re-enable.
        if(!channel){channel=[[MacFXVirtualControl alloc]initWithView:view];
            if(channel)objc_setAssociatedObject(view.window,&controlKey,channel,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
        [channel poll];
        [channel sessionCreated];
    }
    if(owner.stopped)return {view,CGSizeZero,false};[owner refresh];if(owner.stopped)return {view,CGSizeZero,false};
    NSRect pixels=[owner.image convertRectToBacking:owner.image.bounds];
    return {owner.image,CGSizeMake(std::round(pixels.size.width),std::round(pixels.size.height)),true};
}
CGSize macfx::virtualOutputSize(NSView *view){MacFXVirtualSession *owner=session(view);if(!owner||owner.stopped)return CGSizeZero;
    [owner refresh];NSRect pixels=[owner.image convertRectToBacking:owner.image.bounds];return pixels.size;}
void macfx::revealVirtualWindow(NSView *view){MacFXVirtualSession *owner=session(view);if(!owner||owner.stopped)return;
    if(virtualWindowSuspended(owner.sourceWindow))return;const BOOL keyOwned=[owner ownsCurrentKey];
    [owner refresh];owner.revealed=YES;owner.output.opaque=YES;owner.output.backgroundColor=NSColor.blackColor;owner.output.alphaValue=1;
    [owner.output orderWindow:NSWindowAbove relativeTo:owner.sourceWindow.windowNumber];[owner restoreOwnedKey:keyOwned];[owner refresh];[owner diagnose:"revealed"];[control(view) revealed:owner];}
bool macfx::virtualWindowPrepared(NSView *view) noexcept {if(!NSThread.isMainThread)return false;MacFXVirtualSession *owner=session(view);return owner&&!owner.stopped&&owner.prepared;}
bool macfx::virtualWindowTransitioning(NSView *view) noexcept {if(!NSThread.isMainThread)return true;MacFXVirtualSession *owner=session(view);
    return !owner||owner.stopped||owner.fullscreenTransition||owner.suspended||owner.sourceWindow.inLiveResize||owner.output.inLiveResize;}
bool macfx::commitVirtualWindow(NSView *view,NSView *expectedTarget){
    if(!NSThread.isMainThread)return false;MacFXVirtualSession *owner=session(view);MacFXVirtualControl *channel=control(view);
    // Consume a cancellation/newer epoch at the transaction boundary before
    // taking geometry ownership; this is not a per-frame parser refresh.
    [channel poll];
    if(!owner||owner.stopped||owner.image!=expectedTarget||!owner.revealed||owner.fullscreenTransition||owner.suspended||!owner->pressedButtons.empty()||
       !channel||channel.closed||!channel.readyForSession||!channel->accepted||!channel->accepted->source)return false;
    return [owner commitGeometry];
}
void macfx::failVirtualWindowPreparation(NSView *view,NSView *expectedTarget){
    if(!NSThread.isMainThread)return;MacFXVirtualSession *owner=session(view);if(!owner||owner.stopped||owner.image!=expectedTarget||!owner.prepared)return;
    MacFXVirtualControl *channel=control(view);channel.rejected=YES;channel.readyForSession=NO;channel.waitingForFrame=NO;
    setFramePending((__bridge const void*)view,false);[channel status:@"The replacement image did not reach the display. The original game window is retained."];[owner stop];
}
void macfx::stopVirtualWindow(NSView *view,NSView *expectedTarget){MacFXVirtualSession *owner=session(view);
    if(!expectedTarget||owner.image==expectedTarget)[owner stop];}
void macfx::stopVirtualWindow(NSView *view){stopVirtualWindow(view,nil);}
bool macfx::virtualSourceFramePending(const void *source) noexcept {
    return source&&pendingSource.load(std::memory_order_acquire)==source;
}
void macfx::virtualSourceFrameReady(NSView *view,NSView *expectedTarget,CGSize pixels){
    if(!NSThread.isMainThread)return;[control(view) frameReady:pixels target:expectedTarget publisher:nullptr];
}
void macfx::virtualSourceFrameReady(NSView *view,NSView *expectedTarget,CGSize pixels,const void *expectedPublisher){
    if(!NSThread.isMainThread||expectedPublisher!=virtualPublisherIdentity(view))return;
    [control(view) frameReady:pixels target:expectedTarget publisher:expectedPublisher];
}
void macfx::toggleVirtualFullscreen(NSView *view){MacFXVirtualSession *owner=session(view);if(owner&&!owner.stopped)[owner.sourceWindow toggleFullScreen:nil];}
bool macfx::virtualMapScreenPoint(NSView *view,NSPoint point,NSPoint *mapped){return [session(view) map:point fromOutput:YES result:mapped];}
bool macfx::virtualUnmapScreenPoint(NSView *view,NSPoint point,NSPoint *mapped){return [session(view) map:point fromOutput:NO result:mapped];}
NSPoint macfx::virtualMappedPollingPoint(NSPoint point){
    std::lock_guard<std::mutex> guard(inputMutex());
    for(const auto &entry:inputGeometries()){NSPoint mapped;const auto &g=entry.second;
        if(g.active){if(g.counts)g.counts->polls.fetch_add(1,std::memory_order_relaxed);if(translatePoint(point,g.output,g.source,mapped))return mapped;}}return point;
}
NSPoint macfx::virtualMappedWindowPollingPoint(NSWindow *window,NSPoint point){
    std::lock_guard<std::mutex> guard(inputMutex());
    for(const auto &entry:inputGeometries()){const auto &g=entry.second;NSPoint mapped;
        if(g.active&&g.window==(__bridge void*)window){if(g.counts)g.counts->windowPolls.fetch_add(1,std::memory_order_relaxed);
            if(translatePoint(NSMakePoint(point.x+g.windowOrigin.x,point.y+g.windowOrigin.y),g.output,g.source,mapped))return NSMakePoint(mapped.x-g.windowOrigin.x,mapped.y-g.windowOrigin.y);}}
    return point;
}
CGPoint macfx::virtualMappedWarpPoint(CGPoint point){
    std::lock_guard<std::mutex> guard(inputMutex());
    for(const auto &entry:inputGeometries()){const auto &g=entry.second;NSPoint mapped;
        if(g.active){if(g.counts)g.counts->warps.fetch_add(1,std::memory_order_relaxed);
            if(translatePoint(NSMakePoint(point.x,g.desktopTop-point.y),g.source,g.output,mapped))return CGPointMake(mapped.x,g.desktopTop-mapped.y);}}return point;
}
NSEvent *macfx::virtualMappedEvent(NSView *view,NSEvent *event){
    MacFXVirtualSession *owner=session(view);if(!owner||owner.stopped||!mouseType(event.type)||event.window!=owner.output)return nil;
    const NSEventType type=event.type;
    const bool down=type==NSEventTypeLeftMouseDown||type==NSEventTypeRightMouseDown||type==NSEventTypeOtherMouseDown;
    const bool up=type==NSEventTypeLeftMouseUp||type==NSEventTypeRightMouseUp||type==NSEventTypeOtherMouseUp;
    const bool drag=type==NSEventTypeLeftMouseDragged||type==NSEventTypeRightMouseDragged||type==NSEventTypeOtherMouseDragged;
    const NSInteger button=down||up||drag?event.buttonNumber:0;
    // Only a successfully mapped press owns its continuation. A fresh native
    // chrome press supersedes any abandoned receipt for that same button.
    if(down)owner->pressedButtons.erase(button);
    const bool continuing=(up||drag)&&owner->pressedButtons.count(button);
    if((up||drag)&&!continuing)return event;
    const NSPoint content=[owner.host convertPoint:event.locationInWindow fromView:nil];
    // AppKit owns title-bar controls and the native resize border. Letterbox
    // presses remain excluded; an owned drag/release retains its game target.
    if(!continuing&&!NSPointInRect(content,owner.host.bounds))return event;
    if(!continuing&&(owner.output.styleMask&NSWindowStyleMaskResizable)&&!(owner.output.styleMask&NSWindowStyleMaskFullScreen)){
        const NSRect inner=NSInsetRect(owner.host.bounds,5,5);if(!NSPointInRect(content,inner))return event;
    }
    NSPoint location=event.locationInWindow;
    if(continuing){
        [owner refresh];if(owner.stopped)return nil;
        const NSRect bounds=owner.image.bounds;
        NSPoint local=[owner.image convertPoint:location fromView:nil];
        // Stay inside AppKit's half-open image bounds after screen conversion.
        // This affects only coordinates of an already-owned button gesture.
        local.x=std::clamp(local.x,NSMinX(bounds),NSMaxX(bounds)-std::min(.001,bounds.size.width*.5));
        local.y=std::clamp(local.y,NSMinY(bounds),NSMaxY(bounds)-std::min(.001,bounds.size.height*.5));
        location=[owner.image convertPoint:local toView:nil];
    }
    NSPoint screen=[owner.output convertPointToScreen:location],mapped;
    if(![owner map:screen fromOutput:YES result:&mapped]||!event.CGEvent)return nil;
    CGEventRef quartz=CGEventCreateCopy(event.CGEvent);if(!quartz)return nil;
    const double desktopTop=NSScreen.screens.firstObject.frame.origin.y+NSScreen.screens.firstObject.frame.size.height;
    CGEventSetLocation(quartz,CGPointMake(mapped.x,desktopTop-mapped.y));
    CGEventSetIntegerValueField(quartz,kCGMouseEventWindowUnderMousePointer,owner.sourceWindow.windowNumber);
    CGEventSetIntegerValueField(quartz,kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent,owner.sourceWindow.windowNumber);
    NSEvent *copy=[NSEvent eventWithCGEvent:quartz];if(!copy){CFRelease(quartz);return nil;}
    MacFXVirtualEventData *data=[MacFXVirtualEventData new];data.window=owner.sourceWindow;
    data.point=[owner.sourceWindow convertPointFromScreen:mapped];data->quartz=quartz;
    Class mappedClass=mappedEventClass(object_getClass(copy));if(!mappedClass)return nil;
    objc_setAssociatedObject(copy,&eventKey,data,OBJC_ASSOCIATION_RETAIN_NONATOMIC);object_setClass(copy,mappedClass);
    if(down)owner->pressedButtons.insert(button);else if(up)owner->pressedButtons.erase(button);
    return copy;
}
extern "C" CGError macfxVirtualWarpMouseCursorPosition(CGPoint point){
    return CGWarpMouseCursorPosition(macfx::virtualMappedWarpPoint(point));
}
__attribute__((used)) static const struct{const void *replacement;const void *original;} virtualInterpose[]
__attribute__((section("__DATA,__interpose")))={
    {reinterpret_cast<const void*>(macfxVirtualWarpMouseCursorPosition),reinterpret_cast<const void*>(CGWarpMouseCursorPosition)}};
