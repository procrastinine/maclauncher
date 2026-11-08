// Window capture owns ScreenCaptureKit, source geometry and IOSurface leases.
// The independent chain processes own all graphics processing and overlays.
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <IOSurface/IOSurface.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#include "graphics-capture-service.hpp"
#include "graphics-window-catalog.hpp"
#include "window-capture-client.hpp"
#include "window-capture-wire.hpp"
#include "capture-frame-geometry.hpp"
#include "window-overlay-policy.hpp"
#include <algorithm>
#include <atomic>
#include <climits>
#include <cmath>
#include <csignal>
#include <fcntl.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <map>
#include <memory>
#include <mutex>
#include <servers/bootstrap.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

using namespace macfx::wcap;
namespace macfx::wcap {
size_t captureScreen(const CGRect &target,const std::vector<CGRect> &screens,size_t fallback){
    size_t chosen=std::min(fallback,screens.empty()?size_t(0):screens.size()-1);double largest=0;
    for(size_t i=0;i<screens.size();++i){const auto r=CGRectIntersection(target,screens[i]);
        const double area=CGRectIsNull(r)?0:r.size.width*r.size.height;if(area>largest){largest=area;chosen=i;}}
    return chosen;
}
}
namespace {
double now(){return NSProcessInfo.processInfo.systemUptime;}
bool alive(pid_t pid){return pid>0&&(kill(pid,0)==0||errno==EPERM);}
uint64_t birth(pid_t pid){proc_bsdinfo info{};return proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))==sizeof(info)?
    uint64_t(info.pbi_start_tvsec)*1000000+info.pbi_start_tvusec:0;}
NSString *const ScreenRecordingReason=@"needs the Screen & System Audio Recording permission in System Settings > Privacy & Security";
NSString *const LostReason=@"Window capture stopped unexpectedly";
constexpr double FailureGrace=5,StopWait=1.5;
NSDictionary *json(const Message &message){
    if(!message.json.address||!message.json.size)return @{};
    id value=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:message.json.address length:message.json.size] options:0 error:nil];
    return [value isKindOfClass:NSDictionary.class]?value:nil;
}
bool transient(NSError *error){return [error.domain isEqual:SCStreamErrorDomain]&&
    (error.code==SCStreamErrorAttemptToConfigState||error.code==SCStreamErrorInvalidParameter||
     error.code==SCStreamErrorFailedApplicationConnectionInterrupted||error.code==SCStreamErrorInternalError);}
CGRect bounds(NSDictionary *info){CGRect rect=CGRectZero;id value=info[(__bridge NSString*)kCGWindowBounds];
    if([value isKindOfClass:NSDictionary.class])CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)value,&rect);return rect;}
struct Geometry {
    bool exists=false,onScreen=false;pid_t pid=0;int layer=0;CGRect rect=CGRectZero,screen=CGRectZero;
    double scale=1;uint32_t display=0,width=0,height=0;uint64_t generation=0;
};
bool same(const Geometry &a,const Geometry &b){return a.exists==b.exists&&a.onScreen==b.onScreen&&a.pid==b.pid&&a.layer==b.layer&&
    CGRectEqualToRect(a.rect,b.rect)&&CGRectEqualToRect(a.screen,b.screen)&&a.scale==b.scale&&a.display==b.display&&a.width==b.width&&a.height==b.height;}
// Equal except for the position, on the same display.
bool sameExtent(const Geometry &a,const Geometry &b){return a.exists==b.exists&&a.onScreen==b.onScreen&&a.pid==b.pid&&a.layer==b.layer&&
    CGSizeEqualToSize(a.rect.size,b.rect.size)&&a.scale==b.scale&&a.display==b.display&&a.width==b.width&&a.height==b.height;}
Geometry windowTarget(uint32_t window){
    Geometry g;const void *id=reinterpret_cast<const void*>(uintptr_t(window));CFArrayRef ids=CFArrayCreate(nullptr,&id,1,nullptr);
    NSArray *list=ids?CFBridgingRelease(CGWindowListCreateDescriptionFromArray(ids)):nil;if(ids)CFRelease(ids);
    for(NSDictionary *info in list)if([info[(__bridge NSString*)kCGWindowNumber] unsignedIntValue]==window){
        g.exists=true;g.onScreen=[info[(__bridge NSString*)kCGWindowIsOnscreen] boolValue];g.rect=bounds(info);
        g.pid=[info[(__bridge NSString*)kCGWindowOwnerPID] intValue];g.layer=[info[(__bridge NSString*)kCGWindowLayer] intValue];break;}
    return g;
}
Geometry displayTarget(uint32_t display){Geometry g;if(CGDisplayIsActive(display)){g.exists=true;g.onScreen=!CGDisplayIsAsleep(display);g.rect=CGDisplayBounds(display);}return g;}
void screenFor(Geometry &g,uint32_t display,double captureScale){
    NSArray<NSScreen*> *screens=NSScreen.screens;std::vector<CGRect> rectangles;size_t fallback=0;
    for(NSScreen *screen in screens){const auto id=[screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
        rectangles.push_back(CGDisplayBounds(id));if(display?display==id:screen==NSScreen.mainScreen)fallback=rectangles.size()-1;}
    if(screens.count){NSScreen *screen=screens[display?fallback:captureScreen(g.rect,rectangles,fallback)];
        g.display=[screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];g.scale=screen.backingScaleFactor;g.screen=CGDisplayBounds(g.display);}
    g.width=macfx::windowPixelExtent(g.rect.size.width,g.scale*captureScale);g.height=macfx::windowPixelExtent(g.rect.size.height,g.scale*captureScale);
}
uint32_t mainWindow(pid_t pid){
    NSArray *list=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));
    for(NSDictionary *info in list)if([info[(__bridge NSString*)kCGWindowOwnerPID] intValue]==pid&&[info[(__bridge NSString*)kCGWindowLayer] intValue]==0){
        auto r=bounds(info);if(r.size.width>=64&&r.size.height>=64)return [info[(__bridge NSString*)kCGWindowNumber] unsignedIntValue];}return 0;
}
bool ownPalette(uint32_t window,const Geometry &g){
    NSArray *list=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenAboveWindow,window));
    for(NSDictionary *info in list){if([info[(__bridge NSString*)kCGWindowOwnerPID] intValue]!=g.pid||
        [info[(__bridge NSString*)kCGWindowLayer] intValue]<=g.layer||[info[(__bridge NSString*)kCGWindowAlpha] doubleValue]<=.01)continue;
        auto r=CGRectIntersection(bounds(info),g.rect);if(!CGRectIsNull(r)&&r.size.width>=1&&r.size.height>=1)return true;}return false;
}
NSMutableDictionary *geometryEvent(const Geometry &g){return [@{@"event":@"geometry",@"generation":@(g.generation),@"exists":@(g.exists),@"onScreen":@(g.onScreen),
    @"pid":@(g.pid),@"layer":@(g.layer),@"x":@(g.rect.origin.x),@"y":@(g.rect.origin.y),@"width":@(g.rect.size.width),@"height":@(g.rect.size.height),
    @"scale":@(g.scale),@"displayID":@(g.display),@"pixelsWidth":@(g.width),@"pixelsHeight":@(g.height)} mutableCopy];}
