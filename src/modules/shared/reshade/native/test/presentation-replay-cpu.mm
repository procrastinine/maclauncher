// Controlled callbacks through the real presenter; no Metal device, GPU or window.
#include "presentation.hpp"
#import <Foundation/Foundation.h>
#include <cassert>
#include <atomic>
#include <cstdio>
#include <unistd.h>
namespace {id cpuDevice;std::atomic<unsigned> copies{0},presents{0},drawables{0};}
@interface CPUReplayTexture:NSObject
@property NSUInteger width,height;
@property MTLPixelFormat pixelFormat;
@end
@implementation CPUReplayTexture
- (id)device{return cpuDevice;}
- (NSUInteger)allocatedSize{return self.width*self.height*4;}
- (MTLTextureType)textureType{return MTLTextureType2D;}
- (NSUInteger)sampleCount{return 1;}
- (BOOL)isFramebufferOnly{return NO;}
- (MTLTextureUsage)usage{return MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;}
@end
@interface CPUReplayBlit:NSObject @end
@implementation CPUReplayBlit
- (void)copyFromTexture:(id)a sourceSlice:(NSUInteger)b sourceLevel:(NSUInteger)c sourceOrigin:(MTLOrigin)d sourceSize:(MTLSize)e toTexture:(id)f destinationSlice:(NSUInteger)g destinationLevel:(NSUInteger)h destinationOrigin:(MTLOrigin)i{(void)a;(void)b;(void)c;(void)d;(void)e;(void)f;(void)g;(void)h;(void)i;++copies;}
- (void)endEncoding{}
@end
@interface CPUReplayCommands:NSObject
@property MTLCommandBufferStatus status;
@property(strong)id queue;
@property(strong)NSMutableArray *scheduled,*completed;
@end
@implementation CPUReplayCommands
- (instancetype)init{if((self=[super init])){_scheduled=[NSMutableArray new];_completed=[NSMutableArray new];}return self;}
- (NSTimeInterval)GPUStartTime{return 0;}
- (NSTimeInterval)GPUEndTime{return 0;}
- (BOOL)retainedReferences{return YES;}
- (id)device{return cpuDevice;}
- (id)commandQueue{return self.queue;}
- (id)blitCommandEncoder{return [CPUReplayBlit new];}
- (void)addCompletedHandler:(MTLCommandBufferHandler)handler{[self.completed addObject:[handler copy]];}
- (void)addScheduledHandler:(MTLCommandBufferHandler)handler{[self.scheduled addObject:[handler copy]];}
- (void)commit{
 self.status=MTLCommandBufferStatusScheduled;NSArray *scheduled=[self.scheduled copy];[self.scheduled removeAllObjects];
 for(MTLCommandBufferHandler handler in scheduled)handler((id<MTLCommandBuffer>)self);
 self.status=MTLCommandBufferStatusCompleted;NSArray *completed=[self.completed copy];[self.completed removeAllObjects];
 for(MTLCommandBufferHandler handler in completed)handler((id<MTLCommandBuffer>)self);
}
@end
@interface CPUReplayQueue:NSObject @end
@implementation CPUReplayQueue
- (id)commandBuffer{auto commands=[CPUReplayCommands new];commands.queue=self;return commands;}
@end
@interface CPUReplayDevice:NSObject @end
@implementation CPUReplayDevice
- (id)newCommandQueue{return [CPUReplayQueue new];}
- (NSUInteger)recommendedMaxWorkingSetSize{return 64u<<20;}
- (NSUInteger)currentAllocatedSize{return 0;}
- (MTLSizeAndAlign)heapTextureSizeAndAlignWithDescriptor:(MTLTextureDescriptor*)descriptor{return {descriptor.width*descriptor.height*4,256};}
- (id)newTextureWithDescriptor:(MTLTextureDescriptor*)descriptor{auto image=[CPUReplayTexture new];image.width=descriptor.width;image.height=descriptor.height;image.pixelFormat=descriptor.pixelFormat;return image;}
@end
@interface CPUReplayDrawable:NSObject
@property(strong)id texture;
@property(strong)NSMutableArray *handlers;
@property double presentedTime;
@end
@implementation CPUReplayDrawable
- (void)addPresentedHandler:(MTLDrawablePresentedHandler)handler{[self.handlers addObject:[handler copy]];}
- (void)present{self.presentedTime=++presents==1?0:1;NSArray *handlers=[self.handlers copy];[self.handlers removeAllObjects];for(MTLDrawablePresentedHandler handler in handlers)handler((id<MTLDrawable>)self);}
- (void)presentAtTime:(double)value{(void)value;[self present];}
@end
@interface CPUReplayLayer:CAMetalLayer @end
@implementation CPUReplayLayer
// One controlled admission slot: a leaked first drawable would refuse replay.
- (NSUInteger)maximumDrawableCount{return 1;}
- (id<MTLDevice>)device{return (id<MTLDevice>)cpuDevice;}
- (id<CAMetalDrawable>)nextDrawable{++drawables;auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:self.pixelFormat width:self.drawableSize.width height:self.drawableSize.height mipmapped:NO];auto value=[CPUReplayDrawable new];value.texture=[cpuDevice newTextureWithDescriptor:descriptor];value.handlers=[NSMutableArray new];return (id<CAMetalDrawable>)value;}
@end
int main(){@autoreleasepool{
 setenv("RESHADE_EXPLICIT_HOST","1",1);for(const auto name:{"RESHADE_EFFECT","RESHADE_EFFECT_PLAN","RESHADE_CONTROL_FILE","RESHADE_LIVE_EFFECTS","RESHADE_PRESENTATION_CONTROL_FILE"})unsetenv(name);
 cpuDevice=[CPUReplayDevice new];auto layer=[CPUReplayLayer layer];layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.drawableSize=CGSizeMake(32,24);
 auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:layer.pixelFormat width:32 height:24 mipmapped:NO];auto source=(id<MTLTexture>)[cpuDevice newTextureWithDescriptor:descriptor];
 int owner=0;macfx::FramePresenter presenter(layer,&owner);presenter.retainCompletedFrameForReplay(true);auto commands=[CPUReplayCommands new];
 assert(presenter.submit((id<MTLCommandBuffer>)commands,source,1,CACurrentMediaTime()).encoded);[commands commit];
 auto status=presenter.snapshot();assert(presents==1&&status.dropped==1&&status.presentedReal==0&&status.lastPresentedFrame==0&&status.completedReal==1&&presenter.completedFrameReplayReady());
 assert(presenter.replayCompletedFrame());const auto until=CACurrentMediaTime()+1;
 while(presenter.snapshot().lastPresentedFrame!=1&&CACurrentMediaTime()<until)usleep(1000);
 status=presenter.snapshot();fprintf(stderr,"CPU replay: drawables=%u presents=%u completed=%llu real=%llu dropped=%llu frame=%llu reason=%s\n",drawables.load(),presents.load(),status.completedReal,status.presentedReal,status.dropped,status.lastPresentedFrame,status.reason.c_str());
 assert(presents==2&&drawables==2&&status.presentedReal==1&&status.lastPresentedFrame==1&&status.dropped==1&&status.submitted==1&&status.completedReal==1&&status.presentedGenerated==0);presenter.stop();
 puts("Controlled presenter: first drawable dropped, one completed-image replay presented with original identity; no GPU or physical display proof");
}}
