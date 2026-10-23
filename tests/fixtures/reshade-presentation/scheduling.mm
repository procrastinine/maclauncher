#include "presentation.h"
#include "target-time.h"
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <stdexcept>

static std::atomic<unsigned> requests{0}, requestStatus{0}, releases{0};
static std::atomic<double> requestedTarget{0};
@interface DroppedPresentation : NSObject
@property CFTimeInterval presentedTime;
@end
@implementation DroppedPresentation
@end
@interface SchedulingDrawable : NSObject<CAMetalDrawable>
@property(strong) id<CAMetalDrawable> original;
@property(weak) id<MTLCommandBuffer> producer;
@property BOOL dropTimestamp;
@end
@implementation SchedulingDrawable
- (id<MTLTexture>)texture {return self.original.texture;}
- (CAMetalLayer *)layer {return self.original.layer;}
- (NSUInteger)drawableID {return self.original.drawableID;}
- (CFTimeInterval)presentedTime {return self.original.presentedTime;}
- (void)note:(double)target {requestStatus.store(unsigned(self.producer.status));requestedTarget.store(target);requests.fetch_add(1);}
- (void)present {[self note:0];[self.original present];}
- (void)presentAtTime:(CFTimeInterval)time {[self note:time];[self.original presentAtTime:time];}
- (void)presentAfterMinimumDuration:(CFTimeInterval)duration {[self note:duration];[self.original presentAfterMinimumDuration:duration];}
- (void)addPresentedHandler:(MTLDrawablePresentedHandler)handler {if(!self.dropTimestamp){[self.original addPresentedHandler:handler];return;}[self.original addPresentedHandler:^(id<MTLDrawable>value){auto dropped=[DroppedPresentation new];dropped.presentedTime=0;handler((id<MTLDrawable>)dropped);}];}
@end
@interface SchedulingLayer : CAMetalLayer
@property(weak) id<MTLCommandBuffer> producer;
@property BOOL resizeOnNext;
@property BOOL dropTimestamp;
@end
@implementation SchedulingLayer
- (id<CAMetalDrawable>)nextDrawable {
    if(self.resizeOnNext){self.resizeOnNext=NO;self.drawableSize=CGSizeMake(64,96);}
    auto original=[super nextDrawable];if(!original)return nil;
    auto value=[SchedulingDrawable new];value.original=original;value.producer=self.producer;value.dropTimestamp=self.dropTimestamp;return value;
}
@end
static void require(bool condition,const char*reason){if(!condition)throw std::runtime_error(reason);}
static void idle(double seconds){auto until=[NSDate dateWithTimeIntervalSinceNow:seconds];while(until.timeIntervalSinceNow>0)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.002,false);}
static void released(void*){releases.fetch_add(1);}
struct Feedback {void*presenter=nullptr;std::atomic<unsigned>calls{0},outcome{0};std::atomic<uint64_t>frame{0};std::atomic<double>shown{0},retired{0};};
static void retired(void*context,uint64_t frame,double shown,double when,uint32_t outcome){auto&f=*static_cast<Feedback*>(context);if(f.presenter){RSPresenterStatus status{sizeof(status),RS_PRESENTER_ABI_VERSION};rsGetFramePresenterStatus(f.presenter,&status);}f.frame.store(frame);f.shown.store(shown);f.retired.store(when);f.outcome.store(outcome);f.calls.fetch_add(1);}
int main(){@autoreleasepool{try{
    [NSApplication sharedApplication];auto device=MTLCreateSystemDefaultDevice();require(device!=nil,"Metal device unavailable");
    auto queue=[device newCommandQueue];auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(20,80,128,128) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.title=@"Presentation scheduling";auto layer=[SchedulingLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;
    window.contentView.wantsLayer=YES;window.contentView.layer=layer;layer.drawableSize=CGSizeMake(128,128);[window orderFront:nil];[window display];idle(.02);
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:128 height:128 mipmapped:NO];descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;
    auto image=[device newTextureWithDescriptor:descriptor];int owner=0;
    NSError*shaderError=nil;auto shader=[device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal; kernel void work(device uint *v [[buffer(0)]], uint id [[thread_position_in_grid]]) { uint x=v[id]; for(uint i=0;i<8000000;i++) { x=x*1664525u+1013904223u; x^=x>>13; } v[id]=x; }" options:nil error:&shaderError];
    require(shader!=nil,"Cannot compile scheduling workload");auto compute=[device newComputePipelineStateWithFunction:[shader newFunctionWithName:@"work"] error:&shaderError];require(compute!=nil,"Cannot create scheduling workload");
    auto workload=[device newBufferWithLength:128 options:MTLResourceStorageModeShared];
    RSPresenterOptions options{sizeof(options),RS_PRESENTER_ABI_VERSION,0,0,0};RSPresenterError error{sizeof(error),RS_PRESENTER_ABI_VERSION,{}};
    void*presenter=rsCreateFramePresenter((__bridge void*)layer,&owner,&options,&error);require(presenter,error.reason);
    uint64_t frame=0;unsigned accepted=0;Feedback feedback;feedback.presenter=presenter;RSPresentationObserver observer{sizeof(observer),RS_TARGET_ABI_VERSION,&feedback,retired};
    for(unsigned mode=0;mode<3;++mode){@autoreleasepool{
        auto commands=[queue commandBuffer];auto encoder=[commands computeCommandEncoder];[encoder setComputePipelineState:compute];[encoder setBuffer:workload offset:0 atIndex:0];[encoder dispatchThreadgroups:MTLSizeMake(1,1,1) threadsPerThreadgroup:MTLSizeMake(32,1,1)];[encoder endEncoding];layer.producer=commands;
        requests.store(0);requestStatus.store(0);requestedTarget.store(0);
        RSPresenterSubmission item{sizeof(item),RS_PRESENTER_ABI_VERSION,(__bridge void*)commands,(__bridge void*)image,++frame,CACurrentMediaTime(),&owner,released};RSFrameResult result{sizeof(result),RS_FRAME_ABI_VERSION};
        const double targetTime=CACurrentMediaTime()+(mode==1?.2:-.1);RSPresentationTarget target{sizeof(target),RS_TARGET_ABI_VERSION,targetTime};
        layer.dropTimestamp=mode==2;
        require((mode==2?rsSubmitFramePresenterAtTimeObserved(presenter,&item,&target,&observer,&result):mode?rsSubmitFramePresenterAtTime(presenter,&item,&target,&result):rsSubmitFramePresenter(presenter,&item,&result))==RS_FRAME_OK,result.reason);++accepted;
        [commands commit];
        const double deadline=CACurrentMediaTime()+.5;while(!requests.load()&&CACurrentMediaTime()<deadline)idle(.002);
        const bool scheduled=requests.load()==1&&requestStatus.load()==MTLCommandBufferStatusScheduled;
        fprintf(stderr,"mode=%u requests=%u requestStatus=%u bufferStatus=%u\n",mode,requests.load(),requestStatus.load(),unsigned(commands.status));
        [commands waitUntilCompleted];
        require(scheduled,"Presentation waited for GPU completion instead of scheduling");
        require(mode==1?std::abs(requestedTarget.load()-targetTime)<1e-9:requestedTarget.load()==0,"Future or elapsed presentation target changed");
        idle(mode==1?.21:.02);require(releases.load()==accepted,"Completed frame retained producer ownership");
        if(mode==2){const double deadline=CACurrentMediaTime()+1;while(!feedback.calls.load()&&CACurrentMediaTime()<deadline)idle(.002);fprintf(stderr,"retirement calls=%u frame=%llu outcome=%u shown=%f retired=%f\n",feedback.calls.load(),feedback.frame.load(),feedback.outcome.load(),feedback.shown.load(),feedback.retired.load());require(feedback.calls.load()==1&&feedback.frame.load()==frame&&feedback.outcome.load()==RS_PRESENT_DROPPED&&feedback.shown.load()==0&&feedback.retired.load()>0,"Dropped drawable did not retire exactly once without a display timestamp");}
    }}
    layer.dropTimestamp=NO;
    // Resize after submit snapshots the extent but before drawable acquisition.
    // The rejected frame keeps its identity and can retry at the new size.
    {@autoreleasepool{auto commands=[queue commandBuffer];layer.producer=commands;layer.resizeOnNext=YES;
        RSPresenterSubmission item{sizeof(item),RS_PRESENTER_ABI_VERSION,(__bridge void*)commands,(__bridge void*)image,++frame,CACurrentMediaTime(),&owner,released};RSFrameResult result{sizeof(result),RS_FRAME_ABI_VERSION};
        require(rsSubmitFramePresenter(presenter,&item,&result)==RS_FRAME_BUSY,"A concurrent window resize became a permanent presentation failure");
        RSPresenterStatus status{sizeof(status),RS_PRESENTER_ABI_VERSION};require(rsGetFramePresenterStatus(presenter,&status)==RS_FRAME_OK&&!status.reason[0]&&!status.stopped,"Resize retained a permanent presentation error");
        require(rsSubmitFramePresenter(presenter,&item,&result)==RS_FRAME_OK,result.reason);++accepted;
        [commands commit];[commands waitUntilCompleted];idle(.02);require(commands.status==MTLCommandBufferStatusCompleted&&releases.load()==accepted,"Resized retry did not complete or release the producer");
        require(rsGetFramePresenterStatus(presenter,&status)==RS_FRAME_OK&&status.completedReal==accepted&&!status.reason[0],"Resized frame did not recover presentation");
        layer.drawableSize=CGSizeMake(128,128);
    }}
    requests.store(0);
    {@autoreleasepool{auto commands=[queue commandBuffer];layer.producer=commands;
        RSPresenterSubmission item{sizeof(item),RS_PRESENTER_ABI_VERSION,(__bridge void*)commands,(__bridge void*)image,++frame,CACurrentMediaTime(),&owner,released};RSFrameResult result{sizeof(result),RS_FRAME_ABI_VERSION};
        RSPresentationTarget target{sizeof(target),RS_TARGET_ABI_VERSION,CACurrentMediaTime()};require(rsSubmitFramePresenterAtTimeObserved(presenter,&item,&target,&observer,&result)==RS_FRAME_OK,result.reason);++accepted;
    }}idle(.02);require(requests.load()==0&&releases.load()==accepted,"Uncommitted buffer presented or retained its producer");fprintf(stderr,"abandoned calls=%u outcome=%u\n",feedback.calls.load(),feedback.outcome.load());require(feedback.calls.load()==2&&feedback.outcome.load()==RS_PRESENT_CANCELLED,"Abandoned frame did not retire its observer once");
    auto commands=[queue commandBuffer];layer.producer=commands;
    RSPresenterSubmission item{sizeof(item),RS_PRESENTER_ABI_VERSION,(__bridge void*)commands,(__bridge void*)image,++frame,CACurrentMediaTime(),&owner,released};RSFrameResult result{sizeof(result),RS_FRAME_ABI_VERSION};
    RSPresentationTarget target{sizeof(target),RS_TARGET_ABI_VERSION,CACurrentMediaTime()};require(rsSubmitFramePresenterAtTimeObserved(presenter,&item,&target,&observer,&result)==RS_FRAME_OK,result.reason);++accepted;
    feedback.presenter=nullptr;rsDestroyFramePresenter(presenter);require(feedback.calls.load()==2,"Retirement released a frame before its GPU consumer ended");[commands commit];[commands waitUntilCompleted];idle(.02);
    require(requests.load()==0&&releases.load()==accepted,"Retired presenter issued a presentation request or lost producer ownership");
    require(feedback.calls.load()==3&&feedback.outcome.load()==RS_PRESENT_CANCELLED&&feedback.frame.load()==frame,"Retired presenter lost or duplicated its final observation");
    [window close];puts("PASS actual GPU-work presentation schedules before completion; resize retries, future/past targets, abandonment and owner cancellation preserved");return 0;
}catch(const std::exception&error){fprintf(stderr,"%s\n",error.what());return 1;}}}
