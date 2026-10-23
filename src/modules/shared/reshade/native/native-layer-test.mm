#include "native-layer.h"
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#include <atomic>
#include <cstdio>
#include <stdexcept>
#include <initializer_list>

struct Consumer { id<MTLBuffer> bytes;id<MTLTexture> lastImage;void *lease=nullptr;std::atomic<unsigned> calls{0},completed{0}; };
static void require(bool result,const char *message){if(!result)throw std::runtime_error(message);}
static int consume(void *context,void *commands,void *image){
    auto &state=*static_cast<Consumer*>(context);
    auto buffer=(__bridge id<MTLCommandBuffer>)commands;auto texture=(__bridge id<MTLTexture>)image;
    require(buffer.status==MTLCommandBufferStatusNotEnqueued,"Producer command buffer was already submitted");
    auto retained=rsRetainNativeMetalSource(commands,image);require(retained,"Actual native source lease is unavailable");
    require(!state.lease||state.lastImage!=texture,"A retained drawable was recycled by the next producer");
    rsReleaseNativeMetalSource(state.lease);state.lease=retained;state.lastImage=texture;
    auto copy=[buffer blitCommandEncoder];
    [copy copyFromTexture:texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:state.bytes destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256];
    [copy endEncoding];++state.calls;
    auto pointer=&state;[buffer addCompletedHandler:^(id<MTLCommandBuffer>){++pointer->completed;}];
    return 1;
}
static void drain(){CFRunLoopRunInMode(kCFRunLoopDefaultMode,.01,false);}
int main(){@autoreleasepool{try{
    [NSApplication sharedApplication];auto device=MTLCreateSystemDefaultDevice();auto queue=[device newCommandQueue];
    Consumer state;state.bytes=[device newBufferWithLength:256 options:MTLResourceStorageModeShared];
    auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,128,128) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];window.releasedWhenClosed=NO;
    window.level=NSNormalWindowLevel-1;window.contentView.wantsLayer=YES;
    auto producer=[CAMetalLayer layer],other=[CAMetalLayer layer];
    for(auto layer:{producer,other}){layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.drawableSize=CGSizeMake(32,32);layer.frame=CGRectMake(0,0,64,64);[window.contentView.layer addSublayer:layer];}
    [window orderBack:nil];[window display];drain();
    require(rsRegisterNativeMetalLayer((__bridge void*)producer,consume,&state),"Native layer registration failed");
    require(rsRegisterNativeMetalLayer((__bridge void*)producer,consume,&state),"Repeated registration failed");
    for(unsigned phase=0;phase<3;++phase){
        if(phase==2)rsUnregisterNativeMetalLayer((__bridge void*)producer);
        for(auto layer:{other,producer}){@autoreleasepool{
            auto before=state.calls.load(),completed=state.completed.load();auto drawable=[layer nextDrawable];require(drawable!=nil,"No producer drawable");
            auto buffer=[queue commandBuffer];auto pass=[MTLRenderPassDescriptor renderPassDescriptor];auto color=pass.colorAttachments[0];color.texture=drawable.texture;color.loadAction=MTLLoadActionClear;color.storeAction=MTLStoreActionStore;color.clearColor=phase==2?MTLClearColorMake(0,0,1,1):MTLClearColorMake(.2,.4,.6,1);
            [[buffer renderCommandEncoderWithDescriptor:pass]endEncoding];
            if(phase==1)[buffer addScheduledHandler:^(id<MTLCommandBuffer>){[drawable present];}];else[buffer presentDrawable:drawable];
            [buffer commit];[buffer waitUntilCompleted];require(buffer.status==MTLCommandBufferStatusCompleted,"Producer failed");
            const bool accepted=layer==producer&&phase<2;
            for(unsigned retry=0;accepted&&state.completed==completed&&retry<200;++retry)drain();
            require(state.calls==before+(accepted?1:0),"Explicit layer selection or removal failed");
            if(accepted){require(state.completed>completed,"Frame consumer did not complete");auto bytes=static_cast<unsigned char*>(state.bytes.contents);require(abs(int(bytes[0])-153)<=1&&abs(int(bytes[1])-102)<=1&&abs(int(bytes[2])-51)<=1,"Consumer did not receive the completed producer image");}
        }}
    }
    rsUnregisterNativeMetalLayer((__bridge void*)producer);
    auto readback=[queue commandBuffer];auto copy=[readback blitCommandEncoder];
    [copy copyFromTexture:state.lastImage sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:state.bytes destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256];[copy endEncoding];
    [readback commit];[readback waitUntilCompleted];auto retainedBytes=static_cast<unsigned char*>(state.bytes.contents);
    require(abs(int(retainedBytes[0])-153)<=1&&abs(int(retainedBytes[1])-102)<=1&&abs(int(retainedBytes[2])-51)<=1,"A later producer overwrote the retained native source");
    [window close];
    require(rsRetainNativeMetalSource(nullptr,(__bridge void*)state.lastImage)==nullptr,"Source lease escaped its callback scope");
    rsReleaseNativeMetalSource(state.lease);state.lease=nullptr;state.lastImage=nil;
    puts("Explicit native layer: direct/scheduled completed pixels, unrelated layer, repeated registration, source leases and removal passed");return 0;
}catch(const std::exception &error){fprintf(stderr,"%s\n",error.what());return 1;}}}
