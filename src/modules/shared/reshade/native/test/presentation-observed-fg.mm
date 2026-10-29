#include "presentation.hpp"
#include "fixture-files.hpp"
#include "fixture-colour-shaders.hpp"
#include "effects-execution.hpp"
#include "process-phase.hpp"
#import <Cocoa/Cocoa.h>
#include <atomic>
#include <cassert>
#include <cstdio>
#include <vector>
#include <unistd.h>

@interface ObservedLayer:CAMetalLayer {
@public std::atomic<bool> holdNext;
@public std::atomic<unsigned> draws;
@public dispatch_semaphore_t entered,releaseFrame;
}
@end
@implementation ObservedLayer
- (id<CAMetalDrawable>)nextDrawable {
    ++draws;
    if(holdNext.exchange(false)){dispatch_semaphore_signal(entered);assert(dispatch_semaphore_wait(releaseFrame,dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC))==0);}
    return [super nextDrawable];
}
@end
namespace {
void idle(double seconds){const auto end=CACurrentMediaTime()+seconds;while(CACurrentMediaTime()<end){
    CFRunLoopRunInMode(kCFRunLoopDefaultMode,.005,false);
    NSEvent *event;while((event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:NSDate.distantPast inMode:NSDefaultRunLoopMode dequeue:YES]))[NSApp sendEvent:event];
    [NSApp updateWindows];
}}
struct Record {
    std::atomic<unsigned> entered{0},calls{0};macfx::FramePresenter *presenter=nullptr;
    uint64_t frame=0,realAtRetirement=0;double presented=0,retired=0;uint32_t outcome=0;
};
void observed(void *context,uint64_t frame,double presented,double retired,uint32_t outcome){
    auto &record=*static_cast<Record*>(context);assert(record.entered.fetch_add(1)==0);
    // A retirement callback may reenter the presenter; no presenter lock may
    // be held by the callback's caller, including replacement and Stop paths.
    if(record.presenter)record.realAtRetirement=record.presenter->snapshot().presentedReal;
    record.frame=frame;record.presented=presented;record.retired=retired;record.outcome=outcome;record.calls.store(1,std::memory_order_release);
}
RSPresentationObserver observer(Record &record){return {sizeof(RSPresentationObserver),RS_TARGET_ABI_VERSION,&record,observed};}
void awaitRecord(Record &record){const auto until=CACurrentMediaTime()+3;while(!record.calls.load(std::memory_order_acquire)&&CACurrentMediaTime()<until)idle(.005);assert(record.calls.load()==1);}
void commit(id<MTLCommandBuffer>commands){auto done=dispatch_semaphore_create(0);[commands addCompletedHandler:^(id<MTLCommandBuffer>){dispatch_semaphore_signal(done);}];
    [commands commit];assert(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC))==0);assert(commands.status==MTLCommandBufferStatusCompleted);}
