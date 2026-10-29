#include "presentation.hpp"
#include "live-controls.hpp"
#include <fstream>
#import <Cocoa/Cocoa.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <memory>
#include <stdexcept>

static std::atomic<double> sharedPresentedTime{0};
@interface TimestampSample : NSObject
@property CFTimeInterval presentedTime;
@end
@implementation TimestampSample
@end
@interface TimestampDrawable : NSObject<CAMetalDrawable>
@property(strong) id<CAMetalDrawable> original;
@end
@implementation TimestampDrawable
- (id<MTLTexture>)texture {return self.original.texture;}
- (CAMetalLayer *)layer {return self.original.layer;}
- (NSUInteger)drawableID {return self.original.drawableID;}
- (CFTimeInterval)presentedTime {return std::getenv("RESHADE_TEST_PRESENTED_ZERO")?0:sharedPresentedTime.load();}
- (void)present {[self.original present];}
- (void)presentAtTime:(CFTimeInterval)time {[self.original presentAtTime:time];}
- (void)presentAfterMinimumDuration:(CFTimeInterval)duration {[self.original presentAfterMinimumDuration:duration];}
- (void)addPresentedHandler:(MTLDrawablePresentedHandler)handler {
    [self.original addPresentedHandler:^(id<MTLDrawable>value){double empty=0;if(value.presentedTime>0)sharedPresentedTime.compare_exchange_strong(empty,value.presentedTime);auto sample=[TimestampSample new];sample.presentedTime=std::getenv("RESHADE_TEST_PRESENTED_ZERO")?0:sharedPresentedTime.load();handler((id<MTLDrawable>)sample);}];
}
@end

@interface ObservedLayer : CAMetalLayer
@property(strong) id<CAMetalDrawable> lastDrawable;
@property NSUInteger acquisitions;
@end
@implementation ObservedLayer
- (id<CAMetalDrawable>)nextDrawable {
    id<CAMetalDrawable> value=[super nextDrawable];
    if(value&&(std::getenv("RESHADE_TEST_PRESENTED_ZERO")||std::getenv("RESHADE_TEST_PRESENTED_DUPLICATE"))){auto wrapped=[TimestampDrawable new];wrapped.original=value;value=wrapped;}
    @synchronized(self) { self.lastDrawable=value; if(value)++self.acquisitions; }
    return value;
}
@end

