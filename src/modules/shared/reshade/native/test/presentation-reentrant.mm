#include "presentation.hpp"
#include "presentation-ticket.hpp"
#import <Cocoa/Cocoa.h>
#include <atomic>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>

// This is an injected foreign-call/reentrancy test, not a screen fixture.
// Its real Metal texture is processed by FramePresenter, but its drawable
// reports only a negative terminal callback. It never fabricates display ACK.
@interface ReentrantDrawable : NSObject<CAMetalDrawable>
@property(strong) id<MTLTexture> texture;
@property(weak) CAMetalLayer *layer;
@property NSUInteger drawableID;
@property(copy) MTLDrawablePresentedHandler handler;
@property(copy) void(^query)(void);
@property BOOL throws;
@end
@implementation ReentrantDrawable
- (CFTimeInterval)presentedTime{return 0;}
- (void)addPresentedHandler:(MTLDrawablePresentedHandler)value{self.handler=value;}
- (void)present{
    self.query();
    if(self.handler)self.handler(self); // Negative retirement before return.
    self.query();
    if(self.throws)[NSException raise:@"InjectedPresentException" format:@"Injected foreign present failure"];
}
- (void)presentAtTime:(CFTimeInterval)time{(void)time;[self present];}
- (void)presentAfterMinimumDuration:(CFTimeInterval)time{(void)time;[self present];}
@end
@interface ReentrantLayer : CAMetalLayer
@property(copy) void(^query)(void);
@property BOOL throws;
@end
@implementation ReentrantLayer
- (id<CAMetalDrawable>)nextDrawable{
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:self.pixelFormat width:self.drawableSize.width height:self.drawableSize.height mipmapped:NO];
    descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    ReentrantDrawable *result=[ReentrantDrawable new];result.texture=[self.device newTextureWithDescriptor:descriptor];assert(result.texture);
    result.layer=self;result.query=self.query;result.throws=self.throws;return result;
}
@end
namespace {
void tickets(){
    macfx::PresentationTicket early;assert(early.reserve());assert(!early.completed());
    // A reentrant terminal callback cannot release a hold while present is
    // still executing. Call return performs that final retirement exactly once.
    assert(early.callReturned());assert(!early.completed()&&!early.callReturned()&&!early.reserve());
    macfx::PresentationTicket late;assert(late.reserve());assert(!late.callReturned());assert(late.completed());assert(!late.completed());
    macfx::PresentationTicket cancelled;assert(!cancelled.completed());assert(!cancelled.reserve());
    macfx::PresentationTicket thrown;assert(thrown.reserve());assert(!thrown.completed());assert(thrown.callReturned());assert(!thrown.completed());
}
void idle(){CFRunLoopRunInMode(kCFRunLoopDefaultMode,.005,false);}
}
int main(int argc,char **argv){@autoreleasepool{
    tickets();if(argc==2&&!std::strcmp(argv[1],"--tickets")){std::puts("Presentation tickets: terminal-before-return, return-before-terminal, cancellation and exception retirement");return 0;}
    setenv("RESHADE_EXPLICIT_HOST","1",1);unsetenv("RESHADE_EFFECT_PLAN");unsetenv("RESHADE_EFFECT");unsetenv("RESHADE_PRESENTATION_CONTROL_FILE");
    auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];assert(device&&queue);
    ReentrantLayer *layer=[ReentrantLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.drawableSize=CGSizeMake(32,24);
    int owner=0;macfx::FramePresenter presenter(layer,&owner);std::atomic<unsigned> queries{0};
    auto *current=&presenter;auto *queryCount=&queries;
    layer.query=^{const auto status=current->snapshot();assert(!status.stopped);assert(!current->presentationHeld());assert(!current->presentationHoldStatus().holding);++*queryCount;};
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:32 height:24 mipmapped:NO];
    descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto source=[device newTextureWithDescriptor:descriptor];assert(source);
    for(unsigned index=0;index<2;++index){layer.throws=index!=0;auto commands=[queue commandBuffer];
        assert(presenter.submit(commands,source,index+1,CACurrentMediaTime()).encoded);[commands commit];
        const auto until=CACurrentMediaTime()+3;
        while((queries.load()<(index+1)*2||commands.status<MTLCommandBufferStatusCompleted||index&&presenter.snapshot().reason.empty())&&CACurrentMediaTime()<until)idle();
        assert(queries.load()==(index+1)*2&&commands.status==MTLCommandBufferStatusCompleted);
        if(index)assert(presenter.snapshot().reason=="Injected foreign present failure");
        assert(!presenter.snapshot().stopped&&presenter.snapshot().presentedReal==0&&presenter.snapshot().lastPresentedFrame==0);
    }
    layer.query=nil;presenter.stop();std::puts("Actual FramePresenter: foreign present reenters snapshot/hold state before and after negative retirement; thrown present is contained; no physical display ACK");
}}