// LSFG image storage initializes off the frame path. Until it is ready the
// presenter declines frames as busy or shows real frames only.
// The presenter checks begin once it has presented a generated frame.
void ready(macfx::FramePresenter&presenter,id<MTLCommandQueue>queue,id<MTLTexture>source,uint64_t&frame){
    const auto generated=presenter.snapshot().presentedGenerated;
    for(const auto deadline=CACurrentMediaTime()+30;;){auto commands=[queue commandBuffer];const auto result=presenter.submit(commands,source,++frame,CACurrentMediaTime());commit(commands);idle(.05);
        if(result.encoded&&presenter.snapshot().presentedGenerated>generated)return;
        if(!(result.encoded||result.busy)||CACurrentMediaTime()>=deadline)std::fprintf(stderr,"Presenter preparation: encoded=%d reason=%s status=%s\n",result.encoded,result.reason.c_str(),presenter.snapshot().reason.c_str());
        assert((result.encoded||result.busy)&&CACurrentMediaTime()<deadline);}
}
NSString *shaderRoot;
NSString *hex(NSString *value){return [@"" stringByPaddingToLength:64 withString:value startingAtIndex:0];}
NSDictionary *shader(NSString *name){return @{@"id":name,@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":fixture::colourShaderPath(shaderRoot,[name isEqual:@"prefix"]),@"parameters":@{@"Gain":@[[name isEqual:@"prefix"]?@0.3:@0.8]},@"key":hex(@"a"),@"revision":hex(@"b"),@"preservesCoordinates":@YES};}
}
int main(int argc,char **argv){@autoreleasepool{
    // The explicit host and plan file are launch settings, so the checks run as a
    // phase launched with them, in a directory this process removes afterwards.
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        assert(argc==2);assert([NSFileManager.defaultManager fileExistsAtPath:@(argv[1])]);
        char temporary[1024];temporaryPath(temporary,"maclauncher-observed-fg-XXXXXX");assert(mkdtemp(temporary));NSString *directory=@(temporary);fixture::writeColourShaders(directory);
        const int status=fixture::runPhase("observed",{{"RESHADE_EXPLICIT_HOST","1"},{"RESHADE_EFFECT_PLAN",[directory stringByAppendingPathComponent:@"plan.json"].fileSystemRepresentation}},{temporary,argv[1]});
        [NSFileManager.defaultManager removeItemAtPath:directory error:nil];return status;
    }
    assert(phase.argc==3);NSString *directory=@(phase.argv[1]),*model=@(phase.argv[2]);
    shaderRoot=directory;NSString *plan=[directory stringByAppendingPathComponent:@"plan.json"];
    auto generation=@{@"id":@"generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":model,@"settings":@{@"frameMultiplier":@3,@"framePacing":@"fixed",@"targetFps":@60,@"lsfgMode":@"performance",@"lsfgFp16":@YES,@"lsfgFlowScale":@0.5}};
    auto document=@{@"schema":@1,@"mode":@"advanced",@"revision":hex(@"a"),@"nodes":@[shader(@"prefix"),generation,shader(@"suffix")]};
    assert(replaceFile([NSJSONSerialization dataWithJSONObject:document options:0 error:nil],plan));macfx::refreshEffectPlan();
    [NSApplication sharedApplication];auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(80,100,256,192)styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
    auto layer=[ObservedLayer layer];layer->holdNext.store(false);layer->draws.store(0);layer->entered=dispatch_semaphore_create(0);layer->releaseFrame=dispatch_semaphore_create(0);layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.opaque=YES;layer.displaySyncEnabled=YES;
    window.contentView.wantsLayer=YES;window.contentView.layer=layer;[window orderFront:nil];idle(.05);layer.drawableSize=CGSizeMake(128,96);
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:128 height:96 mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;auto source=[device newTextureWithDescriptor:descriptor];assert(source);
    std::vector<unsigned char>pixels(128*96*4);for(unsigned y=0;y<96;++y)for(unsigned x=0;x<128;++x){const auto at=(y*128+x)*4;pixels[at]=x;pixels[at+1]=y;pixels[at+2]=120;pixels[at+3]=255;}[source replaceRegion:MTLRegionMake2D(0,0,128,96)mipmapLevel:0 withBytes:pixels.data()bytesPerRow:512];
    int owner=0;macfx::FramePresenter presenter(layer,&owner);uint64_t frame=0;ready(presenter,queue,source,frame);
    for(unsigned i=0;i<6;++i){auto commands=[queue commandBuffer];auto accepted=presenter.submit(commands,source,++frame,CACurrentMediaTime());assert(accepted.encoded);commit(commands);idle(.05);}idle(.12);assert(presenter.snapshot().presentedGenerated>0);
    Record targeted;targeted.presenter=&presenter;auto targetedObserver=observer(targeted);RSPresentationTarget target{sizeof(target),RS_TARGET_ABI_VERSION,CACurrentMediaTime()+.05};auto rejected=[queue commandBuffer];auto result=presenter.submitAtTimeObserved(rejected,source,frame+1,CACurrentMediaTime(),&target,&targetedObserver);assert(!result.encoded&&!targeted.calls.load());
    Record shown;shown.presenter=&presenter;auto shownObserver=observer(shown);auto commands=[queue commandBuffer];const auto shownFrame=++frame,realBefore=presenter.snapshot().presentedReal;
    result=presenter.submitAtTimeObserved(commands,source,shownFrame,CACurrentMediaTime(),nullptr,&shownObserver);assert(result.encoded&&commands.status<MTLCommandBufferStatusCommitted&&!shown.calls.load());commit(commands);awaitRecord(shown);
    assert(shown.frame==shownFrame&&shown.outcome==RS_PRESENTED&&shown.presented>0&&shown.retired>=shown.presented&&shown.realAtRetirement>realBefore);idle(.08);assert(shown.calls.load()==1);
    // Hold only the owned delivery worker; a newer source can complete and
    // replace this unissued real output without losing its observer/fence.
    const auto quietUntil=CACurrentMediaTime()+3;unsigned draws=layer->draws.load();double quietSince=CACurrentMediaTime();
    while(CACurrentMediaTime()<quietUntil){if(presenter.snapshot().pending||draws!=layer->draws.load()){draws=layer->draws.load();quietSince=CACurrentMediaTime();}if(CACurrentMediaTime()-quietSince>.05)break;idle(.005);}assert(CACurrentMediaTime()<quietUntil);
    layer->holdNext.store(true);Record replaced;replaced.presenter=&presenter;auto replacedObserver=observer(replaced);commands=[queue commandBuffer];const auto replacedFrame=++frame;
    assert(presenter.submitAtTimeObserved(commands,source,replacedFrame,CACurrentMediaTime(),nullptr,&replacedObserver).encoded);commit(commands);
    const auto until=CACurrentMediaTime()+2;while(dispatch_semaphore_wait(layer->entered,DISPATCH_TIME_NOW)!=0&&CACurrentMediaTime()<until)idle(.005);assert(CACurrentMediaTime()<until);
    Record replacement;replacement.presenter=&presenter;auto replacementObserver=observer(replacement);commands=[queue commandBuffer];const auto replacementFrame=++frame;
    assert(presenter.submitAtTimeObserved(commands,source,replacementFrame,CACurrentMediaTime(),nullptr,&replacementObserver).encoded);commit(commands);
    {const auto until=CACurrentMediaTime()+2;while(!replaced.calls.load()&&CACurrentMediaTime()<until)idle(.005);
     if(!replaced.calls.load()){const auto state=presenter.snapshot();std::fprintf(stderr,"Held delivery: replaced frame not retired real=%llu generated=%llu dropped=%llu pending=%u reason=%s\n",
        (unsigned long long)state.presentedReal,(unsigned long long)state.presentedGenerated,(unsigned long long)state.dropped,state.pending,state.reason.c_str());}}
    awaitRecord(replaced);
    assert(replaced.frame==replacedFrame&&replaced.outcome==RS_PRESENT_CANCELLED&&replaced.presented==0&&!replacement.calls.load());dispatch_semaphore_signal(layer->releaseFrame);awaitRecord(replacement);assert(replacement.frame==replacementFrame&&replacement.outcome==RS_PRESENTED&&replacement.presented>0);
    Record stopped;stopped.presenter=&presenter;auto stoppedObserver=observer(stopped);auto pending=[queue commandBuffer];const auto stoppedFrame=++frame;
    assert(presenter.submitAtTimeObserved(pending,source,stoppedFrame,CACurrentMediaTime(),nullptr,&stoppedObserver).encoded);presenter.stop();assert(!stopped.calls.load());commit(pending);awaitRecord(stopped);
    assert(stopped.frame==stoppedFrame&&stopped.outcome==RS_PRESENT_CANCELLED&&stopped.presented==0);idle(.1);assert(shown.calls.load()==1&&replaced.calls.load()==1&&replacement.calls.load()==1&&stopped.calls.load()==1&&!targeted.calls.load());
    // The source buffer is discarded without commit. Its completion lease
    // releases admission, while the pool still retains the observer. Reusing
    // that batch must retire outside the presenter lock, including fallback
    // destruction when no Metal completion callback was delivered.
    int abandonedOwner=0;macfx::FramePresenter reused(layer,&abandonedOwner);Record abandoned;abandoned.presenter=&reused;auto abandonedObserver=observer(abandoned);
    @autoreleasepool{auto discarded=[queue commandBuffer];assert(reused.submitAtTimeObserved(discarded,source,1,CACurrentMediaTime(),nullptr,&abandonedObserver).encoded);assert(discarded.status<MTLCommandBufferStatusCommitted);}
    commands=[queue commandBuffer];assert(reused.submit(commands,source,2,CACurrentMediaTime()).encoded);commit(commands);awaitRecord(abandoned);
    assert(abandoned.frame==1&&abandoned.outcome==RS_PRESENT_CANCELLED&&abandoned.presented==0);reused.stop();idle(.05);assert(abandoned.calls.load()==1);
    [window close];std::puts("Observed FG: untargeted final-real display, caller-owned submission, strict target rejection, replacement, Stop and abandoned-source batch reuse retirement exactly once passed");
}}
