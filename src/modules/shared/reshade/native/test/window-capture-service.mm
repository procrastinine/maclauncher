// Real Mach transport and ScreenCaptureKit on fixture-owned, nonactivating
// windows. Current-process shareable content needs no Screen Recording grant.
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <IOSurface/IOSurface.h>
#include "graphics-capture-service.hpp"
#include "window-capture-client.hpp"
#include "graphics-window-catalog.hpp"
#include <algorithm>
#include <atomic>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <map>
#include <mutex>
#include <servers/bootstrap.h>
#include <thread>
#include <unistd.h>
using namespace macfx::wcap;

@interface CaptureFixturePanel:NSPanel
@end
@implementation CaptureFixturePanel
- (BOOL)canBecomeKeyWindow{return NO;}
- (BOOL)canBecomeMainWindow{return NO;}
@end
@interface CaptureFixturePattern:NSView
@property(nonatomic)unsigned tick;
@end
@implementation CaptureFixturePattern
- (void)drawRect:(NSRect)dirty {
    [[NSColor colorWithCalibratedRed:(self.tick%9)/9. green:.25 blue:.65 alpha:1] setFill];NSRectFill(self.bounds);
    [NSColor.whiteColor setFill];NSRectFill(NSMakeRect(8+(self.tick%100),10,30,30));
}
@end
@interface CaptureFixtureService:MacFXCaptureService
@property(nonatomic)BOOL available;
@property(nonatomic)unsigned pickerPresentations;
@end
@implementation CaptureFixtureService
- (BOOL)captureAvailable{return self.available;}
- (void)requestContent:(void (^)(SCShareableContent*,NSError*))completion {
    if(@available(macOS 14.4,*))[SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:completion];
}
- (void)presentPicker {++self.pickerPresentations;}
@end
@interface MacFXCaptureService(CaptureFixtureLifecycle)
- (void)suspension:(NSString*)reason active:(BOOL)active;
@end
static void pump(double seconds){double deadline=NSProcessInfo.processInfo.systemUptime+seconds;
    while(NSProcessInfo.processInfo.systemUptime<deadline)@autoreleasepool{CFRunLoopRunInMode(kCFRunLoopDefaultMode,.01,true);}}
