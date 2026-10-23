// Copyright (c) MacLauncher contributors. MIT license.
// Instrument the actual presenter with a private class name; the linked core
// supplies unchanged dependencies without duplicate presenter definitions.
#define FramePresenter LifecycleRacePresenter
#ifndef MACFX_PRESENTATION_LIFECYCLE_SOURCE
#define MACFX_PRESENTATION_LIFECYCLE_SOURCE <presentation.mm>
#endif
#include MACFX_PRESENTATION_LIFECYCLE_SOURCE
#include <cassert>
#include <cstdio>
#include <thread>

namespace {id lifecycleDevice;std::atomic<unsigned> lifecycleQueues{0};}
@interface LifecycleDevice:NSObject @end
@implementation LifecycleDevice
- (id)newCommandQueue{++lifecycleQueues;return nil;}
@end
@interface LifecycleLayer:CAMetalLayer
@property(copy) void(^query)(void);
@end
@implementation LifecycleLayer
- (id<MTLDevice>)device{return (id<MTLDevice>)lifecycleDevice;}
- (CGSize)drawableSize{if(self.query)self.query();return [super drawableSize];}
@end

int main(){@autoreleasepool{
    setenv("RESHADE_EXPLICIT_HOST","1",1);
    for(const char *name:{"RESHADE_EFFECT_PLAN","RESHADE_EFFECT","RESHADE_CONTROL_FILE",
        "RESHADE_PRESENTATION_CONTROL_FILE","RESHADE_RUNTIME_STATUS_FILE","RESHADE_FRAME_GENERATION"})unsetenv(name);
    lifecycleDevice=[LifecycleDevice new];
    for(unsigned round=0;round<100;++round){
        LifecycleLayer *layer=[LifecycleLayer layer];layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.drawableSize=CGSizeMake(32,24);
        int owner=0;macfx::LifecycleRacePresenter current(layer,&owner);
        std::atomic<unsigned>reads{0};std::atomic<bool>finish{false};
        auto *active=&current;layer.query=^{(void)active->snapshot();};
        std::thread reader([&]{@autoreleasepool{while(!finish.load()){
            (void)current.presentationHoldStatus();(void)current.completedFrameReplayReady();++reads;
        }}});
        while(reads.load()<8)std::this_thread::yield();
        current.stop();finish=true;reader.join();layer.query=nil;
        assert(current.snapshot().stopped&&!current.completedFrameReplayReady()&&!current.presentationHoldStatus().holding);
    }
    assert(lifecycleQueues==0);
    std::puts("Actual presenter lifecycle CPU: concurrent state queries and Stop; reentrant layer getter; no command buffers, Metal queues, GPU or windows");
}}
