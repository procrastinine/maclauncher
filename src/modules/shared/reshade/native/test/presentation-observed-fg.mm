#include "presentation.hpp"
#include "effects-execution.hpp"
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
@property(nonatomic) BOOL trackPresented;
@property(strong) id<CAMetalDrawable> completedDrawable;
@end
@implementation ObservedLayer
- (id<CAMetalDrawable>)nextDrawable {
    ++draws;
    if(holdNext.exchange(false)){dispatch_semaphore_signal(entered);assert(dispatch_semaphore_wait(releaseFrame,dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC))==0);}
    auto drawable=[super nextDrawable];
    if(self.trackPresented&&drawable){__weak ObservedLayer *weak=self;[drawable addPresentedHandler:^(id<MTLDrawable>actual){
        if(actual.presentedTime>0)if(auto layer=weak){@synchronized(layer){layer.completedDrawable=(id<CAMetalDrawable>)actual;}}
    }];}
    return drawable;
}
@end
@interface PlacementWindow:NSWindow
@end
@implementation PlacementWindow
- (BOOL)canBecomeKeyWindow{return NO;}
- (BOOL)canBecomeMainWindow{return NO;}
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
struct Colour final:macfx::ShaderNode {
    bool prefix;float gain=.8;id<MTLComputePipelineState> pipeline;
    explicit Colour(bool value):prefix(value){}
    void setParameters(const macfx::ShaderParameters&)override{}
    macfx::ShaderResult prepare(const macfx::ShaderFrame&frame)override{
        if(!pipeline){NSError *error=nil;auto library=[frame.commands.device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal;kernel void colour(texture2d<float,access::read>a[[texture(0)]],texture2d<float,access::write>b[[texture(1)]],constant uint&prefix[[buffer(0)]],uint2 p[[thread_position_in_grid]]){if(p.x>=b.get_width()||p.y>=b.get_height())return;float4 v=a.read(p);if(prefix)v.r=.3;else v.b=.8;b.write(v,p);}" options:nil error:&error];assert(library);pipeline=[frame.commands.device newComputePipelineStateWithFunction:[library newFunctionWithName:@"colour"]error:&error];assert(pipeline);}return {true,{}};
    }
    macfx::ShaderResult encode(const macfx::ShaderFrame&frame)override{prepare(frame);auto encoder=[frame.commands computeCommandEncoder];unsigned value=prefix;[encoder setComputePipelineState:pipeline];[encoder setTexture:frame.source atIndex:0];[encoder setTexture:frame.target atIndex:1];[encoder setBytes:&value length:sizeof(value)atIndex:0];[encoder dispatchThreads:MTLSizeMake(frame.target.width,frame.target.height,1)threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];return {true,{}};}
};
NSString *hex(NSString *value){return [@"" stringByPaddingToLength:64 withString:value startingAtIndex:0];}
NSDictionary *shader(NSString *name){return @{@"id":name,@"kind":@"shader",@"enabled":@YES,@"format":@"fx",@"file":[@"/proof/" stringByAppendingString:name],@"key":hex(@"a"),@"revision":hex(@"b"),@"preservesCoordinates":@YES};}
void sourcePlacement(NSString *model){
    char temporary[]="/tmp/maclauncher-source-fg-XXXXXX";assert(mkdtemp(temporary));NSString *directory=@(temporary),*plan=[directory stringByAppendingPathComponent:@"plan.json"];
    setenv("RESHADE_EXPLICIT_HOST","1",1);setenv("RESHADE_EFFECT_PLAN",plan.fileSystemRepresentation,1);
    const auto frontmostBefore=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    [NSApplication sharedApplication];const BOOL activeBefore=NSApp.active;NSWindow *keyBefore=NSApp.keyWindow;
    auto unchangedFocus=[&]{assert(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier==frontmostBefore&&NSApp.active==activeBefore&&NSApp.keyWindow==keyBefore);};
    assert([NSApp setActivationPolicy:NSApplicationActivationPolicyRegular]);[NSApp finishLaunching];unchangedFocus();
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    const auto desktop=NSScreen.mainScreen.visibleFrame;assert(desktop.size.width>=240&&desktop.size.height>=240);
    auto window=[[PlacementWindow alloc]initWithContentRect:NSMakeRect(NSMaxX(desktop)-216,NSMaxY(desktop)-192,192,144)styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
    window.title=@"Frame delivery";window.level=NSFloatingWindowLevel;window.ignoresMouseEvents=YES;window.hidesOnDeactivate=NO;
    auto layer=[ObservedLayer layer];layer->holdNext.store(false);layer->draws.store(0);layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;
    layer.opaque=YES;layer.framebufferOnly=NO;layer.displaySyncEnabled=YES;layer.trackPresented=YES;
    window.contentView.wantsLayer=YES;window.contentView.layer=layer;[window orderFront:nil];
    const auto visibleUntil=CACurrentMediaTime()+1;while(!(window.occlusionState&NSWindowOcclusionStateVisible)&&CACurrentMediaTime()<visibleUntil)idle(.005);
    unchangedFocus();
    std::fprintf(stderr,"source-placement floating precondition visible=%u activeSpace=%u mini=%u occlusion=%lu level=%ld frontmost=%d ownActive=%u keyUnchanged=%u\n",window.visible,window.onActiveSpace,window.miniaturized,(unsigned long)window.occlusionState,(long)window.level,NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier,NSApp.active,NSApp.keyWindow==keyBefore);
    assert(window.visible&&window.onActiveSpace&&!window.miniaturized&&(window.occlusionState&NSWindowOcclusionStateVisible));
    auto image=[&](unsigned width,unsigned height){auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];
        desc.storageMode=MTLStorageModeShared;desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;auto result=[device newTextureWithDescriptor:desc];assert(result);return result;};
    auto publish=[&](bool hint,NSString *revision){NSMutableDictionary *settings=[@{@"frameMultiplier":@3,@"framePacing":@"fixed",@"targetFps":@60,@"lsfgMode":@"performance",@"lsfgFp16":@YES,@"lsfgFlowScale":@0.5}mutableCopy];
        if(hint){settings[@"simpleGenerationPlacement"]=@"source-cost-v1";settings[@"simpleSpatialNodeId"]=@"fit";}
        auto generation=@{@"id":@"generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":model,@"settings":settings};
        auto scale=@{@"id":@"fit",@"kind":@"spatial",@"enabled":@YES,@"method":@"bilinear",@"settings":@{@"spatialMultiplier":NSNull.null}};
        auto document=@{@"schema":@1,@"mode":@"advanced",@"revision":hex(revision),@"nodes":@[shader(@"prefix"),scale,generation,shader(@"suffix")]};
        assert([[NSJSONSerialization dataWithJSONObject:document options:0 error:nil]writeToFile:plan atomically:YES]);idle(.12);
    };
    int owner=0;uint64_t frame=0;publish(true,@"a");macfx::FramePresenter presenter(layer,&owner);
    auto exercise=[&](unsigned sw,unsigned sh,unsigned ow,unsigned oh,bool sourceSize){
        layer.drawableSize=CGSizeMake(ow,oh);idle(.03);auto source=image(sw,sh);
        @autoreleasepool{macfx::EffectPlanExecutor probe;auto validation=[queue commandBuffer];auto target=image(ow,oh);
            const auto selected=probe.prepare({validation,source,target,frame+1},true);assert(selected.execution&&selected.execution->generator());
            assert(selected.execution->generationWidth()==(sourceSize?sw:ow)&&selected.execution->generationHeight()==(sourceSize?sh:oh));}
        const auto before=presenter.snapshot();
        for(unsigned i=0;i<6;++i){std::vector<unsigned char>original(size_t(sw)*sh*4);
            for(unsigned y=0;y<sh;++y)for(unsigned x=0;x<sw;++x){auto *p=&original[(size_t(y)*sw+x)*4];
                p[0]=(x+i*5)%256;p[1]=((x/8+y/8+i)%2)?180:40;p[2]=120;p[3]=255;}
            [source replaceRegion:MTLRegionMake2D(0,0,sw,sh)mipmapLevel:0 withBytes:original.data()bytesPerRow:sw*4];
            auto commands=[queue commandBuffer];assert(presenter.submit(commands,source,++frame,CACurrentMediaTime()).encoded);commit(commands);
            const auto deadline=CACurrentMediaTime()+3;while(presenter.lastRealCompletedFrameId()!=frame&&CACurrentMediaTime()<deadline)idle(.005);assert(presenter.lastRealCompletedFrameId()==frame);
            std::vector<unsigned char>unchanged(original.size());[source getBytes:unchanged.data()bytesPerRow:sw*4 fromRegion:MTLRegionMake2D(0,0,sw,sh)mipmapLevel:0];assert(unchanged==original);idle(.06);
        }
        const auto deadline=CACurrentMediaTime()+3;while((presenter.snapshot().presentedReal<=before.presentedReal||presenter.snapshot().presentedGenerated<=before.presentedGenerated)&&CACurrentMediaTime()<deadline)idle(.005);
        const auto after=presenter.snapshot();unchangedFocus();
        std::fprintf(stderr,"source-placement readiness source=%ux%u output=%ux%u expectedSource=%u encoded=%llu completed=%llu real=%llu generated=%llu dropped=%llu draws=%u stopped=%u visible=%u activeSpace=%u mini=%u occlusion=%lu layerHidden=%u reason=%s\n",sw,sh,ow,oh,sourceSize,
            (unsigned long long)after.encoded,(unsigned long long)after.completedReal,(unsigned long long)(after.presentedReal-before.presentedReal),
            (unsigned long long)(after.presentedGenerated-before.presentedGenerated),(unsigned long long)(after.dropped-before.dropped),layer->draws.load(),after.stopped,
            window.visible,window.onActiveSpace,window.miniaturized,(unsigned long)window.occlusionState,layer.hidden,after.reason.c_str());
        assert(window.visible&&window.onActiveSpace&&!window.miniaturized&&(window.occlusionState&NSWindowOcclusionStateVisible));
        assert(after.presentedReal>before.presentedReal&&after.presentedGenerated>before.presentedGenerated&&!after.stopped&&after.reason.empty());
        id<CAMetalDrawable> shown;@synchronized(layer){shown=layer.completedDrawable;}assert(shown&&shown.presentedTime>0&&shown.texture.width==ow&&shown.texture.height==oh);
        auto read=[device newBufferWithLength:256 options:MTLResourceStorageModeShared];auto commands=[queue commandBuffer];auto blit=[commands blitCommandEncoder];
        [blit copyFromTexture:shown.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(ow/2,oh/2,0)sourceSize:MTLSizeMake(1,1,1)toBuffer:read destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256];[blit endEncoding];commit(commands);
        const auto bytes=static_cast<const unsigned char*>(read.contents);assert(std::abs(int(bytes[0])-204)<=2&&bytes[3]==255);
        std::printf("source-placement source=%ux%u generation=%ux%u output=%ux%u real=%llu generated=%llu suffixBlue=%u\n",sw,sh,sourceSize?sw:ow,sourceSize?sh:oh,ow,oh,
            (unsigned long long)(after.presentedReal-before.presentedReal),(unsigned long long)(after.presentedGenerated-before.presentedGenerated),unsigned(bytes[0]));
    };
    exercise(128,96,256,192,true);exercise(160,120,320,240,true);
    publish(false,@"b");exercise(160,120,320,240,false);presenter.stop();assert(presenter.snapshot().stopped);
    layer.completedDrawable=nil;[window close];unchangedFocus();assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);
    std::puts("Simple source placement: actual LSFG working extent, final-real/generated display, suffix pixels, resize and literal-order restoration passed; injected shader, no game-quality qualification");
}
}
namespace macfx {std::shared_ptr<ShaderNode>makeShaderNode(const ShaderSpec&spec){return std::make_shared<Colour>(spec.selection.file=="/proof/prefix");}}
int main(int argc,char **argv){@autoreleasepool{
    assert(argc==2||(argc==3&&std::string(argv[2])=="--source-placement"));NSString *model=@(argv[1]);assert([NSFileManager.defaultManager fileExistsAtPath:model]);
    if(argc==3){sourcePlacement(model);return 0;}
    char temporary[]="/tmp/maclauncher-observed-fg-XXXXXX";assert(mkdtemp(temporary));NSString *directory=@(temporary),*plan=[directory stringByAppendingPathComponent:@"plan.json"];
    auto generation=@{@"id":@"generation",@"kind":@"frame-generation",@"enabled":@YES,@"method":@"lsfg",@"modelPath":model,@"settings":@{@"frameMultiplier":@3,@"framePacing":@"fixed",@"targetFps":@60,@"lsfgMode":@"performance",@"lsfgFp16":@YES,@"lsfgFlowScale":@0.5}};
    auto document=@{@"schema":@1,@"mode":@"advanced",@"revision":hex(@"a"),@"nodes":@[shader(@"prefix"),generation,shader(@"suffix")]};
    assert([[NSJSONSerialization dataWithJSONObject:document options:0 error:nil]writeToFile:plan atomically:YES]);setenv("RESHADE_EXPLICIT_HOST","1",1);setenv("RESHADE_EFFECT_PLAN",plan.fileSystemRepresentation,1);
    [NSApplication sharedApplication];auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(80,100,256,192)styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
    auto layer=[ObservedLayer layer];layer->holdNext.store(false);layer->draws.store(0);layer->entered=dispatch_semaphore_create(0);layer->releaseFrame=dispatch_semaphore_create(0);layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.opaque=YES;layer.displaySyncEnabled=YES;
    window.contentView.wantsLayer=YES;window.contentView.layer=layer;[window orderFront:nil];idle(.05);layer.drawableSize=CGSizeMake(128,96);
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:128 height:96 mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;auto source=[device newTextureWithDescriptor:descriptor];assert(source);
    std::vector<unsigned char>pixels(128*96*4);for(unsigned y=0;y<96;++y)for(unsigned x=0;x<128;++x){const auto at=(y*128+x)*4;pixels[at]=x;pixels[at+1]=y;pixels[at+2]=120;pixels[at+3]=255;}[source replaceRegion:MTLRegionMake2D(0,0,128,96)mipmapLevel:0 withBytes:pixels.data()bytesPerRow:512];
    int owner=0;macfx::FramePresenter presenter(layer,&owner);uint64_t frame=0;
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
    assert(presenter.submitAtTimeObserved(commands,source,replacementFrame,CACurrentMediaTime(),nullptr,&replacementObserver).encoded);commit(commands);awaitRecord(replaced);
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
    [window close];assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);std::puts("Observed FG: untargeted final-real display, caller-owned submission, strict target rejection, replacement, Stop and abandoned-source batch reuse retirement exactly once passed");
}}
