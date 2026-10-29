#if defined(BROWSER_TEST_ACTUAL_SOURCE)
// Actual ingress callbacks with metadata doubles: no NSApplication, SCStream,
// window, capture, Metal device or command buffer is constructed by this case.
#import <Cocoa/Cocoa.h>
#include "fixture-files.hpp"
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <QuartzCore/QuartzCore.h>
#include <atomic>
#include <cassert>
#include <cstdio>
#include <thread>
#include <chrono>
static std::atomic<double>browserFixtureTime{10};
static double browserFixtureMediaTime(){return browserFixtureTime.load();}
#define CACurrentMediaTime browserFixtureMediaTime
#define MacFXBrowserOutputWindow MacFXBrowserConfigurationTestOutputWindow
#define MacFXBrowserStream MacFXBrowserConfigurationTestStream
#ifndef MACFX_BROWSER_SOURCE
#define MACFX_BROWSER_SOURCE <browser-frame.mm>
#endif
#include MACFX_BROWSER_SOURCE
#undef CACurrentMediaTime

@interface BrowserConfigurationSource:NSObject
@property(nonatomic,strong)NSObject *contentView;
@property(nonatomic,getter=isVisible)BOOL visible;
@property(nonatomic,getter=isMiniaturized)BOOL miniaturized;
@property(nonatomic,getter=isOnActiveSpace)BOOL onActiveSpace;
@end
@implementation BrowserConfigurationSource
- (CGFloat)backingScaleFactor{return 2;}
@end
@interface BrowserConfigurationLayer:NSObject
@property(nonatomic)CGFloat contentsScale;
@property(nonatomic)CGSize drawableSize;
@property(nonatomic)BOOL hidden;
@property(nonatomic)unsigned scaleWrites,drawableWrites;
@end
@implementation BrowserConfigurationLayer
@synthesize contentsScale=_contentsScale,drawableSize=_drawableSize;
- (void)setContentsScale:(CGFloat)value{++_scaleWrites;_contentsScale=value;}
- (void)setDrawableSize:(CGSize)value{++_drawableWrites;_drawableSize=value;}
@end
@interface BrowserConfigurationOutput:NSObject
@property(nonatomic)unsigned closes;
@property(nonatomic)unsigned frameWrites;
@property(nonatomic)NSRect frame;
@property(nonatomic,getter=isVisible)BOOL visible;
@property(nonatomic,getter=isOnActiveSpace)BOOL onActiveSpace;
@property(nonatomic)NSWindowOcclusionState occlusionState;
@end
@implementation BrowserConfigurationOutput
- (id)parentWindow{return nil;}
- (void)setFrame:(NSRect)frame display:(BOOL)display{++_frameWrites;self.frame=frame;(void)display;}
- (void)orderOut:(id)sender{(void)sender;self.visible=NO;}
- (void)close{++_closes;}
@end
@interface BrowserConfigurationStream:NSObject
@property(nonatomic,strong)NSMutableArray *configurations;
@property(nonatomic,strong)NSMutableArray *callbacks;
@property(nonatomic)unsigned stops;
@end
@implementation BrowserConfigurationStream
- (instancetype)init{if((self=[super init])){_configurations=[NSMutableArray new];_callbacks=[NSMutableArray new];}return self;}
- (void)updateConfiguration:(SCStreamConfiguration*)configuration completionHandler:(void(^)(NSError*))callback{
    [_configurations addObject:configuration];[_callbacks addObject:[callback copy]];
}
- (void)stopCaptureWithCompletionHandler:(void(^)(NSError*))callback{++_stops;callback(nil);}
- (void)finish:(NSUInteger)index error:(NSError*)error{void(^callback)(NSError*)=_callbacks[index];callback(error);}
@end
struct BrowserConfigurationCase {
    BrowserConfigurationSource *source=[BrowserConfigurationSource new];
    BrowserConfigurationLayer *layer=[BrowserConfigurationLayer new];
    BrowserConfigurationOutput *output=[BrowserConfigurationOutput new];
    BrowserConfigurationStream *stream=[BrowserConfigurationStream new];
    std::shared_ptr<Session>session=std::make_shared<Session>();
    BrowserConfigurationCase(){session->source=(NSWindow*)source;session->layer=(CAMetalLayer*)layer;session->output=(MacFXBrowserOutputWindow*)output;
        source.contentView=[NSObject new];source.visible=YES;source.onActiveSpace=YES;output.visible=YES;output.onActiveSpace=YES;output.occlusionState=NSWindowOcclusionStateVisible;
        session->stream=(SCStream*)stream;session->revealed=true;session->ready=true;session->geometry={0,32,1100,700,2200,1400};
        session->width=2200;session->height=1400;}
    void drain(){dispatch_sync(session->renderQueue,^{});}
    void resize(unsigned w,unsigned h){session->update({0,32,double(w),double(h),w*2,h*2},NSMakeRect(0,0,w,h));drain();}
    void finish(unsigned index,NSError *error=nil){[stream finish:index error:error];drain();}
    void close(){session->close();drain();assert(output.closes==1&&stream.stops==1);}
    ~BrowserConfigurationCase(){session->close();drain();}
};
static NSError *configurationFailure(){return [NSError errorWithDomain:SCStreamErrorDomain code:SCStreamErrorInvalidParameter userInfo:@{NSLocalizedDescriptionKey:@"Controlled invalid configuration"}];}
static void configurationCoalescing(){
    BrowserConfigurationCase value;value.resize(900,618);assert(value.stream.configurations.count==1&&value.session->configuring);
    value.resize(800,568);assert(value.stream.configurations.count==1); // No overlapping SCK update.
    value.finish(0,configurationFailure());assert(!value.session->retired&&value.stream.configurations.count==2&&value.session->configuring);
    auto latest=(SCStreamConfiguration*)value.stream.configurations[1];
    assert(latest.width==1600&&latest.height==1136&&CGRectEqualToRect(latest.sourceRect,CGRectMake(0,32,800,568)));
    value.finish(1);assert(!value.session->retired&&!value.session->configuring&&value.session->ready&&value.output.closes==0);
    value.close();value.finish(0,configurationFailure());assert(value.stream.configurations.count==2&&value.output.closes==1);
}
static void configurationRetry(){
    BrowserConfigurationCase value;value.resize(900,618);value.finish(0,configurationFailure());
    assert(!value.session->retired&&value.session->configuring&&value.output.closes==0&&value.stream.configurations.count==1);
    std::this_thread::sleep_for(std::chrono::milliseconds(180));value.drain();assert(value.stream.configurations.count==2);
    value.finish(1);assert(!value.session->retired&&!value.session->configuring&&value.session->ready);value.close();
    BrowserConfigurationCase denied;denied.resize(900,618);denied.finish(0,configurationFailure());
    std::this_thread::sleep_for(std::chrono::milliseconds(180));denied.drain();assert(denied.stream.configurations.count==2);
    denied.finish(1,configurationFailure());assert(denied.session->retired&&denied.output.closes==0);denied.close();
    std::this_thread::sleep_for(std::chrono::milliseconds(180));denied.drain();assert(denied.stream.configurations.count==2);
}
static void configurationDeadline(){
    BrowserConfigurationCase value;value.resize(900,618);browserFixtureTime=13;
    value.resize(900,618);assert(value.session->retired);value.close();browserFixtureTime=10;
}
static void unchangedGeometry(){
    BrowserConfigurationCase value;value.resize(1100,700);
    const auto frames=value.output.frameWrites,scales=value.layer.scaleWrites,drawables=value.layer.drawableWrites;
    value.resize(1100,700);assert(value.output.frameWrites==frames&&value.layer.scaleWrites==scales&&value.layer.drawableWrites==drawables);
    value.session->update(value.session->geometry,NSMakeRect(80,90,1100,700));
    assert(value.output.frameWrites==frames+1&&value.layer.scaleWrites==scales&&value.layer.drawableWrites==drawables);
    assert(value.stream.configurations.count==0&&!value.session->copyQueueAttempted);value.close();
}
// The poll's geometry is a local of a frame that returns before the render
// queue configures the stream; a later call reuses that stack.
__attribute__((noinline)) static void resizeFromFrame(BrowserConfigurationCase &value,unsigned w,unsigned h){
    const macfx::BrowserFrameGeometry requested{0,32,double(w),double(h),w*2,h*2};value.session->update(requested,NSMakeRect(0,0,w,h));
}
__attribute__((noinline)) static void overwriteStack(){volatile unsigned char bytes[16384];for(auto &byte:bytes)byte=0xA5;}
static void releasedGeometry(){
    BrowserConfigurationCase value;dispatch_suspend(value.session->renderQueue);
    resizeFromFrame(value,1920,1080);overwriteStack();dispatch_resume(value.session->renderQueue);value.drain();
    assert(value.stream.configurations.count==1);auto requested=(SCStreamConfiguration*)value.stream.configurations[0];
    assert(requested.width==3840&&requested.height==2160&&CGRectEqualToRect(requested.sourceRect,CGRectMake(0,32,1920,1080)));
    value.finish(0);assert(!value.session->retired&&!value.session->configuring);value.close();
}
static std::shared_ptr<Sample> wrongExtentSample(uint64_t generation){
    CVPixelBufferRef pixels=nullptr;assert(CVPixelBufferCreate(kCFAllocatorDefault,1600,1136,kCVPixelFormatType_32BGRA,nullptr,&pixels)==kCVReturnSuccess);
    CMVideoFormatDescriptionRef format=nullptr;assert(CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault,pixels,&format)==noErr);
    CMSampleTimingInfo timing{CMTimeMake(1,60),CMTimeMake(1,1),kCMTimeInvalid};CMSampleBufferRef buffer=nullptr;
    assert(CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault,pixels,format,&timing,&buffer)==noErr);
    auto sample=std::make_shared<Sample>(buffer,generation);CFRelease(buffer);CFRelease(format);CVPixelBufferRelease(pixels);return sample;
}
static void unusableImages(){
    // A new configuration discards the pending failure.
    BrowserConfigurationCase resized;resized.session->window=31;auto stale=wrongExtentSample(resized.session->geometryGeneration);
    dispatch_sync(resized.session->renderQueue,^{resized.session->render(stale);});resized.resize(900,618);
    std::this_thread::sleep_for(std::chrono::milliseconds(1150));resized.drain();assert(!resized.session->retired);resized.close();
    // A settled stream that keeps delivering another extent ends with a
    // recoverable failure, and the window records its reason for status.
    BrowserConfigurationCase value;value.session->window=31;auto sample=wrongExtentSample(value.session->geometryGeneration);
    dispatch_sync(value.session->renderQueue,^{value.session->render(sample);value.session->render(sample);});
    std::this_thread::sleep_for(std::chrono::milliseconds(500));value.drain();assert(!value.session->retired);
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(4);
    while(!value.session->closed&&std::chrono::steady_clock::now()<deadline)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.01,false);
    assert(value.session->retired&&value.session->recoverAfterGeometry);
    assert(value.session->closed&&unavailable().window==31&&value.output.closes==1);
    assert(unavailable().reason.find("capture delivers 1600x1136 images for the 2200x1400 window")!=std::string::npos);
    clearUnavailable();assert(!unavailable().window);
}
static void recoveryBudget(){
    Recovery retry;macfx::BrowserFrameGeometry a{0,32,900,618,1800,1236},b{0,32,800,568,1600,1136};
    retry.arm(11,a,1);assert(!retry.ready(11,a,1.2)&&!retry.ready(12,a,2));
    assert(!retry.ready(11,b,2)&&!retry.ready(11,b,2.2));assert(retry.ready(11,b,2.3));
    assert(!retry.ready(11,b,3));retry.arm(11,b,4);assert(!retry.ready(11,b,5)); // One recovery per On/source.
    retry.reset();assert(!retry.ready(11,b,6));retry.arm(11,b,7);assert(retry.ready(11,b,7.3)); // New On.
}
static void permissionFailureCleanup(){
    // A denied own-process enumeration returns before any host is allocated.
    assert(channel().state().demand(21,true,uint32_t(getpid())));auto demand=channel().demand();
    assert(channel().probe(21,demand.epoch));const auto claim=channel().claim(21);assert(claim);
    {PendingClaim denied{21,claim};}assert(!channel().window());
    // Exercise the actual stream-error callback and main-thread close boundary.
    BrowserConfigurationCase value;value.session->window=22;
    assert(channel().state().demand(22,true,uint32_t(getpid())));demand=channel().demand();
    assert(channel().probe(22,demand.epoch));value.session->claimTicket=channel().claim(22);assert(value.session->claimTicket);
    value.session->publishVisibility();assert(value.session->visibilityActive);
    auto receiver=[MacFXBrowserStream new];receiver->session=value.session;
    [receiver stream:(SCStream*)value.stream didStopWithError:[NSError errorWithDomain:SCStreamErrorDomain code:SCStreamErrorUserDeclined userInfo:nil]];
    assert(value.session->retired&&!value.session->recoverAfterGeometry);
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(1);
    while(!value.session->closed&&std::chrono::steady_clock::now()<deadline)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.01,false);
    value.drain();assert(value.session->closed&&!value.session->visibilityActive&&!channel().window());
    assert(value.output.closes==1&&value.stream.stops==1);
}
static void visibilityEdges(){
    BrowserConfigurationCase value;value.session->window=11;
    assert(channel().state().demand(11,true,uint32_t(getpid())));const auto demand=channel().demand();
    assert(channel().probe(11,demand.epoch));value.session->claimTicket=channel().claim(11);assert(value.session->claimTicket);
    NSString *name=@"org.maclauncher.browser-frame-visibility.00112233445566778899aabbccddeeff";
    NSMutableArray *events=[NSMutableArray new];__block bool closeOnTrue=false;std::weak_ptr<Session>weak=value.session;
    id observer=[NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *note){
        assert(NSThread.isMainThread);[events addObject:note.userInfo];
        if(closeOnTrue&&[note.userInfo[@"active"]boolValue])if(auto owner=weak.lock())owner->close();
    }];
    value.session->revealed=false;value.session->publishVisibility();assert(events.count==0&&value.stream.configurations.count==0);
    value.session->revealed=true;value.session->publishVisibility();assert(events.count==1&&[events.lastObject[@"active"]boolValue]);
    assert([events.lastObject[@"schema"]intValue]==1&&[events.lastObject[@"pid"]intValue]==getpid());
    NSString *identity=[NSString stringWithFormat:@"%llx",(unsigned long long)(__bridge void*)value.source.contentView];assert([events.lastObject[@"nativeView"]isEqualToString:identity]);
    value.session->publishVisibility();assert(events.count==1); // Edges, never per-frame publication.
    value.output.occlusionState=0;value.session->publishVisibility();assert(events.count==2&&![events.lastObject[@"active"]boolValue]);
    value.output.occlusionState=NSWindowOcclusionStateVisible;value.session->publishVisibility();assert(events.count==3&&[events.lastObject[@"active"]boolValue]);
    value.source.miniaturized=YES;value.session->publishVisibility();assert(events.count==4&&![events.lastObject[@"active"]boolValue]);
    value.source.miniaturized=NO;value.session->publishVisibility();assert(events.count==5&&[events.lastObject[@"active"]boolValue]);
    assert(channel().state().demand(0,true,uint32_t(getpid())));value.session->publishVisibility();assert(events.count==6&&![events.lastObject[@"active"]boolValue]);
    value.session->publishVisibility();assert(events.count==6&&value.stream.configurations.count==0); // Off makes no stream work.
    assert(channel().state().demand(11,true,uint32_t(getpid())));const auto replacement=channel().demand();assert(channel().probe(11,replacement.epoch));
    value.session->claimTicket=channel().claim(11);assert(value.session->claimTicket);closeOnTrue=true;
    value.session->publishVisibility();value.drain();assert(events.count==8&&[events[6][@"active"]boolValue]&&![events[7][@"active"]boolValue]);
    assert(value.session->closed&&value.output.closes==1&&value.stream.stops==1&&!channel().window());
    value.session->publishVisibility();assert(events.count==8);[NSNotificationCenter.defaultCenter removeObserver:observer];
    BrowserConfigurationCase observerFailure;observerFailure.session->window=12;
    assert(channel().state().demand(12,true,uint32_t(getpid())));const auto third=channel().demand();assert(channel().probe(12,third.epoch));
    observerFailure.session->claimTicket=channel().claim(12);assert(observerFailure.session->claimTicket);
    id throwing=[NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification*){
        @throw [NSException exceptionWithName:@"ControlledObserverFailure" reason:@"Optional observer failed" userInfo:nil];
    }];
    observerFailure.session->publishVisibility();assert(!observerFailure.session->retired&&observerFailure.output.closes==0);
    [NSNotificationCenter.defaultCenter removeObserver:throwing];observerFailure.close();
}
int main(){@autoreleasepool{
    char scratch[1024];temporaryPath(scratch,"macfx-browser-callbacks-XXXXXX");assert(mkdtemp(scratch));const std::string file=std::string(scratch)+"/channel";
    unsigned char bytes[64]{};memcpy(bytes,"MLBRSRC1",8);for(unsigned i=0;i<16;++i)bytes[i+8]=i*17;
    int fd=open(file.c_str(),O_WRONLY|O_CREAT|O_EXCL,0600);assert(fd>=0&&write(fd,bytes,sizeof(bytes))==sizeof(bytes));close(fd);
    setenv("RESHADE_BROWSER_FRAME_STATE",file.c_str(),1);setenv("RESHADE_BROWSER_FRAME_TOKEN","00112233445566778899aabbccddeeff",1);
    configurationCoalescing();configurationRetry();configurationDeadline();unchangedGeometry();releasedGeometry();unusableImages();recoveryBudget();visibilityEdges();permissionFailureCleanup();
    assert(unlink(file.c_str())==0&&rmdir(scratch)==0);
    std::puts("actual browser callbacks: single-flight/coalesced resize, geometry copied past its caller, bounded unusable-image failure with a recorded reason, stale-error rejection, bounded retry/deadline, one stable-geometry recovery, authenticated visibility edges and reentrant Off/close passed; no capture/GPU/window");return 0;
}}
#else
// CPU-only: real escaping Objective-C blocks, no Metal or display receipt.
#import <Foundation/Foundation.h>
#include <dispatch/dispatch.h>
#include <atomic>
#include <cassert>
#include <cstdio>
#include <memory>