static void until(double seconds,bool (^done)(void),const char *label){
    double deadline=NSProcessInfo.processInfo.systemUptime+seconds;
    while(!done()&&NSProcessInfo.processInfo.systemUptime<deadline)pump(.02);
    if(!done()){std::fprintf(stderr,"timeout: %s\n",label);std::fflush(stderr);assert(done());}
}
static CaptureFixturePanel *panel(NSRect frame){
    auto window=[[CaptureFixturePanel alloc]initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.level=NSNormalWindowLevel;window.hidesOnDeactivate=NO;window.ignoresMouseEvents=YES;
    window.contentView=[[CaptureFixturePattern alloc]initWithFrame:NSMakeRect(0,0,frame.size.width,frame.size.height)];[window orderFrontRegardless];return window;
}
struct FixtureFrames {
    std::mutex mutex;std::map<uint32_t,NSDictionary*>geometry;std::map<uint32_t,std::vector<FrameInfo>>frames;
    std::vector<NSDictionary*>events;std::weak_ptr<Client>client;std::atomic<bool>releaseFrames{true};
    void event(uint32_t feed,NSDictionary *event){std::lock_guard<std::mutex>lock(mutex);events.push_back([event copy]);if([event[@"event"] isEqual:@"geometry"])geometry[feed]=[event copy];}
    unsigned count(uint32_t feed){std::lock_guard<std::mutex>lock(mutex);return unsigned(frames[feed].size());}
    FrameInfo last(uint32_t feed){std::lock_guard<std::mutex>lock(mutex);assert(!frames[feed].empty());return frames[feed].back();}
    NSDictionary *lastGeometry(uint32_t feed){std::lock_guard<std::mutex>lock(mutex);return geometry[feed];}
    unsigned eventsNamed(NSString *name,uint32_t feed,NSString *field=nil,NSString *value=nil){std::lock_guard<std::mutex>lock(mutex);unsigned result=0;
        for(NSDictionary *event:events)if([event[@"event"] isEqual:name]&&[event[@"feed"] unsignedIntValue]==feed&&(!field||[event[field] isEqual:value]))++result;return result;}
};
static void frame(void *context,uint32_t feed,IOSurfaceRef surface,const FrameInfo &info){
    auto &state=*static_cast<FixtureFrames*>(context);assert(surface&&info.sequence&&info.generation&&std::isfinite(info.time)&&info.time>0);
    assert(IOSurfaceGetWidth(surface)==info.width&&IOSurfaceGetHeight(surface)==info.height);
    {std::lock_guard<std::mutex>lock(state.mutex);NSDictionary *g=state.geometry[feed];
        if(!g)std::fprintf(stderr,"frame before geometry feed=%u generation=%llu\n",feed,info.generation);
        assert(g&&[g[@"generation"] unsignedLongLongValue]==info.generation&&[g[@"pixelsWidth"] unsignedIntValue]==info.width&&[g[@"pixelsHeight"] unsignedIntValue]==info.height);
        state.frames[feed].push_back(info);}
    if(state.releaseFrames)if(auto client=state.client.lock())client->release(feed,info.sequence);
}
static std::shared_ptr<Client>connect(NSString *identifier,FixtureFrames &state){
    ClientCallbacks callbacks;callbacks.frame=frame;callbacks.frameContext=&state;
    callbacks.feedEvent=^(uint32_t feed,NSDictionary *event){state.event(feed,event);
        NSData *bytes=[NSJSONSerialization dataWithJSONObject:event options:NSJSONWritingSortedKeys error:nil];
        std::fprintf(stderr,"service event: %.*s\n",int(bytes.length),static_cast<const char*>(bytes.bytes));};
    callbacks.failed=^(NSString *reason){std::fprintf(stderr,"client failed: %s\n",reason.UTF8String);assert(false);};
    NSString *error=nil;auto client=Client::connect(identifier,@"chain",callbacks,&error);if(!client)std::fprintf(stderr,"connect: %s\n",error.UTF8String);assert(client);state.client=client;return client;
}
static void catalogSearch(){
    std::vector<pid_t>owners;for(pid_t owner:{101,202,303})owners.insert(owners.end(),40,owner);owners.push_back(404);
    auto kept=catalogKeep(owners,96);assert(kept.size()==96&&std::is_sorted(kept.begin(),kept.end())&&std::adjacent_find(kept.begin(),kept.end())==kept.end());
    for(size_t first:{size_t(0),size_t(40),size_t(80),size_t(120)})assert(std::find(kept.begin(),kept.end(),first)!=kept.end());
    NSMutableArray *rows=[NSMutableArray array];for(size_t i=0;i<owners.size();++i)[rows addObject:@{@"id":@(i+1),@"pid":@(owners[i]),@"application":@"Fixture",@"title":[NSString stringWithFormat:@"Window %zu",i],@"width":@320,@"height":@200,@"onScreen":@YES}];
    NSSet<NSNumber*> *thumbnails=nil;NSDictionary *event=rsCatalogModel(@[],rows,96,&thumbnails);
    assert([event[@"event"] isEqual:@"catalog"]&&[event[@"windows"] count]==96&&[event[@"more"] count]==25&&thumbnails.count==96);
    size_t shown=0,more=0;for(size_t i=0;i<rows.count;++i){if(std::binary_search(kept.begin(),kept.end(),i)){assert([event[@"windows"][shown++] isEqual:rows[i]]);assert([thumbnails containsObject:@(i+1)]);}
        else{assert([event[@"more"][more++] isEqual:rows[i]]);assert(![thumbnails containsObject:@(i+1)]);}}
    NSArray *small=[rows subarrayWithRange:NSMakeRange(0,12)];event=rsCatalogModel(@[],small,96,&thumbnails);
    assert([event[@"windows"] isEqual:small]&&[event[@"more"] count]==0&&thumbnails.count==12);
    assert((catalogKeep({1,1,2},96)==std::vector<size_t>{0,1,2}));assert(catalogKeep(owners,0).empty());
    std::puts("12 PASS catalog front window per app, 96 previews, ordered searchable remainder, no remainder thumbnails");
}
int main(){@autoreleasepool{
    setvbuf(stdout,nullptr,_IONBF,0);
    if(@available(macOS 15.2,*)){}else{std::fputs("window-capture-service requires macOS 15.2\n",stderr);return 2;}
    [NSApplication sharedApplication];NSApp.activationPolicy=NSApplicationActivationPolicyAccessory;
    NSRunningApplication *front=NSWorkspace.sharedWorkspace.frontmostApplication;
    catalogSearch();std::vector<CGRect>screens={CGRectMake(0,0,1000,800),CGRectMake(1000,0,1000,800)};
    assert(captureScreen(CGRectMake(800,100,700,400),screens)==1);assert(captureScreen(CGRectMake(800,100,300,400),screens)==0);
    assert(captureScreen(CGRectMake(-500,0,100,100),screens,1)==1);std::puts("6 PASS largest screen intersection and fallback");
    auto target=panel(NSMakeRect(100,100,320,180));pump(.2);
    NSString *identifier=[NSString stringWithFormat:@"org.maclauncher.window-capture.fixture.%d.%@",getpid(),NSUUID.UUID.UUIDString];
    auto service=[[CaptureFixtureService alloc]initWithId:identifier admission:^BOOL(pid_t process,pid_t claimed){return process==getpid()&&claimed==getpid();}];service.available=YES;
    NSError *error=nil;const BOOL started=[service start:&error];if(!started)std::fprintf(stderr,"service start: %s\n",error.description.UTF8String);assert(started&&service.running);
    auto duplicate=[[CaptureFixtureService alloc]initWithId:identifier admission:nil];assert([duplicate start:&error]&&!duplicate.running);duplicate=nil;
    std::puts("10 PASS second service exits successfully without registering");
    __block SCShareableContent *content=nil;[service requestContent:^(SCShareableContent *value,NSError *error){content=value;}];until(5,^bool{return content!=nil;},"current-process content");
    assert(content.displays.count);SCContentFilter *displayFilter=[service displayFilter:content.displays.firstObject content:content];assert(!displayFilter.includeMenuBar);
    std::puts("5 PASS constructed display filter excludes menu bar; no display capture started");
    auto state=std::make_shared<FixtureFrames>();auto client=connect(identifier,*state);until(5,^bool{return service.clientCount==1&&client->servicePid()==getpid();},"Mach client welcome");
    client->setOverlays(@[@(target.windowNumber)]);until(2,^bool{return state->eventsNamed(@"excluded",0)>0;},"exclusion acknowledgement without display feed");
    NSTimer *animate=[NSTimer scheduledTimerWithTimeInterval:.025 repeats:YES block:^(NSTimer*){auto view=(CaptureFixturePattern*)target.contentView;++view.tick;[view setNeedsDisplay:YES];[target displayIfNeeded];}];
    client->open(1,@{@"target":@"window",@"windowID":@(target.windowNumber)});
    until(8,^bool{return state->count(1)>=3;},"first IOSurface frames");
    auto first=state->last(1);assert(first.width==320*target.backingScaleFactor&&first.height==180*target.backingScaleFactor);
    [target setFrame:NSMakeRect(100,100,360,200) display:YES];
    until(5,^bool{auto info=state->last(1);return info.generation>first.generation&&info.width==360*target.backingScaleFactor&&info.height==200*target.backingScaleFactor;},"resized generation");
    std::puts("1 PASS real IOSurfaces, configured extent, geometry before each generation including resize");
    state->releaseFrames=false;unsigned before=state->count(1);until(3,^bool{return state->count(1)>before;},"withheld frame");pump(.4);before=state->count(1);pump(.4);
    assert(state->count(1)==before);NSDictionary *snapshot=[service feedSnapshot:1 process:getpid()];
    assert([snapshot[@"queueDepth"] intValue]==4&&[snapshot[@"retained"] intValue]<=3&&[snapshot[@"peak"] intValue]<=3);
    state->releaseFrames=true;client->release(1,state->last(1).sequence);until(3,^bool{return state->count(1)>before;},"release drains pending");
    std::puts("2 PASS queue depth 4; at most two leased, one pending, Release resumes newest frame");
    snapshot=[service feedSnapshot:1 process:getpid()];const auto stream=[snapshot[@"stream"] unsignedLongLongValue];const auto starts=[snapshot[@"starts"] unsignedIntValue],stops=[snapshot[@"stops"] unsignedIntValue];
    before=state->count(1);client->options(1,@{@"cursor":@YES});
    until(5,^bool{return [[service feedSnapshot:1 process:getpid()][@"cursor"] boolValue]&&state->count(1)>before+1;},"cursor update resumes frames");
    snapshot=[service feedSnapshot:1 process:getpid()];assert([snapshot[@"stream"] unsignedLongLongValue]==stream&&[snapshot[@"starts"] unsignedIntValue]==starts&&[snapshot[@"stops"] unsignedIntValue]==stops);
    assert([snapshot[@"generation"] unsignedLongLongValue]==state->last(1).generation&&[snapshot[@"appliedCursor"] boolValue]);
    std::puts("3 PASS cursor updates same SCStream without stop/start");
    client->options(1,@{@"cropX":@12,@"cropY":@7});
    until(2,^bool{NSDictionary*c=[service feedSnapshot:1 process:getpid()];return [c[@"cropX"] doubleValue]==12&&[c[@"cropY"] doubleValue]==7;},"forwarded single-window child crop");
    client->options(1,@{@"cropX":@0,@"cropY":@0});
    until(2,^bool{return [[service feedSnapshot:1 process:getpid()][@"cropX"] doubleValue]==0;},"restore single-window crop");
    auto full=state->last(1);client->options(1,@{@"captureScale":@.5});
    until(5,^bool{auto image=state->last(1);return image.generation>full.generation&&image.width==full.width/2&&image.height==full.height/2;},"reduced capture extent");
    client->options(1,@{@"captureScale":@1});until(5,^bool{return state->last(1).width==full.width&&state->last(1).height==full.height;},"restore full capture extent");
    client->options(1,@{@"paused":@YES});until(1.5,^bool{return state->eventsNamed(@"capture",1,@"state",@"paused")>0&&service.pendingStops==0&&[[service feedSnapshot:1 process:getpid()][@"stream"] unsignedLongLongValue]==0;},"pause stops only feed stream");
    before=state->count(1);pump(.15);assert(state->count(1)==before);client->options(1,@{@"paused":@NO});
    until(5,^bool{return state->count(1)>before+1;},"resume retained filter");
    std::puts("contract PASS captureScale changes pixel extent; pause stops and resume reuses filter");
    [service suspension:@"screen-lock" active:YES];[service suspension:@"sleep" active:YES];
    until(1.5,^bool{NSDictionary *s=[service feedSnapshot:1 process:getpid()];return [s[@"suspended"] boolValue]&&[s[@"stream"] unsignedLongLongValue]==0&&service.pendingStops==0;},"suspend owned feed");
    [service suspension:@"sleep" active:NO];pump(.1);assert([[service feedSnapshot:1 process:getpid()][@"suspended"] boolValue]);
    before=state->count(1);[service suspension:@"screen-lock" active:NO];until(5,^bool{return state->count(1)>before+1;},"resume after all suspension reasons clear");
    std::puts("contract PASS sleep and lock reasons compose without desktop notifications");
    auto palette=panel(NSMakeRect(150,150,100,80));palette.level=NSFloatingWindowLevel;[palette orderFrontRegardless];
    until(6,^bool{return state->eventsNamed(@"capture",1,@"source",@"application-windows")>0;},"own palette filter");
    before=state->count(1);until(6,^bool{return state->count(1)>before+1;},"app-windows capture frames");assert(state->last(1).width==360*target.backingScaleFactor&&state->last(1).height==200*target.backingScaleFactor);
    unsigned restored=state->eventsNamed(@"capture",1,@"source",@"window");[palette orderOut:nil];
    until(6,^bool{return state->eventsNamed(@"capture",1,@"source",@"window")>restored;},"restore window capture");[palette close];
    std::puts("4 PASS own higher-layer palette switches to app-windows and back, preserving extent");
    client->open(2,@{@"target":@"window",@"windowID":@(target.windowNumber)});
    until(2,^bool{return state->eventsNamed(@"closed",2,@"reason",@"This window already has window graphics")>0;},"duplicate window refusal");
    assert([service feedSnapshot:1 process:getpid()]);std::puts("9 PASS duplicate refused; existing feed intact; exclusions acknowledged");
    client->close(1);until(1.5,^bool{return state->eventsNamed(@"closed",1)>0&&service.pendingStops==0;},"close stream completion");
    const auto retiredSequence=state->last(1).sequence;state->releaseFrames=false;before=state->count(1);
    client->open(1,@{@"target":@"window",@"windowID":@(target.windowNumber)});until(5,^bool{return state->count(1)>before;},"reopen feed with held frame");
    const auto liveSequence=state->last(1).sequence;assert(liveSequence!=retiredSequence);before=state->count(1);client->release(1,retiredSequence);pump(.2);assert(state->count(1)==before);
    state->releaseFrames=true;client->release(1,liveSequence);until(3,^bool{return state->count(1)>before;},"current release after stale release");
    client->close(1);until(1.5,^bool{return state->eventsNamed(@"closed",1)>1&&service.pendingStops==0;},"close reopened stream");
    std::puts("contract PASS late release from closed feed cannot release a reopened feed's sample");
    // Direct front-window selection with capture permission uses the same
    // resolver as a window pick; without it only picker presentation is stubbed.
    client->open(3,@{@"target":@"application",@"pid":@(getpid()),@"frontWindow":@YES});
    until(5,^bool{return state->eventsNamed(@"selected",3)>0;},"direct front window");assert(!state->eventsNamed(@"picking",3));
    client->close(3);until(1.5,^bool{return state->eventsNamed(@"closed",3)>0&&service.pendingStops==0;},"close front window");
    service.available=NO;client->open(4,@{@"target":@"application",@"pid":@(getpid()),@"frontWindow":@YES});
    until(2,^bool{return state->eventsNamed(@"picking",4)>0&&service.pickerPresentations==1;},"fallback picker");client->close(4);service.available=YES;
    std::puts("7 PASS shortcut selects front window directly with access; otherwise picker");
    // Drop a real receive right without Goodbye. The service must discover
    // the dead name and retire the stream without help from the chain.
    client->stop();until(2,^bool{return service.clientCount==0;},"client Goodbye");
    mach_port_t local=receiver();mach_port_t remote=MACH_PORT_NULL;NSDictionary *record=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:rendezvousPath(identifier)] options:0 error:nil];
    assert(bootstrap_look_up(bootstrap_port,[record[@"name"] UTF8String],&remote)==KERN_SUCCESS);
    assert(send(remote,Hello,0,{},local,@{@"role":@"chain"}));
    until(2,^bool{return service.clientCount==1;},"raw client welcome");
    assert(send(remote,Control,0,{},MACH_PORT_NULL,@{@"open":@{@"feed":@5,@"target":@"window",@"windowID":@(target.windowNumber)}}));
    until(5,^bool{return [[service feedSnapshot:5 process:getpid()][@"starts"] unsignedIntValue]>0;},"raw client stream");
    mach_port_destroy(mach_task_self(),local);mach_port_deallocate(mach_task_self(),remote);
    until(1.5,^bool{return service.clientCount==0&&service.pendingStops==0;},"dead receive right closes feed");
    assert(![service feedSnapshot:5 process:getpid()]);std::puts("8 PASS close and dead receive right stop streams; pendingStops zero within 1.5 seconds");
    assert(service.running);pump(1.6);assert(service.running);until(1.2,^bool{return !service.running;},"two-second idle shutdown");assert(service.pendingStops==0);std::puts("11 PASS two-second idle shutdown after every stream stops");
    [animate invalidate];[target close];client.reset();
    assert(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==front.processIdentifier);
    std::puts("window-capture-service: 12 acceptance checks passed; no focus or desktop input");return 0;
}}