NSMutableDictionary *windowEvent(SCWindow *window){
    NSMutableDictionary *event=[@{@"event":@"selected",@"windowID":@(window.windowID)} mutableCopy];SCRunningApplication *app=window.owningApplication;
    if(app){event[@"pid"]=@(app.processID);if(app.bundleIdentifier.length)event[@"bundleIdentifier"]=app.bundleIdentifier;if(app.applicationName.length)event[@"name"]=app.applicationName;
        char path[PROC_PIDPATHINFO_MAXSIZE]{};if(proc_pidpath(app.processID,path,sizeof(path))>0)event[@"executable"]=[NSString stringWithUTF8String:path];}return event;
}
struct CaptureFeed;
struct ServicePeer {
    pid_t process=0;mach_port_t port=MACH_PORT_NULL;NSArray<NSNumber*> *overlays=@[];
    ~ServicePeer(){if(port)mach_port_deallocate(mach_task_self(),port);}
};
using Peer=std::shared_ptr<ServicePeer>;
using Feed=std::shared_ptr<CaptureFeed>;
struct ServiceState {
    std::map<pid_t,Peer>clients;std::map<std::pair<pid_t,uint32_t>,Feed>feeds;std::mutex mutex;
    std::thread receiver;std::atomic<bool>receiving{false};std::atomic<unsigned>stops{0};
    mach_port_t port=MACH_PORT_NULL;int lock=-1;NSString *name=nil,*path=nil;pid_t launcher=0;uint64_t launcherBirth=0;
    bool running=false,stopping=false,suspended=false;double emptyAt=0;pid_t catalog=0;unsigned requests=0;
    uint64_t overlayRevision=0;NSArray<NSNumber*> *overlays=@[];
};
}
@interface MacFXCaptureReceiver : NSObject<SCStreamOutput,SCStreamDelegate> {@public std::weak_ptr<CaptureFeed>owner;}
@end
@interface MacFXCaptureService () <SCContentSharingPickerObserver>
- (BOOL)admit:(pid_t)process claimed:(pid_t)claimed;
- (void)received:(std::shared_ptr<Received>)incoming;
- (Feed)feed:(uint32_t)number process:(pid_t)process;
- (void)deadPeer:(mach_port_t)port;
- (void)removePeer:(pid_t)pid;
- (BOOL)contains:(Feed)feed;
- (BOOL)duplicate:(Feed)feed window:(uint32_t)window display:(uint32_t)display;
- (void)open:(NSDictionary*)request peer:(Peer)peer;
- (void)select:(Feed)feed filter:(SCContentFilter*)filter window:(SCWindow*)window event:(NSDictionary*)event;
- (void)pollFeed:(Feed)feed;
- (void)heartbeat;
- (void)applicationQuit:(pid_t)pid;
- (void)suspend:(BOOL)value;
- (void)suspension:(NSString*)reason active:(BOOL)active;
- (void)screenLockChanged:(NSNotification*)notification;
- (void)overlaysChanged;
- (void)acknowledgeExclusions:(uint64_t)revision;
- (void)captureFailed:(Feed)feed error:(NSError*)error;
- (void)captureRecovered:(Feed)feed;
- (void)closeFeed:(Feed)feed reason:(NSString*)reason failed:(BOOL)failed;
- (void)poll;
- (void)resolve:(Feed)feed;
- (void)presentNextPicker;
- (void)refreshExclusions:(uint64_t)revision deadline:(double)deadline;
@end
namespace {
struct CaptureFeed:std::enable_shared_from_this<CaptureFeed> {
    __weak MacFXCaptureService *owner=nil;Peer peer;uint32_t id=0,window=0,display=0;pid_t pid=0;
    bool selected=false,selecting=false,waiting=false,offered=false,direct=false,filterRequest=false;std::atomic<bool>palettes{false};uint32_t paletteDisplay=0;
    double deadline=0,failedSince=0,lastInterrupted=0,captureScale=1,requestedCropX=0,requestedCropY=0;Geometry metadata;
    SCContentFilter *filter=nil,*requestedFilter=nil;SCStream *stream=nil;MacFXCaptureReceiver *receiver=nil;
    dispatch_queue_t intake=dispatch_queue_create("org.maclauncher.capture-feed",DISPATCH_QUEUE_SERIAL);
    std::atomic<bool>ended{false},configuring{false};bool paused=false,suspended=false,starting=false,stopRequested=false,operation=false;
    bool cursor=false,appliedCursor=false;double interval=0,lastSent=0,configurationStarted=0,unusableSince=0,cropX=0,cropY=0;
    Geometry desired,applied;uint64_t revision=0,appliedRevision=0,sequence=mach_absolute_time();unsigned attempts=0,starts=0,stopCount=0,dropped=0,retainedPeak=0;
    struct Sample {CMSampleBufferRef value=nullptr;FrameInfo info;Sample(CMSampleBufferRef s,const FrameInfo &f):value(s),info(f){CFRetain(value);}~Sample(){CFRelease(value);}};
    macfx::CaptureFrameLeases<Sample>frames;std::shared_ptr<ServiceState>state;
    struct Waiter {uint64_t revision;void (^done)(bool);};std::vector<Waiter>waiters;
    void event(NSDictionary *value){NSMutableDictionary *event=[value mutableCopy];event[@"feed"]=@(id);send(peer->port,Event,id,{},MACH_PORT_NULL,event);}
    void capture(NSString *status,NSString *reason=nil){NSMutableDictionary *event=[@{@"event":@"capture",@"state":status,@"source":palettes?@"application-windows":@"window"} mutableCopy];if(reason.length)event[@"reason"]=reason;this->event(event);
        if([status isEqualToString:@"running"]){auto self=shared_from_this();dispatch_async(dispatch_get_main_queue(),^{[self->owner captureRecovered:self];});}}
    SCStreamConfiguration *configuration(){
        auto config=[SCStreamConfiguration new];config.width=desired.width;config.height=desired.height;
        // Two sent leases and one coalesced sample leave a producer slot free.
        config.queueDepth=4;
        config.minimumFrameInterval=kCMTimeZero;config.pixelFormat=kCVPixelFormatType_32BGRA;config.showsCursor=cursor;config.capturesAudio=NO;
        config.colorSpaceName=kCGColorSpaceSRGB;config.scalesToFit=YES;
        const auto origin=(display||palettes)?CGPointMake(desired.rect.origin.x-desired.screen.origin.x,desired.rect.origin.y-desired.screen.origin.y):CGPointMake(cropX,cropY);
        config.sourceRect=CGRectMake(origin.x,origin.y,desired.rect.size.width,desired.rect.size.height);
        config.destinationRect=CGRectMake(0,0,desired.width,desired.height);
        if(@available(macOS 14.0,*)){config.preservesAspectRatio=YES;config.captureResolution=SCCaptureResolutionBest;config.ignoreShadowsSingleWindow=YES;}
        if(@available(macOS 14.2,*))config.includeChildWindows=YES;
        return config;
    }
    void fail(NSError *error){auto self=shared_from_this();dispatch_async(dispatch_get_main_queue(),^{[self->owner captureFailed:self error:error];});}
    void completed(bool okay){ // intake queue
        std::vector<Waiter>remaining;for(auto&waiter:waiters){if(!okay||waiter.revision<=appliedRevision){if(waiter.done)waiter.done(okay);}else remaining.push_back(waiter);}waiters=std::move(remaining);
    }
    void beginConfiguration(){
        if(configurationStarted)return;configurationStarted=now();const auto epoch=configurationStarted;auto self=shared_from_this();
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC),intake,^{if(!self->ended&&self->configuring&&self->configurationStarted==epoch){
            self->completed(false);self->fail([NSError errorWithDomain:SCStreamErrorDomain code:SCStreamErrorInternalError userInfo:@{NSLocalizedDescriptionKey:@"Capture configuration did not settle"}]);}});
    }
    void settleIdle(){ // No stream can contain an old exclusion filter.
        if(stream||stopRequested||starting||operation)return;
        if(requestedFilter){filter=requestedFilter;requestedFilter=nil;}
        applied=desired;appliedRevision=revision;appliedCursor=cursor;configurationStarted=0;configuring=false;
        event(geometryEvent(applied));completed(true);
    }
    void start(){ // intake queue
        if(ended)return;
        if(paused||suspended){settleIdle();return;}
        if(stream||stopRequested||!desired.width||!desired.height)return;
        if(requestedFilter){filter=requestedFilter;requestedFilter=nil;}if(!filter)return;
        const auto startedGeometry=desired;const auto startedRevision=revision;const bool startedCursor=cursor;
        receiver=[MacFXCaptureReceiver new];receiver->owner=shared_from_this();stream=[[SCStream alloc]initWithFilter:filter configuration:configuration() delegate:receiver];
        NSError *error=nil;if(![stream addStreamOutput:receiver type:SCStreamOutputTypeScreen sampleHandlerQueue:intake error:&error]){fail(error);stream=nil;receiver=nil;return;}
        starting=true;configuring=true;beginConfiguration();++starts;capture(@"starting");auto self=shared_from_this();
        [stream startCaptureWithCompletionHandler:^(NSError *error){dispatch_async(self->intake,^{
            self->starting=false;if(self->stopRequested){self->stopNow();return;}if(error){self->fail(error);return;}
            // desired keeps this revision's capture and any later move.
            self->applied=self->revision==startedRevision?self->desired:startedGeometry;self->appliedRevision=startedRevision;self->appliedCursor=startedCursor;
            if(self->revision==startedRevision){self->event(geometryEvent(self->applied));self->configuring=false;self->configurationStarted=0;self->capture(@"running");self->completed(true);}
            // Updates received while start was in flight are coalesced too.
            self->configureLatest();
        });}];
    }
    void update(Geometry g,SCContentFilter *nextFilter=nil,void (^done)(bool)=nil){ // main queue
        configuring=true;auto self=shared_from_this();dispatch_async(intake,^{
            if(self->ended){if(done)done(false);return;}self->desired=g;if(nextFilter)self->requestedFilter=nextFilter;
            ++self->revision;self->attempts=0;self->beginConfiguration();
            self->frames.clearPending();if(done)self->waiters.push_back({self->revision,[done copy]});
            if(!self->stream)self->start();else self->configureLatest();
        });
    }
    // A window's filter and crop follow the window, so a move keeps the
    // configuration and generation; only its position reaches the chain.
    void moved(const Geometry &g){ // main queue
        auto self=shared_from_this();dispatch_async(intake,^{
            if(self->ended)return;
            for(Geometry *value:{&self->desired,&self->applied}){value->rect.origin=g.rect.origin;value->screen=g.screen;}
            // A configuration in flight reports the new position when it completes.
            if(self->revision==self->appliedRevision&&!self->starting)self->event(geometryEvent(self->applied));
        });
    }
    void configureLatest(){ // intake queue, one SCK transaction at a time
        if(ended||operation||starting||stopRequested||!stream||revision==appliedRevision)return;
        if(configurationStarted&&now()-configurationStarted>=2){completed(false);fail([NSError errorWithDomain:SCStreamErrorDomain code:SCStreamErrorInternalError userInfo:@{NSLocalizedDescriptionKey:@"Capture configuration did not settle"}]);return;}
        operation=true;configuring=true;const auto version=revision;const auto g=desired;const bool appliedCursorValue=cursor;SCContentFilter *next=requestedFilter;
        SCStreamConfiguration *config=configuration();auto self=shared_from_this();
        void (^completed)(NSError*)=^(NSError *error){dispatch_async(self->intake,^{
            self->operation=false;if(self->stopRequested){self->stopNow();return;}if(self->ended)return;
            if(version!=self->revision){self->attempts=0;self->configureLatest();return;}
            if(error){if(transient(error)&&++self->attempts<=2){dispatch_after(dispatch_time(DISPATCH_TIME_NOW,150*NSEC_PER_MSEC),self->intake,^{self->configureLatest();});return;}self->completed(false);self->fail(error);return;}
            self->applied=self->desired;self->appliedRevision=version;self->appliedCursor=appliedCursorValue;self->configurationStarted=0;self->unusableSince=0;
            // FIFO on one feed's intake queue puts geometry before its frames.
            self->event(geometryEvent(self->applied));self->configuring=false;self->capture(@"running");self->completed(true);
        });};
        if(next){[stream updateContentFilter:next completionHandler:^(NSError *error){
            dispatch_async(self->intake,^{if(error){completed(error);return;}self->filter=next;
                if(self->requestedFilter==next)self->requestedFilter=nil;
                [self->stream updateConfiguration:config completionHandler:completed];});}];}
        else [stream updateConfiguration:config completionHandler:completed];
    }
    void applyOptions(NSDictionary *options){ // main queue
        if([options[@"captureScale"] isKindOfClass:NSNumber.class]){const double value=[options[@"captureScale"] doubleValue];if(std::isfinite(value)&&value>0&&value<=1)captureScale=value;}
        // A new crop keeps the extent but moves the image, so its frames
        // carry a new generation; the chain keeps its last image until one.
        uint64_t cropGeneration=0;
        if([options[@"cropX"] isKindOfClass:NSNumber.class]&&[options[@"cropY"] isKindOfClass:NSNumber.class]){
            const double x=[options[@"cropX"] doubleValue],y=[options[@"cropY"] doubleValue];
            if(std::isfinite(x)&&std::isfinite(y)&&x>=0&&y>=0&&x<=16384&&y<=16384&&(requestedCropX!=x||requestedCropY!=y)){
                requestedCropX=x;requestedCropY=y;cropGeneration=++metadata.generation;}
        }
        const double x=requestedCropX,y=requestedCropY;
        auto self=shared_from_this();dispatch_async(intake,^{
            if(self->ended)return;bool changed=false;
            if(cropGeneration){self->cropX=x;self->cropY=y;self->desired.generation=cropGeneration;changed=true;}
            if([options[@"cursor"] isKindOfClass:NSNumber.class]&&self->cursor!=[options[@"cursor"] boolValue]){self->cursor=[options[@"cursor"] boolValue];changed=true;}
            if([options[@"interval"] isKindOfClass:NSNumber.class]){const auto v=[options[@"interval"] doubleValue];if(std::isfinite(v)&&v>=0&&v<=1)self->interval=v;}
            if([options[@"paused"] isKindOfClass:NSNumber.class])self->paused=[options[@"paused"] boolValue];
            if(self->paused||self->suspended){self->capture(self->suspended?@"suspended":@"paused");self->stop(false);return;}
            if(changed){self->configuring=true;++self->revision;self->attempts=0;self->beginConfiguration();self->frames.clearPending();self->configureLatest();}
            self->start();
        });
    }
    void stop(bool final){ // intake queue
        if(final){ended=true;completed(false);}frames.clearPending();if(stopRequested)return;
        // A client may still be copying the leased IOSurface. Keep the pool
        // sample until capture has stopped, even after the feed is removed
        // and its late Release can no longer find it in the service map.
        if(!stream){if(!starting&&!operation)frames.clear();return;}
        stopRequested=true;++state->stops;stopNow();
    }
    void stopNow(){ // intake queue; receiver and stream retained through completion
        if(!stopRequested||starting||operation||!stream)return;
        SCStream *capture=stream;MacFXCaptureReceiver *output=receiver;stream=nil;receiver=nil;
        auto self=shared_from_this();++stopCount;
        [capture stopCaptureWithCompletionHandler:^(NSError*){(void)capture;(void)output;dispatch_async(self->intake,^{
            self->frames.clear();--self->state->stops;self->stopRequested=false;self->configurationStarted=0;if(!self->ended)self->start();
        });}];
    }
    void streamFailed(SCStream *capture,NSError *error){auto self=shared_from_this();dispatch_async(intake,^{
        if(!self->ended&&!self->paused&&!self->suspended&&!self->stopRequested&&self->stream==capture)self->fail(error);
    });}
    void release(uint64_t number){
        if(!frames.release(number))return;auto next=frames.takePending();
        if(next&&!ended&&!configuring&&!paused&&!suspended&&next->info.generation==applied.generation)forward(std::move(next));
    }
    void forward(std::shared_ptr<Sample>sample){
        CVPixelBufferRef pixels=CMSampleBufferGetImageBuffer(sample->value);IOSurfaceRef surface=pixels?CVPixelBufferGetIOSurface(pixels):nullptr;
        mach_port_t port=surface?IOSurfaceCreateMachPort(surface):MACH_PORT_NULL;if(!port){++dropped;return;}
        const auto frame=sample->info;
        if(!frames.retain(std::move(sample))){mach_port_deallocate(mach_task_self(),port);++dropped;return;}
        lastSent=frame.time;
        if(!send(peer->port,Frame,id,frame,port)){frames.release(frame.sequence);++dropped;}
        retainedPeak=std::max(retainedPeak,frames.size());
    }
    void receive(CMSampleBufferRef sample){ // SCK intake queue
        if(ended||configuring||paused||suspended||!CMSampleBufferIsValid(sample))return;
        CFArrayRef attachments=CMSampleBufferGetSampleAttachmentsArray(sample,false);if(!attachments||CFArrayGetCount(attachments)<1)return;
        NSDictionary *info=(__bridge NSDictionary*)CFArrayGetValueAtIndex(attachments,0);
        if(!info[SCStreamFrameInfoStatus]||[info[SCStreamFrameInfoStatus] integerValue]!=SCFrameStatusComplete)return;
        CVPixelBufferRef pixels=CMSampleBufferGetImageBuffer(sample);
        const unsigned w=pixels?unsigned(CVPixelBufferGetWidth(pixels)):0,h=pixels?unsigned(CVPixelBufferGetHeight(pixels)):0;
        const auto content=macfx::captureFrameGeometry(info,w,h);
        if(!pixels||!content.valid||CVPixelBufferGetPixelFormatType(pixels)!=kCVPixelFormatType_32BGRA){
            ++dropped;if(!unusableSince){unusableSince=now();const auto epoch=unusableSince;auto self=shared_from_this();
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),intake,^{if(!self->ended&&!self->configuring&&self->unusableSince==epoch)
                    self->fail([NSError errorWithDomain:SCStreamErrorDomain code:SCStreamErrorInternalError userInfo:@{NSLocalizedDescriptionKey:@"Capture images have invalid content geometry"}]);});}return;}
        unusableSince=0;double time=0;NSNumber *displayTime=info[SCStreamFrameInfoDisplayTime];
        if(displayTime.unsignedLongLongValue)time=CMTimeGetSeconds(CMClockMakeHostTimeFromSystemUnits(displayTime.unsignedLongLongValue));
        else {CMTime pts=CMSampleBufferGetPresentationTimeStamp(sample);if(stream.synchronizationClock)pts=CMSyncConvertTime(pts,stream.synchronizationClock,CMClockGetHostTimeClock());time=CMTimeGetSeconds(pts);}
        if(!std::isfinite(time)||!macfx::windowCaptureIntervalAccepted(time,lastSent,interval)){++dropped;return;}
        if(NSDictionary *rect=info[SCStreamFrameInfoScreenRect]){CGRect r=CGRectZero;
            if([rect isKindOfClass:NSDictionary.class]&&CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)rect,&r)&&!CGRectEqualToRect(r,applied.rect)){
                auto self=shared_from_this();dispatch_async(dispatch_get_main_queue(),^{[self->owner poll];});}}
        FrameInfo frame{++sequence,applied.generation,time,w,h,content.cropX,content.cropY,content.width,content.height,content.contentScale,content.scaleFactor};
        auto value=std::make_shared<Sample>(sample,frame);
        if(frames.full()){if(frames.coalesce(std::move(value)))++dropped;retainedPeak=std::max(retainedPeak,frames.size());}
        else forward(std::move(value));
    }
};
}
@implementation MacFXCaptureReceiver
- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {if(type==SCStreamOutputTypeScreen)if(auto feed=owner.lock())feed->receive(sample);}
- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {if(auto feed=owner.lock())feed->streamFailed(stream,error);}
@end

