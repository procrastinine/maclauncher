// Copyright (c) MacLauncher contributors. MIT license.
#include "presentation.hpp"
#include "view-presentation.hpp"
#include "color-contract.hpp"
#import <Cocoa/Cocoa.h>
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>

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
    auto first=[queue commandBuffer];assert(accepted->submitDisplayFrame(first,input,1,CACurrentMediaTime(),true).encoded);complete(accepted,first,oldOverlay);
    for(CGColorSpaceRef color:{p3,srgb}){
        const auto previous=accepted;const auto previousColor=oldLayer.colorspace;
        auto candidate=std::make_shared<macfx::ViewPresentation>(source,96,72,macfx::PresenterConfig{},color,previous);
        NSView *newOverlay=source.subviews.lastObject;CAMetalLayer *newLayer=(CAMetalLayer*)newOverlay.layer;
        assert(newOverlay!=oldOverlay&&newOverlay.hidden&&!oldOverlay.hidden&&candidate->colorSpaceMatches(color));
        assert(macfx::sameImageColorSpace(newLayer.colorspace,color)&&macfx::sameImageColorSpace(oldLayer.colorspace,previousColor));
        auto commands=[queue commandBuffer];assert(candidate->submitDisplayFrame(commands,input,1,CACurrentMediaTime(),true).encoded);
        assert(commands.status<MTLCommandBufferStatusCommitted&&!oldOverlay.hidden&&newOverlay.hidden);
        assert(macfx::sameImageColorSpace(oldLayer.colorspace,previousColor));complete(candidate,commands,newOverlay);
        assert(!oldOverlay.superview&&previous->snapshot().stopped&&macfx::sameImageColorSpace(oldLayer.colorspace,previousColor));
        assert(candidate->colorSpaceMatches(color)&&source.layer==publisher&&NSEqualRects(source.frame,sourceFrame));
        accepted=candidate;oldOverlay=newOverlay;oldLayer=newLayer;
    }
    accepted->stop();assert(source.subviews.count==0&&source.layer==publisher);[window orderOut:nil];[window close];CFRelease(srgb);CFRelease(p3);
    std::puts("Actual owned AppKit CAMetalLayer: completed Metal sRGB/P3/sRGB replacements preserved the prior image tag until completion, retired previous overlays, kept publisher layer/frame; background window, tag wiring only, no display colour-conversion claim");return 0;
}
int main(int argc,char **argv){@autoreleasepool{
    if(argc==2&&!std::strcmp(argv[1],"--color-contract"))return ownedColorContract();
#if !defined(__arm64__)
    std::puts("Neural rendering requires Apple Silicon");return 77;
#endif
    if(@available(macOS 14.0,*)){}else return 77;
    assert(argc==2);setenv("RESHADE_NEURAL_LIBRARY",argv[1],1);setenv("MACLAUNCHER_TEST_NEURAL_DELAY_MS","300",1);
    [NSApplication sharedApplication];auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    NSString *plan=[NSTemporaryDirectory() stringByAppendingPathComponent:[@"neural-presentation-" stringByAppendingString:NSUUID.UUID.UUIDString]];
    const auto document=@{@"schema":@1,@"mode":@"advanced",@"revision":[@"" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0],@"nodes":@[@{@"id":@"neural",@"kind":@"neural",@"enabled":@YES,@"method":@"mlx-dlss",@"modelPath":@"/test/local-model",@"settings":@{@"intensity":@0.25,@"temporal":@NO}}]};
    assert([[NSJSONSerialization dataWithJSONObject:document options:0 error:nil]writeToFile:plan atomically:YES]);setenv("RESHADE_EFFECT_PLAN",plan.fileSystemRepresentation,1);
    auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(80,100,128,96) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;window.title=@"Neural presentation";
    auto layer=[NeuralObservedLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.displaySyncEnabled=YES;
    window.contentView.wantsLayer=YES;window.contentView.layer=layer;[window orderFront:nil];idle(.05);layer.drawableSize=CGSizeMake(32,24);
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:32 height:24 mipmapped:NO];descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
    auto source=[device newTextureWithDescriptor:descriptor];std::array<unsigned char,32*24*4> input;for(unsigned i=0;i<input.size();i+=4){input[i]=32;input[i+1]=80;input[i+2]=140;input[i+3]=255;}
    [source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:input.data() bytesPerRow:128];int owner=0;macfx::FramePresenter presenter(layer,&owner);
    auto commands=[queue commandBuffer];const auto start=CACurrentMediaTime();auto result=presenter.submitDisplayFrame(commands,source,1,start,true);assert(result.encoded&&result.effects&&commands.status<MTLCommandBufferStatusCommitted);
    const auto submitted=CACurrentMediaTime();[commands commit];[commands waitUntilCompleted];const auto producerMs=(CACurrentMediaTime()-submitted)*1000;
    assert(commands.status==MTLCommandBufferStatusCompleted&&producerMs<150&&presenter.snapshot().completedReal==0);
    std::fprintf(stderr,"Producer complete %.3fms pending=%u elapsed=%.3fms\n",producerMs,presenter.snapshot().pending,(CACurrentMediaTime()-start)*1000);
    // Mutating the publisher after its copy must not alter the admitted frame.
    input.fill(220);[source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:input.data() bytesPerRow:128];
    std::fprintf(stderr,"Publisher mutation complete pending=%u elapsed=%.3fms\n",presenter.snapshot().pending,(CACurrentMediaTime()-start)*1000);
    for(unsigned i=2;i<10;++i){auto busy=[queue commandBuffer];const auto submittedAt=CACurrentMediaTime();const auto skipped=presenter.submitDisplayFrame(busy,source,i,submittedAt,true);const auto wallMs=(CACurrentMediaTime()-submittedAt)*1000;if(skipped.encoded||!skipped.busy)std::fprintf(stderr,"Busy attempt %u encoded=%d busy=%d reason=%s\n",i,skipped.encoded,skipped.busy,skipped.reason.c_str());assert(!skipped.encoded&&skipped.busy&&busy.status<MTLCommandBufferStatusCommitted&&wallMs<150);}
    const auto displayUpdate=CACurrentMediaTime();presenter.setDisplay(CGMainDisplayID());assert((CACurrentMediaTime()-displayUpdate)*1000<150);
    for(unsigned i=0;i<200&&presenter.snapshot().completedReal==0;++i)idle(.005);const auto completed=presenter.snapshot();assert(completed.completedReal==1&&completed.maxPending==1&&completed.pending==0&&completed.reason.empty());
    id<CAMetalDrawable> drawable;@synchronized(layer){drawable=layer.lastDrawable;}assert(drawable);
    auto read=[queue commandBuffer];auto bytes=[device newBufferWithLength:256 options:MTLResourceStorageModeShared];auto copy=[read blitCommandEncoder];[copy copyFromTexture:drawable.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(8,8,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:bytes destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256];[copy endEncoding];[read commit];[read waitUntilCompleted];assert(read.status==MTLCommandBufferStatusCompleted);const auto pixel=static_cast<const unsigned char*>(bytes.contents);assert(pixel[0]==32&&pixel[1]==64&&pixel[2]==64&&pixel[3]==255);
    // Discarded buffers free the single flight without provider publication.
    @autoreleasepool{auto abandoned=[queue commandBuffer];assert(presenter.submitDisplayFrame(abandoned,source,10,CACurrentMediaTime(),true).encoded);}idle(.02);assert(presenter.snapshot().pending==0);
    auto cancelled=[queue commandBuffer];assert(presenter.submitDisplayFrame(cancelled,source,11,CACurrentMediaTime(),true).encoded);unsigned acquired;@synchronized(layer){acquired=layer.acquisitions;}presenter.stop();[cancelled commit];[cancelled waitUntilCompleted];idle(.04);@synchronized(layer){assert(layer.acquisitions==acquired);}assert(presenter.snapshot().stopped);
    // Resizing retains the last completed processed output, rather than
    // revealing the original publisher while a slow model prepares new targets.
    auto child=[[NSView alloc]initWithFrame:NSMakeRect(0,0,96,72)];[window.contentView addSubview:child];
    macfx::ViewPresentation fitted(child,32,24,{});
    auto first=[queue commandBuffer];assert(fitted.submitDisplayFrame(first,source,1,CACurrentMediaTime(),true).encoded);[first commit];[first waitUntilCompleted];
    const auto until=CACurrentMediaTime()+2;while(!fitted.snapshot().completedReal&&CACurrentMediaTime()<until)idle(.01);idle(.03);
    assert(fitted.snapshot().completedReal==1);NSView *processed=child.subviews.lastObject;assert(processed&&!processed.hidden);
    child.frame=NSMakeRect(0,0,120,90);fitted.update(child,64,48);assert(!processed.hidden);assert(CGRectEqualToRect(processed.frame,child.bounds));assert(fitted.outputSize().width==64&&fitted.outputSize().height==48);
    auto stale=[queue commandBuffer];assert(fitted.submitDisplayFrame(stale,source,2,CACurrentMediaTime(),true).encoded);
    child.frame=NSMakeRect(0,0,128,96);fitted.update(child,96,72);[stale commit];[stale waitUntilCompleted];idle(.05);
    assert(!processed.hidden&&fitted.snapshot().completedReal==1);
    auto resized=[queue commandBuffer];assert(fitted.submitDisplayFrame(resized,source,3,CACurrentMediaTime(),true).encoded);[resized commit];[resized waitUntilCompleted];
    const auto resizedUntil=CACurrentMediaTime()+2;while(fitted.snapshot().completedReal<2&&CACurrentMediaTime()<resizedUntil)idle(.01);
    assert(fitted.snapshot().completedReal==2&&!processed.hidden);assert(fitted.outputSize().width==96&&fitted.outputSize().height==72);fitted.stop();
    unsetenv("RESHADE_EFFECT_PLAN");unsetenv("MACLAUNCHER_TEST_NEURAL_DELAY_MS");assert([NSFileManager.defaultManager removeItemAtPath:plan error:nil]);[window close];
    std::printf("Detached neural presentation: producer %.3fms before 300ms inference; retained source, bounded admission, completed pixels, abandonment and stop passed\n",producerMs);
}}