@interface BrowserCompletionBuffer : NSObject
@property(copy) void (^finished)(bool);
@end
@implementation BrowserCompletionBuffer
@end

struct Slot {
    std::atomic<bool>busy{true};std::shared_ptr<std::atomic<unsigned>>destroyed;
    explicit Slot(std::shared_ptr<std::atomic<unsigned>>count):destroyed(std::move(count)){}
    ~Slot(){++*destroyed;}
};
#ifdef BROWSER_TEST_BORROWED_SLOT
using SlotArgument=const std::shared_ptr<Slot>&;
#else
using SlotArgument=std::shared_ptr<Slot>;
#endif
// Same nested GPU-completion -> serial-release capture boundary as submitCopied.
static void submit(SlotArgument slot,BrowserCompletionBuffer *buffer,dispatch_queue_t queue,
                   std::shared_ptr<std::atomic<unsigned>>failures){
    buffer.finished=^(bool failed){dispatch_async(queue,^{slot->busy=false;if(failed)++*failures;});};
}
static bool deferredRelease(bool failed){
    auto destroyed=std::make_shared<std::atomic<unsigned>>(0),failures=std::make_shared<std::atomic<unsigned>>(0);
    auto slot=std::make_shared<Slot>(destroyed);std::weak_ptr<Slot>weak=slot;
    auto queue=dispatch_queue_create("browser-slot-lifetime",DISPATCH_QUEUE_SERIAL);dispatch_suspend(queue);
    @autoreleasepool {
        auto buffer=[BrowserCompletionBuffer new];submit(slot,buffer,queue,failures);slot.reset();
        if(weak.expired()){
            // Red discriminator exits before dereferencing the borrowed parameter.
            buffer.finished=nil;dispatch_resume(queue);
            std::fputs("FAIL: completion borrowed the caller slot instead of retaining it\n",stderr);return false;
        }
        assert(weak.lock()->busy);buffer.finished(failed);buffer.finished=nil;
        assert(!weak.expired());assert(destroyed->load()==0);
    }
    // The completion property getter can return an autoreleased block. End that
    // pool before testing the final queued release's independent ownership.
    assert(!weak.expired());assert(destroyed->load()==0);
    dispatch_resume(queue);dispatch_sync(queue,^{});
    assert(weak.expired());assert(destroyed->load()==1);assert(failures->load()==unsigned(failed));
    return true;
}
int main(){@autoreleasepool{
    if(!deferredRelease(false)||!deferredRelease(true))return 42;
    std::puts("browser slot lifetime: completion and queued release retain success/error slots exactly once");return 0;
}}

#endif