static void idle(double seconds) {
    auto deadline=[NSDate dateWithTimeIntervalSinceNow:seconds];
    while(deadline.timeIntervalSinceNow>0)
        CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.005,false);
}
static void require(bool value,const char *message) {
    if(!value) throw std::runtime_error(message);
}
static id<MTLTexture> sourceTexture(id<MTLDevice> device,unsigned width,unsigned height) {
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:width height:height mipmapped:NO];
    descriptor.storageMode=MTLStorageModePrivate;
    descriptor.usage=MTLTextureUsageRenderTarget|MTLTextureUsageShaderRead;
    return [device newTextureWithDescriptor:descriptor];
}
static void verifyPixel(ObservedLayer *layer,id<MTLCommandQueue> queue,bool effect,MTLClearColor color) {
    id<CAMetalDrawable> drawable;
    @synchronized(layer) { drawable=layer.lastDrawable; }
    require(drawable!=nil,"No real drawable was acquired");
    auto commands=[queue commandBuffer];
    auto bytes=[queue.device newBufferWithLength:256 options:MTLResourceStorageModeShared];
    auto copy=[commands blitCommandEncoder];
    [copy copyFromTexture:drawable.texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(16,16,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:bytes destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256];
    [copy endEncoding];[commands commit];[commands waitUntilCompleted];
    require(commands.status==MTLCommandBufferStatusCompleted,"Presented texture readback failed");
    auto pixel=static_cast<unsigned char *>(bytes.contents);
    const auto channel=[effect](double value){return unsigned(lround((effect?(1-value)*.5:value)*255));};
    const unsigned expected[]={channel(color.blue),channel(color.green),channel(color.red),255};
    for(unsigned i=0;i<4;++i) if(abs(int(pixel[i])-int(expected[i]))>3)
        throw std::runtime_error("Presented pixel differs on channel "+std::to_string(i)+": "+std::to_string(pixel[i]));
}

int main(int argc,char **argv) { @autoreleasepool { try {
    [NSApplication sharedApplication];
    const bool live=argc>1&&std::string(argv[1])=="live";
    const bool generation=live||(argc>1&&std::string(argv[1])=="generation");
    const bool effect=getenv("RESHADE_EFFECT")!=nullptr;
    auto device=MTLCreateSystemDefaultDevice();require(device!=nil,"No Metal device");
    auto queue=[device newCommandQueue];
    std::array<unsigned char,2048>barBytes;barBytes.fill(255);auto bar=[device newBufferWithBytes:barBytes.data() length:barBytes.size() options:MTLResourceStorageModeShared];
    auto window=[[NSWindow alloc]initWithContentRect:NSMakeRect(40,100,256,160) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.title=@"Frame presentation";window.level=NSFloatingWindowLevel;
    auto layer=[ObservedLayer layer];layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;
    window.contentView.wantsLayer=YES;window.contentView.layer=layer;
    layer.drawableSize=CGSizeMake(192,128);[window orderFront:nil];[window display];idle(.05);
    macfx::PresenterConfig config;config.method=macfx::SpatialMethod::MetalFX;
    if(generation&&!live) {
        require(argc>2,"A local model path is required");
        macfx::LsfgConfig graph;graph.modelPath=argv[2];graph.performance=true;graph.multiplier=3;
        config.generation=graph;if(!std::getenv("RESHADE_TEST_FIXED_PACING"))config.adaptive=macfx::AdaptivePacingConfig{60,3,60};
    }
    int owner=0;macfx::FramePresenter presenter(layer,&owner,config);
    unsigned checks=0;uint64_t frameId=0;
    if(generation&&!live){
        auto abandonedSource=sourceTexture(device,96,64);
        @autoreleasepool{
        auto transparent=[queue commandBuffer];const auto rejectedTime=CACurrentMediaTime();
        const auto before=presenter.snapshot();const auto rejected=presenter.submitDisplayFrame(transparent,abandonedSource,frameId+1,rejectedTime,false);
        require(!rejected.encoded&&!rejected.busy&&rejected.reason=="The selected frame generator requires an opaque source image",(std::string("Explicit transparent input reached frame generation: ")+rejected.reason).c_str());
        require(transparent.status<MTLCommandBufferStatusCommitted&&presenter.snapshot().encoded==before.encoded&&presenter.snapshot().pending==before.pending,"Rejected transparent input acquired GPU ownership");
        // Spatial resources prepare off the frame path. A frame declined while
        // they prepare records no identity, so the same frame is offered again.
        auto opaque=[queue commandBuffer];auto accepted=presenter.submitDisplayFrame(opaque,abandonedSource,frameId+1,rejectedTime,true);
        for(const auto preparation=CACurrentMediaTime()+5;!accepted.encoded&&accepted.busy&&accepted.reason=="Preparing spatial output"&&CACurrentMediaTime()<preparation;){
            [opaque commit];[opaque waitUntilCompleted];idle(.01);opaque=[queue commandBuffer];accepted=presenter.submitDisplayFrame(opaque,abandonedSource,frameId+1,rejectedTime,true);}
        ++frameId;
        require(accepted.encoded,(std::string("Rejected transparent input reserved its frame identity: ")+accepted.reason).c_str());++checks;
        }
        for(unsigned attempt=0;attempt<6;++attempt){@autoreleasepool{auto commands=[queue commandBuffer];const auto result=presenter.submit(commands,abandonedSource,++frameId,CACurrentMediaTime());require(result.encoded,"Abandoned adaptive submission retained capacity");++checks;}}
        require(presenter.snapshot().reason.empty(),"Discarded producer became a persistent presentation error");
        require(presenter.snapshot().adaptive.sourceObservations==0,"An unsubmitted producer was counted as observed source cadence");
        @autoreleasepool{NSMutableArray*held=[NSMutableArray new];for(unsigned attempt=0;attempt<1;++attempt){auto commands=[queue commandBuffer];const auto result=presenter.submit(commands,abandonedSource,++frameId,CACurrentMediaTime());require(result.encoded,"Could not fill bounded adaptive capacity");[held addObject:commands];++checks;}auto fifth=[queue commandBuffer];auto rejected=presenter.submit(fifth,abandonedSource,frameId+1,CACurrentMediaTime());require(!rejected.encoded&&rejected.busy,"Adaptive capacity was unbounded");[held removeAllObjects];held=nil;++checks;}
        require(presenter.snapshot().reason.empty()&&presenter.snapshot().adaptive.sourceObservations==0,"Capacity cancellation retained error/cadence state");
    }
    for(unsigned phase=0;phase<(live?4u:2u);++phase) {
        const bool active=generation&&(!live||phase%2==1);
        if(live){
            // The model and control paths are launch settings.
            require(argc>2&&getenv("RESHADE_CONTROL_FILE")&&getenv("RESHADE_LIVE_EFFECTS")&&getenv("RESHADE_LOSSLESS_MODEL")&&std::string(getenv("RESHADE_LOSSLESS_MODEL"))==argv[2],
                "Live test needs model and control paths at launch");
            macfx::LivePacket p{};memcpy(p.magic,"MLFXCTL2",8);p.targetHz=60;p.multiplier=phase==3?4:3;p.flags=active?(phase==3?3:1):0;p.spatial=2;p.lsfgMode=3;p.flowScale=.5;
            const std::string file=getenv("RESHADE_CONTROL_FILE"),tmp=file+".tmp";{std::ofstream out(tmp,std::ios::binary);out.write(reinterpret_cast<const char*>(&p),sizeof(p));}
            require(rename(tmp.c_str(),file.c_str())==0,"Control publication failed");idle(.12);
        }
        const auto generatedBefore=presenter.snapshot().presentedGenerated;
        const unsigned width=phase?256:192,height=phase?160:128;
        layer.drawableSize=CGSizeMake(width,height);
        auto source=sourceTexture(device,width/2,height/2);
        MTLClearColor color=MTLClearColorMake(.2,.4,.6,1);
        // Spatial resources for a new size are prepared off the frame path.
        // Until they are ready, a frame is declined as busy and not presented.
        const auto preparation=CACurrentMediaTime()+5;
        for(unsigned frame=0;frame<(generation?64u:8u);++frame) {
            if(!generation)color=MTLClearColorMake(.1+.1*(frame%7),.2+.05*(frame%5),.4+.04*(frame%6),1);
            auto commands=[queue commandBuffer];auto pass=[MTLRenderPassDescriptor renderPassDescriptor];
            pass.colorAttachments[0].texture=source;pass.colorAttachments[0].loadAction=MTLLoadActionClear;
            pass.colorAttachments[0].storeAction=MTLStoreActionStore;pass.colorAttachments[0].clearColor=color;
            [[commands renderCommandEncoderWithDescriptor:pass]endEncoding];
            if(generation){auto copy=[commands blitCommandEncoder];[copy copyFromBuffer:bar sourceOffset:0 sourceBytesPerRow:256 sourceBytesPerImage:2048 sourceSize:MTLSizeMake(16,8,1) toTexture:source destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(8+(frame*2)%(width/2-24),height/4,0)];[copy endEncoding];}
            // Dropped game submissions may leave gaps; accepted model history must survive.
            frameId+=2;
            const auto timestamp=CACurrentMediaTime();
            NSUInteger acquisitions;@synchronized(layer){acquisitions=layer.acquisitions;}
            auto result=presenter.submit(commands,source,++frameId,timestamp);
            if(!result.encoded&&result.busy&&result.reason=="Preparing spatial output"){
                require(CACurrentMediaTime()<preparation,"Spatial output preparation did not finish");
                require(commands.status<MTLCommandBufferStatusCommitted,"Presenter committed a declined producer buffer");
                [commands commit];[commands waitUntilCompleted];idle(.01);--frame;continue;
            }
            require(result.encoded,result.reason.c_str());require(result.scaled,"Spatial processing was bypassed");
            require(result.effects==effect,"Unexpected effect state");
            require(commands.status<MTLCommandBufferStatusCommitted,"Presenter committed the producer buffer");
            if(!active){@synchronized(layer){require(layer.acquisitions==acquisitions+1,"Current-frame output was deferred to a completion callback");}}
            auto duplicate=presenter.submit(commands,source,frameId,timestamp);
            require(!duplicate.encoded,"Duplicate frame was accepted");
            [commands commit];[commands waitUntilCompleted];
            require(commands.status==MTLCommandBufferStatusCompleted,"Producer GPU work failed");
            if(!generation){verifyPixel(layer,queue,effect,color);++checks;}
            idle(generation?.04:.025);++checks;
        }
        idle(.2);verifyPixel(layer,queue,effect,color);++checks;
        if(generation){const auto phaseStatus=presenter.snapshot();const auto &adaptive=phaseStatus.adaptive;
            std::fprintf(stderr,"Presentation phase=%u real=%llu generated=%llu dropped=%llu adaptiveSources=%llu requested=%llu admitted=%llu adaptiveReal=%llu adaptiveGenerated=%llu rejectedTimes=%llu sourceHz=%.3f displayHz=%.3f\n",phase,
                (unsigned long long)phaseStatus.presentedReal,(unsigned long long)phaseStatus.presentedGenerated,(unsigned long long)phaseStatus.dropped,
                (unsigned long long)adaptive.sourceObservations,(unsigned long long)adaptive.requestedGenerated,(unsigned long long)adaptive.admittedGenerated,
                (unsigned long long)adaptive.presentedReal,(unsigned long long)adaptive.presentedGenerated,(unsigned long long)adaptive.rejectedDisplayTimes,adaptive.observedSourceHz,adaptive.observedPresentationHz);
        }
        if(live){const auto status=presenter.snapshot();
            require(active?status.presentedGenerated>generatedBefore:status.presentedGenerated==generatedBefore,active?"Live generation did not reach the display":"Disabled generation still presented synthetic frames");
            printf("Live phase=%u active=%d generated=%llu real=%llu\n",phase,active,(unsigned long long)status.presentedGenerated,(unsigned long long)status.presentedReal);
        }
    }
    auto status=presenter.snapshot();
    require(status.completedReal>0,"No final real frame completed on the GPU");
    if(std::getenv("RESHADE_TEST_PRESENTED_ZERO")){require(status.presentedReal==0&&status.presentedGenerated==0&&status.lastPresentedFrame==0,"Zero-time callbacks were counted as display presentations");require(status.dropped>=status.encoded,"Zero-time presentations were not counted as dropped");}
    else if(std::getenv("RESHADE_TEST_PRESENTED_DUPLICATE")){require(status.presentedReal==1,"Duplicate display timestamps were counted more than once");require(status.dropped>=status.encoded-1,"Duplicate presentations were not counted as dropped");}
    else require(status.presentedReal>0,"No real frame reached display presentation");
    require(status.reason.empty(),status.reason.c_str());
    require(status.maxPending<=4,"Presentation queue exceeded its fixed bound");
    if(!std::getenv("RESHADE_TEST_PRESENTED_ZERO"))require(status.lastPresentedFrame>0,"No presented frame identity");
    if(generation) require(status.presentedGenerated>0,"No generated frame reached display presentation");
    else require(status.presentedGenerated==0,"Effects-only mode generated frames");
    if(config.adaptive||live){require(status.adaptive.sourceObservations>0,"No real source cadence observed");require(status.adaptive.presentedGenerated>0,"No adaptive generated frame had a positive display timestamp");}else require(status.adaptive.sourceObservations==0,"Fixed pacing observed an adaptive policy");
    presenter.stop();require(presenter.snapshot().stopped,"Presenter did not stop");
    auto rejected=presenter.submit([queue commandBuffer],sourceTexture(device,64,64),++frameId,CACurrentMediaTime());
    require(!rejected.encoded,"Stopped presenter accepted work");idle(.05);
    [window close];
    printf("Presentation checks=%u real=%llu generated=%llu maxPending=%u dropped=%llu latencyMs=%.3f device=%s\n",checks,(unsigned long long)status.presentedReal,(unsigned long long)status.presentedGenerated,status.maxPending,(unsigned long long)status.dropped,status.lastLatencyMs,device.name.UTF8String);
    printf("Adaptive sourceObservations=%llu requested=%llu admitted=%llu observedSourceHz=%.3f observedPresentationHz=%.3f\n",(unsigned long long)status.adaptive.sourceObservations,(unsigned long long)status.adaptive.requestedGenerated,(unsigned long long)status.adaptive.admittedGenerated,status.adaptive.observedSourceHz,status.adaptive.observedPresentationHz);
    return 0;
} catch(const std::exception &error) { fprintf(stderr,"%s\n",error.what());return 1; } } }