@implementation MacFXCaptureService {
    std::shared_ptr<ServiceState> _state;NSString *_identifier;BOOL (^_admission)(pid_t,pid_t);
    NSTimer *_poll,*_heartbeat;NSMutableArray *_signals,*_observers;NSMutableSet<NSString*> *_suspensions;Feed _picker;
}
- (instancetype)initWithId:(NSString*)identifier admission:(BOOL (^)(pid_t,pid_t))admission {
    if((self=[super init])){_state=std::make_shared<ServiceState>();_identifier=[identifier copy];_admission=[admission copy];
        _state->launcher=getppid();NSString*prefix=@"org.maclauncher.window-capture.";
        if([identifier hasPrefix:prefix]){NSString*suffix=[identifier substringFromIndex:prefix.length];NSScanner*scanner=[NSScanner scannerWithString:suffix];long long process=0;
            if([scanner scanLongLong:&process]&&scanner.isAtEnd&&process>0&&process<=INT_MAX)_state->launcher=pid_t(process);}
        _state->launcherBirth=birth(_state->launcher);_signals=[NSMutableArray array];_observers=[NSMutableArray array];_suspensions=[NSMutableSet set];}return self;
}
- (BOOL)running{return _state->running;}
- (unsigned)pendingStops{return _state->stops.load();}
- (size_t)clientCount{return _state->clients.size();}
- (BOOL)captureAvailable{return CGPreflightScreenCaptureAccess();}
- (void)requestContent:(void (^)(SCShareableContent*,NSError*))completion {
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:completion];
}
- (BOOL)admit:(pid_t)process claimed:(pid_t)claimed {
    if(process<=0||process!=claimed)return NO;if(_admission)return _admission(process,claimed);
    char path[PROC_PIDPATHINFO_MAXSIZE]{};proc_bsdinfo info{};
    return proc_pidpath(process,path,sizeof(path))>0&&[executablePath() isEqualToString:[NSString stringWithUTF8String:path]]&&
        proc_pidinfo(process,PROC_PIDTBSDINFO,0,&info,sizeof(info))==sizeof(info)&&info.pbi_ppid==_state->launcher;
}
- (BOOL)start:(NSError *__autoreleasing *)error {
    auto state=_state;if(state->running)return YES;state->path=rendezvousPath(_identifier);
    if(!state->path.length){if(error)*error=[NSError errorWithDomain:NSPOSIXErrorDomain code:EINVAL userInfo:nil];return NO;}
    state->lock=open(state->path.fileSystemRepresentation,O_CREAT|O_RDWR|O_CLOEXEC|O_NOFOLLOW,0600);
    if(state->lock<0){if(error)*error=[NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];return NO;}
    const auto deadline=now()+5;
    while(flock(state->lock,LOCK_EX|LOCK_NB)){
        char bytes[4096]{};ssize_t size=pread(state->lock,bytes,sizeof(bytes)-1,0);
        NSDictionary *record=size>0?[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:bytes length:size] options:0 error:nil]:nil;
        NSString *name=[record isKindOfClass:NSDictionary.class]?record[@"name"]:nil;mach_port_t existing=MACH_PORT_NULL;
        if([name isKindOfClass:NSString.class]&&bootstrap_look_up(bootstrap_port,name.UTF8String,&existing)==KERN_SUCCESS){mach_port_deallocate(mach_task_self(),existing);close(state->lock);state->lock=-1;return YES;}
        if(now()>=deadline){if(error)*error=[NSError errorWithDomain:NSPOSIXErrorDomain code:ETIMEDOUT userInfo:nil];close(state->lock);state->lock=-1;return NO;}
        usleep(20000);
    }
    state->port=receiver();state->name=[NSString stringWithFormat:@"%@.%@",_identifier,NSUUID.UUID.UUIDString];
    if(!state->port||bootstrap_register(bootstrap_port,const_cast<char*>(state->name.UTF8String),state->port)!=KERN_SUCCESS){
        if(error)*error=[NSError errorWithDomain:NSPOSIXErrorDomain code:EIO userInfo:nil];[self stop];return NO;}
    NSData *record=[NSJSONSerialization dataWithJSONObject:@{@"name":state->name,@"pid":@(getpid())} options:0 error:nil];
    if(ftruncate(state->lock,0)||pwrite(state->lock,record.bytes,record.length,0)!=ssize_t(record.length)){
        if(error)*error=[NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];[self stop];return NO;}
    state->running=true;state->receiving=true;state->emptyAt=now();__weak MacFXCaptureService *weak=self;
    state->receiver=std::thread([state,weak]{while(state->receiving){@autoreleasepool{
        auto incoming=std::make_shared<Received>();const auto status=receive(state->port,100,*incoming);
        if(status==MACH_RCV_TIMED_OUT)continue;if(status!=KERN_SUCCESS)continue;
        if(incoming->deadName){const auto port=incoming->deadPort;dispatch_async(dispatch_get_main_queue(),^{[weak deadPeer:port];});continue;}
        if(incoming->message.command==Release){if(incoming->message.process!=incoming->auditProcess)continue;Feed feed;{std::lock_guard<std::mutex> lock(state->mutex);
            auto found=state->feeds.find({incoming->auditProcess,incoming->message.feed});if(found!=state->feeds.end())feed=found->second;}
            if(feed){const auto sequence=incoming->message.frame.sequence;dispatch_async(feed->intake,^{feed->release(sequence);});}continue;}
        dispatch_async(dispatch_get_main_queue(),^{[weak received:incoming];});
    }}});
    _poll=[NSTimer scheduledTimerWithTimeInterval:.1 repeats:YES block:^(NSTimer*){[weak poll];}];
    _heartbeat=[NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer*){[weak heartbeat];}];
    for(int number:{SIGTERM,SIGINT,SIGHUP}){signal(number,SIG_IGN);auto source=dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,number,0,dispatch_get_main_queue());
        dispatch_source_set_event_handler(source,^{[weak stop];});dispatch_resume(source);[_signals addObject:source];}
    NSNotificationCenter *center=NSWorkspace.sharedWorkspace.notificationCenter;
    [_observers addObject:[center addObserverForName:NSWorkspaceDidTerminateApplicationNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note){
        NSRunningApplication *app=note.userInfo[NSWorkspaceApplicationKey];[weak applicationQuit:app.processIdentifier];}]];
    NSDictionary<NSNotificationName,NSString*> *sleepReasons=@{NSWorkspaceWillSleepNotification:@"sleep",NSWorkspaceScreensDidSleepNotification:@"display-sleep",NSWorkspaceSessionDidResignActiveNotification:@"inactive-session"};
    NSDictionary<NSNotificationName,NSString*> *wakeReasons=@{NSWorkspaceDidWakeNotification:@"sleep",NSWorkspaceScreensDidWakeNotification:@"display-sleep",NSWorkspaceSessionDidBecomeActiveNotification:@"inactive-session"};
    for(NSNotificationName name in sleepReasons){NSString *reason=sleepReasons[name];
        [_observers addObject:[center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification*){[weak suspension:reason active:YES];}]];}
    for(NSNotificationName name in wakeReasons){NSString *reason=wakeReasons[name];
        [_observers addObject:[center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification*){[weak suspension:reason active:NO];}]];}
    for(NSString *name in @[@"com.apple.screenIsLocked",@"com.apple.screenIsUnlocked"])
        [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(screenLockChanged:) name:name object:nil suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
    return YES;
}
- (void)received:(std::shared_ptr<Received>)incoming {
    auto state=_state;if(!state->running||state->stopping)return;auto &message=incoming->message;NSDictionary *value=json(message);if(!value)return;
    if(message.command==Hello){
        if(!message.port.name||![self admit:incoming->auditProcess claimed:message.process]||
            (! [value[@"role"] isEqual:@"chain"]&&! [value[@"role"] isEqual:@"catalog"]))return;
        if(state->clients.count(incoming->auditProcess))[self removePeer:incoming->auditProcess];
        auto peer=std::make_shared<ServicePeer>();peer->process=incoming->auditProcess;peer->port=message.port.name;message.port.name=MACH_PORT_NULL;
        state->clients[peer->process]=peer;state->emptyAt=0;watchDeadName(peer->port,state->port);
        if(!send(peer->port,Welcome,0,{},MACH_PORT_NULL,@{@"service":@(getpid())}))[self removePeer:peer->process];return;
    }
    auto entry=state->clients.find(incoming->auditProcess);if(entry==state->clients.end()||message.process!=incoming->auditProcess)return;
    if(message.command==Goodbye){[self removePeer:entry->first];return;}
    if(message.command!=Control)return;Peer peer=entry->second;
    if([value[@"overlays"] isKindOfClass:NSArray.class]){
        NSMutableArray *ids=[NSMutableArray array];for(id number in value[@"overlays"])if([number isKindOfClass:NSNumber.class]&&[number unsignedIntValue])[ids addObject:number];
        peer->overlays=ids;[self overlaysChanged];
    }
    if([value[@"open"] isKindOfClass:NSDictionary.class])[self open:value[@"open"] peer:peer];
    if([value[@"options"] isKindOfClass:NSDictionary.class]){NSDictionary *options=value[@"options"];auto feed=[self feed:[options[@"feed"] unsignedIntValue] process:peer->process];if(feed)feed->applyOptions(options);}
    if([value[@"close"] isKindOfClass:NSDictionary.class]){auto feed=[self feed:[value[@"close"][@"feed"] unsignedIntValue] process:peer->process];if(feed)[self closeFeed:feed reason:@"Removed by request" failed:NO];}
    if([value[@"catalog"] isKindOfClass:NSDictionary.class]){
        state->catalog=peer->process;rsCatalogServe(value[@"catalog"],^(NSDictionary *event){send(peer->port,Event,0,{},MACH_PORT_NULL,event);});
    }else if([value[@"catalog"] isKindOfClass:NSNumber.class]&&![value[@"catalog"] boolValue]&&state->catalog==peer->process){state->catalog=0;rsCatalogStopServing(nil);}
}
- (Feed)feed:(uint32_t)number process:(pid_t)process {auto it=_state->feeds.find({process,number});return it==_state->feeds.end()?Feed{}:it->second;}
- (void)deadPeer:(mach_port_t)port {for(auto &[pid,peer]:_state->clients)if(peer->port==port){[self removePeer:pid];return;}}
- (void)removePeer:(pid_t)pid {
    auto state=_state;std::vector<Feed>feeds;for(auto &[key,feed]:state->feeds)if(key.first==pid)feeds.push_back(feed);
    for(auto &feed:feeds)[self closeFeed:feed reason:@"The graphics session ended" failed:NO];
    if(state->catalog==pid){state->catalog=0;rsCatalogStopServing(nil);}state->clients.erase(pid);
    if(state->clients.empty())state->emptyAt=now();[self overlaysChanged];
}
- (BOOL)contains:(Feed)feed {return feed&&!feed->ended&&[self feed:feed->id process:feed->peer->process]==feed;}
- (BOOL)duplicate:(Feed)feed window:(uint32_t)window display:(uint32_t)display {
    for(auto &[_,other]:_state->feeds)if(other!=feed&&((window&&other->window==window)||(display&&other->display==display)))return YES;return NO;
}
- (void)open:(NSDictionary*)request peer:(Peer)peer {
    NSString *target=request[@"target"];if(![target isKindOfClass:NSString.class])return;
    uint32_t number=[request[@"feed"] unsignedIntValue];if(!number||[self feed:number process:peer->process])return;
    const bool window=[target isEqual:@"window"],display=[target isEqual:@"display"],application=[target isEqual:@"application"];
    if(!window&&!display&&!application)return;
    auto feed=std::make_shared<CaptureFeed>();feed->owner=self;feed->peer=peer;feed->id=number;feed->state=_state;
    feed->window=window?[request[@"windowID"] unsignedIntValue]:0;feed->display=display?[request[@"displayID"] unsignedIntValue]:0;
    feed->pid=application?[request[@"pid"] intValue]:0;feed->direct=!application;
    {std::lock_guard<std::mutex>lock(_state->mutex);_state->feeds[{peer->process,number}]=feed;}
    if((window&&!feed->window)||(display&&!feed->display)||(application&&feed->pid<=0)){[self closeFeed:feed reason:@"Invalid capture target" failed:YES];return;}
    if([self duplicate:feed window:feed->window display:feed->display]){[self closeFeed:feed reason:display?@"This display already has window graphics":@"This window already has window graphics" failed:YES];return;}
    feed->suspended=_state->suspended;feed->applyOptions(request);
    if(window||display){[self resolve:feed];return;}
    if(!alive(feed->pid)){[self closeFeed:feed reason:@"The application is not running" failed:NO];return;}
    const double wait=[request[@"waitWindow"] doubleValue];
    if(wait>0&&std::isfinite(wait)){feed->waiting=true;feed->deadline=now()+std::min(wait,600.);feed->event(@{@"event":@"waiting-for-window"});return;}
    if([request[@"frontWindow"] boolValue]&&[self captureAvailable]){
        if(uint32_t id=mainWindow(feed->pid)){feed->direct=true;feed->window=id;[self resolve:feed];return;}}
    [self presentNextPicker];
}
- (SCContentFilter*)displayFilter:(SCDisplay*)display content:(SCShareableContent*)content {
    NSMutableArray *excluded=[NSMutableArray array];for(SCWindow *window in content.windows)if([_state->overlays containsObject:@(window.windowID)])[excluded addObject:window];
    auto filter=[[SCContentFilter alloc]initWithDisplay:display excludingWindows:excluded];if(@available(macOS 14.2,*))filter.includeMenuBar=NO;return filter;
}
- (void)resolve:(Feed)feed {
    if(![self contains:feed]||feed->selecting)return;
    if(![self captureAvailable]){[self closeFeed:feed reason:[@"Capturing a window or display " stringByAppendingString:ScreenRecordingReason] failed:YES];return;}
    feed->selecting=true;++_state->requests;__weak MacFXCaptureService *weak=self;
    [self requestContent:^(SCShareableContent *content,NSError *error){dispatch_async(dispatch_get_main_queue(),^{
        MacFXCaptureService *self=weak;if(!self)return;--self->_state->requests;feed->selecting=false;if(![self contains:feed])return;
        if(!content){[self closeFeed:feed reason:error.localizedDescription?:@"The window list is unavailable" failed:YES];return;}
        if(feed->display){for(SCDisplay *display in content.displays)if(display.displayID==feed->display){
            [self select:feed filter:[self displayFilter:display content:content] window:nil event:@{@"event":@"selected",@"displayID":@(display.displayID)}];return;}
            [self closeFeed:feed reason:@"The display is no longer available" failed:NO];return;}
        for(SCWindow *window in content.windows)if(window.windowID==feed->window){
            if([self duplicate:feed window:window.windowID display:0]){[self closeFeed:feed reason:@"This window already has window graphics" failed:YES];return;}
            [self select:feed filter:[[SCContentFilter alloc]initWithDesktopIndependentWindow:window] window:window event:windowEvent(window)];return;}
        [self closeFeed:feed reason:@"The window is no longer available" failed:NO];
    });}];
}
- (void)select:(Feed)feed filter:(SCContentFilter*)filter window:(SCWindow*)window event:(NSDictionary*)event {
    if(![self contains:feed])return;feed->selected=true;feed->waiting=false;feed->failedSince=0;
    if(window){feed->window=window.windowID;feed->pid=window.owningApplication.processID;}
    feed->event(event);Geometry g=feed->display?displayTarget(feed->display):windowTarget(feed->window);screenFor(g,feed->display,feed->captureScale);
    g.generation=feed->metadata.generation+1;feed->metadata=g;feed->update(g,filter);[self pollFeed:feed];
}
- (void)presentNextPicker {
    if(_state->stopping||_picker)return;
    for(auto &[_,feed]:_state->feeds)if(!feed->selected&&!feed->waiting&&!feed->selecting&&!feed->direct){_picker=feed;break;}
    if(!_picker)return;
    auto picker=SCContentSharingPicker.sharedPicker;auto config=[SCContentSharingPickerConfiguration new];
    config.allowedPickerModes=SCContentSharingPickerModeSingleWindow;config.allowsChangingSelectedContent=NO;config.excludedWindowIDs=_state->overlays;
    NSMutableArray *excluded=[NSMutableArray array];NSRunningApplication *target=[NSRunningApplication runningApplicationWithProcessIdentifier:_picker->pid];
    NSRunningApplication *launcher=[NSRunningApplication runningApplicationWithProcessIdentifier:_state->launcher];
    if(NSBundle.mainBundle.bundleIdentifier)[excluded addObject:NSBundle.mainBundle.bundleIdentifier];if(launcher.bundleIdentifier)[excluded addObject:launcher.bundleIdentifier];
    for(NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications)if(app.bundleIdentifier&&![app.bundleIdentifier isEqual:target.bundleIdentifier]&&![excluded containsObject:app.bundleIdentifier])[excluded addObject:app.bundleIdentifier];
    config.excludedBundleIDs=excluded;picker.defaultConfiguration=config;picker.maximumStreamCount=@(_state->feeds.size());
    [picker addObserver:self];picker.active=YES;_picker->event(@{@"event":@"picking",@"mode":@"window"});[self presentPicker];
}
- (void)presentPicker {[SCContentSharingPicker.sharedPicker presentPickerUsingContentStyle:SCShareableContentStyleWindow];}
- (void)contentSharingPicker:(SCContentSharingPicker*)picker didCancelForStream:(SCStream*)stream {
    auto feed=_picker;dispatch_async(dispatch_get_main_queue(),^{if(self->_picker==feed)[self closeFeed:feed reason:@"Window selection cancelled" failed:NO];});
}
- (void)contentSharingPickerStartDidFailWithError:(NSError*)error {
    auto feed=_picker;dispatch_async(dispatch_get_main_queue(),^{if(self->_picker==feed)[self closeFeed:feed reason:error.localizedDescription?:@"The window picker could not open" failed:YES];});
}
- (void)contentSharingPicker:(SCContentSharingPicker*)picker didUpdateWithFilter:(SCContentFilter*)filter forStream:(SCStream*)stream {
    auto feed=_picker;dispatch_async(dispatch_get_main_queue(),^{
        if(!feed||self->_picker!=feed||![self contains:feed])return;self->_picker.reset();picker.active=NO;
        SCWindow *window=filter.includedWindows.firstObject;
        if(!window){[self closeFeed:feed reason:@"The picked content is not a single window" failed:YES];return;}
        if([self duplicate:feed window:window.windowID display:0]){[self closeFeed:feed reason:@"This window already has window graphics" failed:YES];return;}
        [self select:feed filter:filter window:window event:windowEvent(window)];[self presentNextPicker];
    });
}
- (void)pollFeed:(Feed)feed {
    if(![self contains:feed])return;
    if(feed->waiting){if(!alive(feed->pid)){[self closeFeed:feed reason:@"The application quit" failed:NO];return;}
        const auto window=mainWindow(feed->pid);if(window&&window!=feed->window){feed->waiting=false;if(feed->direct){feed->window=window;[self resolve:feed];}else [self presentNextPicker];}
        else if(now()>=feed->deadline)[self closeFeed:feed reason:@"No new window opened" failed:NO];return;}
    if(!feed->selected)return;
    Geometry g=feed->display?displayTarget(feed->display):windowTarget(feed->window);screenFor(g,feed->display,feed->captureScale);
    if(!g.exists){
        if(feed->display||feed->offered||!alive(feed->pid)){[self closeFeed:feed reason:feed->display?@"The display is no longer available":@"The window closed" failed:NO];return;}
        feed->offered=true;feed->selected=false;feed->waiting=true;feed->deadline=now()+10;feed->event(@{@"event":@"waiting-for-window"});
        dispatch_async(feed->intake,^{feed->stop(false);});return;
    }
    // Display and app-windows captures crop in display coordinates, so only
    // they reconfigure when a window moves.
    if(!same(g,feed->metadata)){
        if(!feed->display&&!feed->palettes&&sameExtent(g,feed->metadata)){g.generation=feed->metadata.generation;feed->metadata=g;feed->moved(g);}
        else {g.generation=feed->metadata.generation+1;feed->metadata=g;feed->update(g);}
    }
    if(!feed->display){const bool covered=ownPalette(feed->window,g);
        if((covered!=feed->palettes||(covered&&feed->paletteDisplay!=feed->metadata.display))&&!feed->filterRequest){feed->filterRequest=true;++_state->requests;
            __weak MacFXCaptureService *weak=self;[self requestContent:^(SCShareableContent *content,NSError *error){dispatch_async(dispatch_get_main_queue(),^{
                MacFXCaptureService *self=weak;if(!self)return;--self->_state->requests;feed->filterRequest=false;if(!content||![self contains:feed])return;
                SCContentFilter *filter=nil;
                if(covered){SCDisplay *display=nil;SCRunningApplication *app=nil;
                    for(SCDisplay *d in content.displays)if(d.displayID==feed->metadata.display)display=d;
                    for(SCRunningApplication *a in content.applications)if(a.processID==feed->pid)app=a;
                    if(display&&app){filter=[[SCContentFilter alloc]initWithDisplay:display includingApplications:@[app] exceptingWindows:@[]];if(@available(macOS 14.2,*))filter.includeMenuBar=NO;}}
                else for(SCWindow *window in content.windows)if(window.windowID==feed->window){filter=[[SCContentFilter alloc]initWithDesktopIndependentWindow:window];break;}
                if(filter){feed->palettes=covered;feed->paletteDisplay=covered?feed->metadata.display:0;feed->update(feed->metadata,filter);}
            });}];}
    }
    if(feed->failedSince&&now()-feed->failedSince>=FailureGrace)[self closeFeed:feed reason:@"Window capture stopped" failed:YES];
}
- (void)poll {
    if(!_state->running||_state->stopping)return;std::vector<Feed>feeds;for(auto &[_,feed]:_state->feeds)feeds.push_back(feed);
    for(auto &feed:feeds)[self pollFeed:feed];
    if(_state->clients.empty()&&_state->emptyAt&&now()-_state->emptyAt>=2)[self stop];
}
- (void)heartbeat {
    if(!_state->running||_state->stopping)return;
    if(!alive(_state->launcher)||birth(_state->launcher)!=_state->launcherBirth){[self stop];return;}
    std::vector<pid_t>gone;for(auto &[pid,peer]:_state->clients)if(!send(peer->port,Heartbeat))gone.push_back(pid);
    for(auto pid:gone)[self removePeer:pid];
}
- (void)applicationQuit:(pid_t)pid {
    std::vector<Feed>feeds;for(auto &[_,feed]:_state->feeds)if(feed->pid==pid)feeds.push_back(feed);
    for(auto &feed:feeds)[self closeFeed:feed reason:@"The application quit" failed:NO];
}
- (void)suspend:(BOOL)value {
    if(_state->suspended==bool(value))return;_state->suspended=value;
    for(auto &entry:_state->feeds){auto feed=entry.second;dispatch_async(feed->intake,^{feed->suspended=value;
        if(value){feed->capture(@"suspended");feed->stop(false);}else feed->start();});
    }
}
- (void)suspension:(NSString*)reason active:(BOOL)active {
    if(_state->stopping)return;if(active)[_suspensions addObject:reason];else [_suspensions removeObject:reason];[self suspend:_suspensions.count>0];
}
- (void)screenLockChanged:(NSNotification*)notification {
    [self suspension:@"screen-lock" active:[notification.name isEqualToString:@"com.apple.screenIsLocked"]];
}
- (void)captureFailed:(Feed)feed error:(NSError*)error {
    if(![self contains:feed])return;
    if([error.domain isEqual:SCStreamErrorDomain]&&error.code==SCStreamErrorUserStopped){[self closeFeed:feed reason:@"Sharing was stopped" failed:NO];return;}
    if(![self captureAvailable]){[self closeFeed:feed reason:[@"Capturing a window or display " stringByAppendingString:ScreenRecordingReason] failed:YES];return;}
    const bool interrupted=[error.domain isEqual:SCStreamErrorDomain]&&(error.code==SCStreamErrorFailedApplicationConnectionInterrupted||
        error.code==SCStreamErrorFailedApplicationConnectionInvalid||error.code==SCStreamErrorInternalError);
    if(interrupted){if(feed->lastInterrupted&&now()-feed->lastInterrupted<10){[self closeFeed:feed reason:error.localizedDescription?:LostReason failed:YES];return;}
        feed->lastInterrupted=now();if(!feed->failedSince)feed->failedSince=now();feed->capture(@"restarting",error.localizedDescription);dispatch_async(feed->intake,^{feed->stop(false);});return;}
    if(!feed->failedSince){feed->failedSince=now();feed->capture(@"failed",error.localizedDescription?:@"Window capture failed");}
}
- (void)captureRecovered:(Feed)feed {if([self contains:feed])feed->failedSince=0;}
- (void)closeFeed:(Feed)feed reason:(NSString*)reason failed:(BOOL)failed {
    if(![self contains:feed])return;
    // Send the terminal event before erasing ownership; late callbacks only
    // retain the stream and its lease, never revive the feed.
    feed->ended=true;++_state->stops;feed->event(@{@"event":@"closed",@"reason":reason?:@"",@"failed":@(failed)});
    if(_picker==feed){_picker.reset();SCContentSharingPicker.sharedPicker.active=NO;}
    {std::lock_guard<std::mutex>lock(_state->mutex);_state->feeds.erase({feed->peer->process,feed->id});}
    dispatch_async(feed->intake,^{feed->stop(true);--feed->state->stops;});[self presentNextPicker];
}
- (void)overlaysChanged {
    NSMutableOrderedSet *all=[NSMutableOrderedSet orderedSet];for(auto &[_,peer]:_state->clients)[all addObjectsFromArray:peer->overlays];
    _state->overlays=all.array;const auto revision=++_state->overlayRevision;[self refreshExclusions:revision deadline:now()+2];
}
- (void)acknowledgeExclusions:(uint64_t)revision {
    if(revision!=_state->overlayRevision||_state->stopping)return;
    for(auto &[_,peer]:_state->clients)send(peer->port,Event,0,{},MACH_PORT_NULL,@{@"event":@"excluded",@"overlays":_state->overlays});
}
- (void)refreshExclusions:(uint64_t)revision deadline:(double)deadline {
    if(_state->stopping||revision!=_state->overlayRevision)return;
    std::vector<Feed>displays;for(auto &[_,feed]:_state->feeds)if(feed->display&&feed->selected)displays.push_back(feed);
    if(displays.empty()){[self acknowledgeExclusions:revision];return;}
    ++_state->requests;__weak MacFXCaptureService *weak=self;
    [self requestContent:^(SCShareableContent *content,NSError *error){dispatch_async(dispatch_get_main_queue(),^{
        MacFXCaptureService *self=weak;if(!self)return;--self->_state->requests;if(self->_state->stopping||revision!=self->_state->overlayRevision)return;
        NSMutableSet *found=[NSMutableSet set];for(SCWindow *window in content.windows)[found addObject:@(window.windowID)];
        bool ready=content!=nil;for(NSNumber *id in self->_state->overlays)if(![found containsObject:id])ready=false;
        if(!ready){if(now()<deadline)dispatch_after(dispatch_time(DISPATCH_TIME_NOW,100*NSEC_PER_MSEC),dispatch_get_main_queue(),^{[self refreshExclusions:revision deadline:deadline];});return;}
        // Each feed serializes filter changes with its configuration. The
        // acknowledgement waits for every display's transaction to settle.
        auto remaining=std::make_shared<std::atomic<unsigned>>(unsigned(displays.size()));auto accepted=std::make_shared<std::atomic<bool>>(true);
        for(auto &feed:displays){SCDisplay *display=nil;for(SCDisplay *d in content.displays)if(d.displayID==feed->display)display=d;
            SCContentFilter *filter=display?[self displayFilter:display content:content]:nil;
            if(!filter||![self contains:feed]){*accepted=false;if(remaining->fetch_sub(1)==1&&*accepted)[self acknowledgeExclusions:revision];continue;}
            feed->update(feed->metadata,filter,^(bool okay){if(!okay)*accepted=false;
                if(remaining->fetch_sub(1)==1&&*accepted)dispatch_async(dispatch_get_main_queue(),^{[weak acknowledgeExclusions:revision];});});
        }
    });}];
}
- (NSDictionary*)feedSnapshot:(uint32_t)number process:(pid_t)process {
    Feed feed=[self feed:number process:process];if(!feed)return nil;__block NSDictionary *snapshot;
    dispatch_sync(feed->intake,^{snapshot=@{@"stream":@((uintptr_t)(__bridge void*)feed->stream),@"starts":@(feed->starts),@"stops":@(feed->stopCount),
        @"retained":@(feed->frames.size()),@"peak":@(feed->retainedPeak),@"dropped":@(feed->dropped),
        @"cropX":@(feed->configuration().sourceRect.origin.x),@"cropY":@(feed->configuration().sourceRect.origin.y),@"queueDepth":@(feed->configuration().queueDepth),@"cursor":@(feed->cursor),@"appliedCursor":@(feed->appliedCursor),@"source":feed->palettes?@"application-windows":@"window",@"generation":@(feed->applied.generation),
        @"configuring":@(bool(feed->configuring)),@"paused":@(feed->paused),@"suspended":@(feed->suspended),@"width":@(feed->applied.width),@"height":@(feed->applied.height)};});return snapshot;
}
- (void)stop {
    auto state=_state;if(state->stopping)return;state->stopping=true;
    // Withdraw discovery while holding the file lock, then retire captures.
    if(state->name){[[maybe_unused]] const auto removed=bootstrap_register(bootstrap_port,const_cast<char*>(state->name.UTF8String),MACH_PORT_NULL);}
    [_poll invalidate];_poll=nil;[_heartbeat invalidate];_heartbeat=nil;
    for(dispatch_source_t signal in _signals)dispatch_source_cancel(signal);[_signals removeAllObjects];
    for(id observer in _observers)[NSWorkspace.sharedWorkspace.notificationCenter removeObserver:observer];[_observers removeAllObjects];
    for(NSString *name in @[@"com.apple.screenIsLocked",@"com.apple.screenIsUnlocked"])[NSDistributedNotificationCenter.defaultCenter removeObserver:self name:name object:nil];
    if(_picker){_picker.reset();SCContentSharingPicker.sharedPicker.active=NO;}[SCContentSharingPicker.sharedPicker removeObserver:self];
    __block bool catalogStopped=false;rsCatalogStopServing(^{catalogStopped=true;});
    std::vector<Feed>feeds;for(auto &[_,feed]:state->feeds)feeds.push_back(feed);
    for(auto &feed:feeds){feed->ended=true;dispatch_sync(feed->intake,^{feed->stop(true);});}
    {std::lock_guard<std::mutex>lock(state->mutex);state->feeds.clear();}
    const auto deadline=now()+StopWait;
    while((!catalogStopped||state->stops||state->requests)&&now()<deadline)@autoreleasepool{CFRunLoopRunInMode(kCFRunLoopDefaultMode,.01,true);}
    for(auto &[_,peer]:state->clients)send(peer->port,Goodbye,0,{},MACH_PORT_NULL,@{@"reason":@"Window capture stopped"});state->clients.clear();
    state->receiving=false;if(state->receiver.joinable())state->receiver.join();
    if(state->port){mach_port_destroy(mach_task_self(),state->port);state->port=MACH_PORT_NULL;}
    if(state->lock>=0){close(state->lock);state->lock=-1;}state->running=false;
}
- (void)dealloc {if(_state->running)[self stop];}
@end
namespace {
void emitCatalog(NSDictionary *event){NSData *bytes=[NSJSONSerialization dataWithJSONObject:event options:0 error:nil];if(bytes){fwrite(bytes.bytes,1,bytes.length,stdout);fputc('\n',stdout);fflush(stdout);}}
NSString *serviceArgument(NSArray<NSString*> *arguments){NSUInteger index=[arguments indexOfObject:@"--capture-service"];
    return index!=NSNotFound&&index+1<arguments.count?arguments[index+1]:defaultServiceId();}
}
int runCaptureService(NSArray<NSString*> *arguments){@autoreleasepool{
    [NSApplication sharedApplication];NSApp.activationPolicy=NSApplicationActivationPolicyAccessory;
    auto service=[[MacFXCaptureService alloc]initWithId:serviceArgument(arguments) admission:nil];NSError *error=nil;
    if(![service start:&error])return 1;
    while(service.running)@autoreleasepool{CFRunLoopRunInMode(kCFRunLoopDefaultMode,.05,true);}return 0;
}}
int runCatalogRelay(NSArray<NSString*> *arguments){@autoreleasepool{
    [NSApplication sharedApplication];NSApp.activationPolicy=NSApplicationActivationPolicyAccessory;signal(SIGPIPE,SIG_IGN);
    pid_t excluded=0;NSUInteger index=[arguments indexOfObject:@"--exclude-pid"];if(index!=NSNotFound&&index+1<arguments.count)excluded=[arguments[index+1] intValue];
    __block bool done=false;__block unsigned losses=0;ClientCallbacks callbacks;
    callbacks.catalogEvent=^(NSDictionary *event){emitCatalog(event);if([event[@"event"] isEqual:@"permission"]&&![event[@"screenRecording"] boolValue])done=true;};
    callbacks.disconnected=^(NSString*){emitCatalog(@{@"event":@"failed",@"reason":@"The window list stopped"});if(++losses>1)done=true;};
    callbacks.failed=^(NSString*){if(!done)emitCatalog(@{@"event":@"failed",@"reason":@"The window list stopped"});done=true;};NSString *error=nil;auto client=Client::connect(serviceArgument(arguments),@"catalog",callbacks,&error);
    if(!client){emitCatalog(@{@"event":@"failed",@"reason":error?:@"The window list stopped"});return 1;}
    client->catalog(@{@"thumbnails":@YES,@"excludePid":@(excluded)});
    NSMutableArray *signals=[NSMutableArray array];for(int number:{SIGTERM,SIGINT,SIGHUP}){signal(number,SIG_IGN);auto source=dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,number,0,dispatch_get_main_queue());
        dispatch_source_set_event_handler(source,^{done=true;});dispatch_resume(source);[signals addObject:source];}
    dispatch_source_t input=nil;struct stat type{};if(!fstat(STDIN_FILENO,&type)&&(S_ISFIFO(type.st_mode)||S_ISSOCK(type.st_mode))){
        input=dispatch_source_create(DISPATCH_SOURCE_TYPE_READ,STDIN_FILENO,0,dispatch_get_main_queue());dispatch_source_set_event_handler(input,^{char bytes[256];if(read(STDIN_FILENO,bytes,sizeof(bytes))<=0)done=true;});dispatch_resume(input);}
    while(!done)@autoreleasepool{CFRunLoopRunInMode(kCFRunLoopDefaultMode,.05,true);}
    client->catalog(nil);client->stop();if(input)dispatch_source_cancel(input);for(dispatch_source_t source in signals)dispatch_source_cancel(source);return 0;
}}
