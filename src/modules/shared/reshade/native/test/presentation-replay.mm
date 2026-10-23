#include "presentation.hpp"
#import <Foundation/Foundation.h>
#include <atomic>
#include <cassert>
#include <cstdio>
#include <vector>

// Real Metal copies with an injected drawable reporting only negative
// retirement. This proves immutable replay, never physical display success.
@interface ReplayDrawable:NSObject<CAMetalDrawable>
@property(strong) id<MTLTexture> texture;
@property(weak) CAMetalLayer *layer;
@property(nonatomic) NSUInteger drawableID;
@property(copy) MTLDrawablePresentedHandler handler;
@property(copy) void(^issued)(void);
@end
@implementation ReplayDrawable
- (CFTimeInterval)presentedTime{return 0;}
- (void)addPresentedHandler:(MTLDrawablePresentedHandler)value{self.handler=value;}
- (void)present{self.issued();if(self.handler)self.handler(self);}
- (void)presentAtTime:(CFTimeInterval)value{[self present];}
- (void)presentAfterMinimumDuration:(CFTimeInterval)value{[self present];}
@end
@interface ReplayLayer:CAMetalLayer
@property(strong) id<MTLTexture> mostRecent;
@property(copy) void(^issued)(void);
@end
@implementation ReplayLayer
- (id<CAMetalDrawable>)nextDrawable{
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:self.pixelFormat width:self.drawableSize.width height:self.drawableSize.height mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    ReplayDrawable *result=[ReplayDrawable new];result.texture=[self.device newTextureWithDescriptor:descriptor];assert(result.texture);
    result.layer=self;result.issued=self.issued;@synchronized(self){self.mostRecent=result.texture;}return result;
}
@end
static void idle(){CFRunLoopRunInMode(kCFRunLoopDefaultMode,.002,false);}
int main(){@autoreleasepool{
    setenv("RESHADE_EXPLICIT_HOST","1",1);unsetenv("RESHADE_EFFECT_PLAN");unsetenv("RESHADE_EFFECT");unsetenv("RESHADE_PRESENTATION_CONTROL_FILE");
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    ReplayLayer *layer=[ReplayLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.drawableSize=CGSizeMake(32,24);
    int owner=0;macfx::PresenterConfig config;config.flipY=true;
    macfx::FramePresenter presenter(layer,&owner,config);std::atomic<unsigned>issued{0};auto *counter=&issued;layer.issued=^{++*counter;};
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:32 height:24 mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto source=[device newTextureWithDescriptor:descriptor];assert(source);
    std::vector<uint32_t>original(32*24);for(unsigned y=0;y<24;++y)for(unsigned x=0;x<32;++x)original[y*32+x]=0xff000000u|(x*7u<<16)|(y*9u<<8)|(x+y);
    [source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:original.data() bytesPerRow:32*4];
    assert(!presenter.replayCompletedFrame()&&!presenter.completedFrameReplayReady()&&presenter.lastRealCompletedFrameId()==0);presenter.retainCompletedFrameForReplay(true);
    auto commands=[queue commandBuffer];assert(presenter.submit(commands,source,17,CACurrentMediaTime()).encoded);[commands commit];
    double deadline=CACurrentMediaTime()+3;bool replay=false;
    while(!(replay=presenter.replayCompletedFrame())&&CACurrentMediaTime()<deadline)idle();assert(replay&&presenter.completedFrameReplayReady());
    while(issued.load()<2&&CACurrentMediaTime()<deadline)idle();assert(issued.load()>=2);
    while(presenter.lastRealCompletedFrameId()!=17&&CACurrentMediaTime()<deadline)idle();assert(presenter.lastRealCompletedFrameId()==17);
    id<MTLTexture> retained;@synchronized(layer){retained=layer.mostRecent;}assert(retained);
    // Replace the publisher after the original command's actual completion.
    // Replay must retain final pixels, never read this source again.
    assert(commands.status==MTLCommandBufferStatusCompleted);
    std::vector<uint32_t>changed(32*24,0xffaabbccu);[source replaceRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0 withBytes:changed.data() bytesPerRow:32*4];
    // Acceptance of another replay proves the prior replay GPU completion
    // released its sole pending slot. It retains the same immutable image/ID.
    replay=false;while(!(replay=presenter.replayCompletedFrame())&&CACurrentMediaTime()<deadline)idle();assert(replay);
    std::vector<uint32_t>actual(32*24),upright(32*24);for(unsigned y=0;y<24;++y)for(unsigned x=0;x<32;++x)upright[y*32+x]=original[(23-y)*32+x];
    [retained getBytes:actual.data() bytesPerRow:32*4 fromRegion:MTLRegionMake2D(0,0,32,24) mipmapLevel:0];assert(actual==upright);
    const auto status=presenter.snapshot();assert(status.encoded==1&&status.completedReal==1&&status.presentedGenerated==0&&status.presentedReal==0);
    assert(status.lastPresentedFrame==0&&presenter.lastRealPresentedTime()==0&&presenter.lastRealCompletedFrameId()==17&&status.reason.empty());
    presenter.retainCompletedFrameForReplay(false);assert(!presenter.replayCompletedFrame()&&!presenter.completedFrameReplayReady());presenter.stop();assert(!presenter.replayCompletedFrame());layer.issued=nil;
    std::puts("completed image replay: immutable pixels, original source identity, one pending GPU copy, unchanged source/completion/generation counts, negative retirement cannot prove visibility");
}}
