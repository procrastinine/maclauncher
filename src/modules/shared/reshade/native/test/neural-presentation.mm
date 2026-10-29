// Copyright (c) MacLauncher contributors. MIT license.
#include "presentation.hpp"
#include "fixture-files.hpp"
#include "view-presentation.hpp"
#include "color-contract.hpp"
#include "process-phase.hpp"
#import <Cocoa/Cocoa.h>
#include <array>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>

@interface NeuralObservedLayer:CAMetalLayer
@property(strong) id<CAMetalDrawable> lastDrawable;
@property unsigned acquisitions;
@end
@implementation NeuralObservedLayer
- (id<CAMetalDrawable>)nextDrawable {
    auto result=[super nextDrawable];@synchronized(self){if(result){self.lastDrawable=result;++self.acquisitions;}}return result;
}
@end
static void idle(double seconds){const auto end=CACurrentMediaTime()+seconds;while(CACurrentMediaTime()<end)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.005,false);}
static void visibilityNeed(bool value,const char*reason){if(!value){std::fprintf(stderr,"Detached visibility: %s\n",reason);std::fflush(stderr);std::_Exit(1);}}
template<class Predicate>static void visibilityWait(Predicate ready,const char*reason){const auto until=CACurrentMediaTime()+8;while(!ready()){visibilityNeed(CACurrentMediaTime()<until,reason);idle(.005);}}
// Spatial and neural resources for a new size prepare off the frame path.
// Until they are ready a frame is declined as busy and nothing is encoded, so
// the checked frame is the first one the owner encodes.
template<class Owner> static id<MTLCommandBuffer> encodeWhenReady(Owner&owner,id<MTLCommandQueue>queue,id<MTLTexture>source,uint64_t&frame,macfx::FrameResult*encoded=nullptr){
    for(const auto deadline=CACurrentMediaTime()+5;;){auto commands=[queue commandBuffer];const auto result=owner.submitDisplayFrame(commands,source,++frame,CACurrentMediaTime(),true);
        if(result.encoded){if(encoded)*encoded=result;return commands;}
        const bool preparing=result.busy&&(result.reason=="Preparing spatial output"||result.reason=="Preparing graphics resources"||result.reason=="Neural provider is warming up");
        if(!preparing||CACurrentMediaTime()>=deadline)std::fprintf(stderr,"Submission declined busy=%d reason=%s\n",result.busy,result.reason.c_str());
        assert(preparing&&CACurrentMediaTime()<deadline&&commands.status<MTLCommandBufferStatusCommitted);[commands commit];[commands waitUntilCompleted];idle(.01);}
}
static int ownedColorContract(){
    [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    const NSRect visible=NSScreen.mainScreen.visibleFrame;
    auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(NSMaxX(visible)-144,NSMinY(visible)+24,128,96) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.title=@"Graphics color contract";window.level=NSNormalWindowLevel;
    auto source=[[NSView alloc]initWithFrame:NSMakeRect(0,0,128,96)];source.wantsLayer=YES;[window.contentView addSubview:source];
    CALayer *publisher=source.layer;const auto sourceFrame=source.frame;
    [window orderBack:nil];idle(.03);assert(window.visible&&!window.keyWindow);
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:32 height:24 mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
    auto input=[device newTextureWithDescriptor:descriptor];assert(input);
    std::array<unsigned char,32*24*4> pixels;for(unsigned i=0;i<pixels.size();i+=4){pixels[i]=32;pixels[i+1]=80;pixels[i+2]=140;pixels[i+3]=255;}
    [input replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:128];
    auto srgb=CGColorSpaceCreateWithName(kCGColorSpaceSRGB),p3=CGColorSpaceCreateWithName(kCGColorSpaceDisplayP3);assert(srgb&&p3);
    const auto complete=[&](const std::shared_ptr<macfx::ViewPresentation>& owner,id<MTLCommandBuffer>commands,NSView *overlay){
        [commands commit];[commands waitUntilCompleted];assert(commands.status==MTLCommandBufferStatusCompleted);
        const auto end=CACurrentMediaTime()+2;while(owner->snapshot().completedReal==0&&CACurrentMediaTime()<end)idle(.005);idle(.025);
        const auto status=owner->snapshot();if(status.completedReal!=1||!status.reason.empty())std::fprintf(stderr,"Owned color completion real=%llu reason=%s\n",status.completedReal,status.reason.c_str());
        assert(status.completedReal==1&&status.reason.empty()&&!overlay.hidden);
    };
    auto accepted=std::make_shared<macfx::ViewPresentation>(source,64,48,macfx::PresenterConfig{},srgb);
    NSView *oldOverlay=source.subviews.lastObject;CAMetalLayer *oldLayer=(CAMetalLayer*)oldOverlay.layer;
    assert(accepted->colorSpaceMatches(srgb)&&macfx::sameImageColorSpace(oldLayer.colorspace,srgb));
    uint64_t frame=0;auto first=encodeWhenReady(*accepted,queue,input,frame);complete(accepted,first,oldOverlay);
    for(CGColorSpaceRef color:{p3,srgb}){
        const auto previous=accepted;const auto previousColor=oldLayer.colorspace;
        auto candidate=std::make_shared<macfx::ViewPresentation>(source,96,72,macfx::PresenterConfig{},color,previous);
        NSView *newOverlay=source.subviews.lastObject;CAMetalLayer *newLayer=(CAMetalLayer*)newOverlay.layer;
        assert(newOverlay!=oldOverlay&&newOverlay.hidden&&!oldOverlay.hidden&&candidate->colorSpaceMatches(color));
        assert(macfx::sameImageColorSpace(newLayer.colorspace,color)&&macfx::sameImageColorSpace(oldLayer.colorspace,previousColor));
        auto commands=encodeWhenReady(*candidate,queue,input,frame);
        assert(commands.status<MTLCommandBufferStatusCommitted&&!oldOverlay.hidden&&newOverlay.hidden);
        assert(macfx::sameImageColorSpace(oldLayer.colorspace,previousColor));complete(candidate,commands,newOverlay);
        assert(!oldOverlay.superview&&previous->snapshot().stopped&&macfx::sameImageColorSpace(oldLayer.colorspace,previousColor));
        assert(candidate->colorSpaceMatches(color)&&source.layer==publisher&&NSEqualRects(source.frame,sourceFrame));
        accepted=candidate;oldOverlay=newOverlay;oldLayer=newLayer;
    }
    accepted->stop();assert(source.subviews.count==0&&source.layer==publisher);[window orderOut:nil];[window close];CFRelease(srgb);CFRelease(p3);
    std::puts("Actual owned AppKit CAMetalLayer: completed Metal sRGB/P3/sRGB replacements preserved the prior image tag until completion, retired previous overlays, kept publisher layer/frame; background window, tag wiring only, no display colour-conversion claim");return 0;
}
static void detachedVisibility(macfx::FramePresenter&presenter,NeuralObservedLayer*layer,id<MTLCommandQueue>queue,id<MTLTexture>source){
    const char*file=std::getenv("RESHADE_NEURAL_LIBRARY");visibilityNeed(file!=nullptr,"Provider path missing");auto module=dlopen(file,RTLD_NOW|RTLD_LOCAL);visibilityNeed(module!=nullptr,"Provider module missing");
    auto submissions=reinterpret_cast<unsigned(*)()>(dlsym(module,"ml_test_neural_submissions"));visibilityNeed(submissions!=nullptr,"Existing provider submission counter missing");
    const auto committed=[&](id<MTLCommandBuffer>commands){[commands commit];visibilityWait([&]{return commands.status>=MTLCommandBufferStatusCompleted;},"Source GPU completion expired");visibilityNeed(commands.status==MTLCommandBufferStatusCompleted,"Source GPU failed");};
    const auto pixels=[&](unsigned blue){id<CAMetalDrawable>drawable;@synchronized(layer){drawable=layer.lastDrawable;}visibilityNeed(drawable!=nil,"Processed output missing");
        auto bytes=[queue.device newBufferWithLength:256*24 options:MTLResourceStorageModeShared];auto commands=[queue commandBuffer];auto copy=[commands blitCommandEncoder];visibilityNeed(bytes&&commands&&copy,"Pixel readback resources missing");
        [copy copyFromTexture:drawable.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(32,24,1) toBuffer:bytes destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256*24];[copy endEncoding];committed(commands);
        const auto rgba=static_cast<const unsigned char*>(bytes.contents);for(unsigned y=0;y<24;++y)for(unsigned x=0;x<32;++x){const auto i=y*256+x*4;visibilityNeed(rgba[i]==blue&&rgba[i+1]==64&&rgba[i+2]==64&&rgba[i+3]==255,"Processed source pixels differ");}};
    uint64_t frame=0;auto baseline=encodeWhenReady(presenter,queue,source,frame);committed(baseline);
    visibilityWait([&]{return presenter.snapshot().completedReal==1&&presenter.snapshot().pending==0;},"Baseline model output did not retire");pixels(32);const auto count=submissions();
    auto old=encodeWhenReady(presenter,queue,source,frame);visibilityNeed(old.status==MTLCommandBufferStatusNotEnqueued&&submissions()==count,"Detached model ran before its source was submitted");
    presenter.setOutputVisible(false);presenter.setOutputVisible(true);
    // This real producer attempt synchronously consumes any pending idle cut.
    // Its sole occupied source slot is still pinned by the unsubmitted old CB.
    auto probe=[queue commandBuffer];const auto occupied=presenter.submitDisplayFrame(probe,source,frame+1,CACurrentMediaTime(),true);
    visibilityNeed(!occupied.encoded&&occupied.busy&&probe.status==MTLCommandBufferStatusNotEnqueued,"Old source GPU lease was lost across the visibility cut");
    committed(old);visibilityWait([&]{return presenter.snapshot().pending==0;},"Obsolete source handoff did not retire");
    visibilityNeed(submissions()==count,"Obsolete pre-hide source started model work after reappearance");visibilityNeed(presenter.snapshot().completedReal==1&&!presenter.snapshot().stopped&&presenter.snapshot().reason.empty(),"Obsolete source published output or retired its owner");pixels(32);
    std::array<unsigned char,32*24*4>changed;for(unsigned i=0;i<changed.size();i+=4){changed[i]=96;changed[i+1]=80;changed[i+2]=140;changed[i+3]=255;}[source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:changed.data() bytesPerRow:128];
    auto fresh=encodeWhenReady(presenter,queue,source,frame);committed(fresh);visibilityWait([&]{return presenter.snapshot().completedReal==2&&presenter.snapshot().pending==0;},"Fresh visible source did not recover");
    visibilityNeed(submissions()==count+1,"Fresh source did not invoke exactly one model submission");pixels(96);presenter.stop();
    // Provider callbacks use this module's code; keep it mapped through exit.
    (void)module;std::puts("Detached visibility: delayed old source committed after hide/show starts no model work; exact lease retires, retained pixels stay coherent, fresh source recovers");
}
int main(int argc,char **argv){@autoreleasepool{
    if(argc==2&&!std::strcmp(argv[1],"--color-contract"))return ownedColorContract();
#if !defined(__arm64__)
    std::puts("Neural rendering requires Apple Silicon");return 77;
#endif
    if(@available(macOS 14.0,*)){}else return 77;
    // The neural provider, its delay and the plan are launch settings, so the
    // presentation checks run as a phase launched with them.
    const auto phase=fixture::phase(argc,argv);
    if(phase.name.empty()){
        const bool visibilityOnly=argc==3&&!std::strcmp(argv[1],"--visibility");assert(visibilityOnly||argc==2);const char*provider=argv[visibilityOnly?2:1];
        NSString *plan=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"neural-presentation-" stringByAppendingString:NSUUID.UUID.UUIDString]];
        const auto document=@{@"schema":@1,@"mode":@"advanced",@"revision":[@"" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0],@"nodes":@[@{@"id":@"neural",@"kind":@"neural",@"enabled":@YES,@"method":@"mlx-dlss",@"modelPath":@"/test/local-model",@"settings":@{@"intensity":@0.25,@"temporal":@NO}}]};
        assert(replaceFile([NSJSONSerialization dataWithJSONObject:document options:0 error:nil],plan));
        auto environment=fixture::Environment{{"RESHADE_NEURAL_LIBRARY",provider},{"MACLAUNCHER_TEST_NEURAL_DELAY_MS","300"},{"RESHADE_EFFECT_PLAN",plan.fileSystemRepresentation}};
        if(visibilityOnly)environment.emplace_back("RESHADE_EXPLICIT_HOST","1");
        const int status=fixture::runPhase(visibilityOnly?"visibility":"presentation",environment);
        assert([NSFileManager.defaultManager removeItemAtPath:plan error:nil]);return status;
    }
    [NSApplication sharedApplication];auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(80,100,128,96) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;window.title=@"Neural presentation";
    auto layer=[NeuralObservedLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.displaySyncEnabled=YES;
    window.contentView.wantsLayer=YES;window.contentView.layer=layer;[window orderFront:nil];idle(.05);layer.drawableSize=CGSizeMake(32,24);
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:32 height:24 mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
    auto source=[device newTextureWithDescriptor:descriptor];std::array<unsigned char,32*24*4> input;for(unsigned i=0;i<input.size();i+=4){input[i]=32;input[i+1]=80;input[i+2]=140;input[i+3]=255;}
    [source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:input.data() bytesPerRow:128];int owner=0;macfx::FramePresenter presenter(layer,&owner);
    if(phase.name=="visibility"){detachedVisibility(presenter,layer,queue,source);[window close];return 0;}
    uint64_t frame=0;macfx::FrameResult result;const auto start=CACurrentMediaTime();auto commands=encodeWhenReady(presenter,queue,source,frame,&result);
    assert(result.encoded&&result.effects&&commands.status<MTLCommandBufferStatusCommitted);
    const auto submitted=CACurrentMediaTime();[commands commit];[commands waitUntilCompleted];const auto producerMs=(CACurrentMediaTime()-submitted)*1000;
    assert(commands.status==MTLCommandBufferStatusCompleted&&producerMs<150&&presenter.snapshot().completedReal==0);
    std::fprintf(stderr,"Producer complete %.3fms pending=%u elapsed=%.3fms\n",producerMs,presenter.snapshot().pending,(CACurrentMediaTime()-start)*1000);
    // Mutating the publisher after its copy must not alter the admitted frame.
    input.fill(220);[source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:input.data() bytesPerRow:128];
    std::fprintf(stderr,"Publisher mutation complete pending=%u elapsed=%.3fms\n",presenter.snapshot().pending,(CACurrentMediaTime()-start)*1000);
    for(unsigned i=2;i<10;++i){auto busy=[queue commandBuffer];const auto submittedAt=CACurrentMediaTime();const auto skipped=presenter.submitDisplayFrame(busy,source,++frame,submittedAt,true);const auto wallMs=(CACurrentMediaTime()-submittedAt)*1000;if(skipped.encoded||!skipped.busy)std::fprintf(stderr,"Busy attempt %u encoded=%d busy=%d reason=%s\n",i,skipped.encoded,skipped.busy,skipped.reason.c_str());assert(!skipped.encoded&&skipped.busy&&busy.status<MTLCommandBufferStatusCommitted&&wallMs<150);}
    const auto displayUpdate=CACurrentMediaTime();presenter.setDisplay(CGMainDisplayID());assert((CACurrentMediaTime()-displayUpdate)*1000<150);
    for(unsigned i=0;i<200&&presenter.snapshot().completedReal==0;++i)idle(.005);const auto completed=presenter.snapshot();assert(completed.completedReal==1&&completed.maxPending==1&&completed.pending==0&&completed.reason.empty());
    id<CAMetalDrawable> drawable;@synchronized(layer){drawable=layer.lastDrawable;}assert(drawable);
    auto read=[queue commandBuffer];auto bytes=[device newBufferWithLength:256 options:MTLResourceStorageModeShared];auto copy=[read blitCommandEncoder];[copy copyFromTexture:drawable.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(8,8,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:bytes destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256];[copy endEncoding];[read commit];[read waitUntilCompleted];assert(read.status==MTLCommandBufferStatusCompleted);const auto pixel=static_cast<const unsigned char*>(bytes.contents);assert(pixel[0]==32&&pixel[1]==64&&pixel[2]==64&&pixel[3]==255);
    // Discarded buffers free the single flight without provider publication.
    @autoreleasepool{auto abandoned=[queue commandBuffer];assert(presenter.submitDisplayFrame(abandoned,source,++frame,CACurrentMediaTime(),true).encoded);}idle(.02);assert(presenter.snapshot().pending==0);
    auto cancelled=[queue commandBuffer];assert(presenter.submitDisplayFrame(cancelled,source,++frame,CACurrentMediaTime(),true).encoded);unsigned acquired;@synchronized(layer){acquired=layer.acquisitions;}presenter.stop();[cancelled commit];[cancelled waitUntilCompleted];idle(.04);@synchronized(layer){assert(layer.acquisitions==acquired);}assert(presenter.snapshot().stopped);
    // Resizing retains the last completed processed output, rather than
    // revealing the original publisher while a slow model prepares new targets.
    auto child=[[NSView alloc]initWithFrame:NSMakeRect(0,0,96,72)];[window.contentView addSubview:child];
    macfx::ViewPresentation fitted(child,32,24,{});
    uint64_t fittedFrame=0;auto first=encodeWhenReady(fitted,queue,source,fittedFrame);[first commit];[first waitUntilCompleted];
    const auto until=CACurrentMediaTime()+2;while(!fitted.snapshot().completedReal&&CACurrentMediaTime()<until)idle(.01);idle(.03);
    assert(fitted.snapshot().completedReal==1);NSView *processed=child.subviews.lastObject;assert(processed&&!processed.hidden);
    child.frame=NSMakeRect(0,0,120,90);fitted.update(child,64,48);assert(!processed.hidden);assert(CGRectEqualToRect(processed.frame,child.bounds));assert(fitted.outputSize().width==64&&fitted.outputSize().height==48);
    auto stale=encodeWhenReady(fitted,queue,source,fittedFrame);
    child.frame=NSMakeRect(0,0,128,96);fitted.update(child,96,72);[stale commit];[stale waitUntilCompleted];idle(.05);
    assert(!processed.hidden&&fitted.snapshot().completedReal==1);
    auto resized=encodeWhenReady(fitted,queue,source,fittedFrame);[resized commit];[resized waitUntilCompleted];
    const auto resizedUntil=CACurrentMediaTime()+2;while(fitted.snapshot().completedReal<2&&CACurrentMediaTime()<resizedUntil)idle(.01);
    assert(fitted.snapshot().completedReal==2&&!processed.hidden);assert(fitted.outputSize().width==96&&fitted.outputSize().height==72);fitted.stop();
    [window close];
    std::printf("Detached neural presentation: producer %.3fms before 300ms inference; retained source, bounded admission, completed pixels, abandonment and stop passed\n",producerMs);
}}
