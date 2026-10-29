// Copyright (c) MacLauncher contributors. MIT license.
// A deterministic ABI provider for GPU ordering and lifetime checks.
#include "neural-provider.h"
#import <Metal/Metal.h>
#import <CoreVideo/CoreVideo.h>
#include <atomic>
#include <algorithm>
#include <memory>
#include <cstdio>
#include <cstdlib>
#include <cstring>
namespace {
std::atomic<unsigned> providers{0},submissions{0};
struct Provider {id<MTLDevice> device;id<MTLCommandQueue> queue;id<MTLComputePipelineState> kernel;float intensity=1;bool temporal=false,orientation=false;std::atomic<bool> busy{false};};
struct Frame {
    std::shared_ptr<Provider> provider;CVPixelBufferRef source,destination;
    id<MTLSharedEvent> event;MTLSharedEventListener *listener;uint64_t done;
    MLNeuralCompletion callback;void *context;std::atomic<bool> claimed{false};
    ~Frame(){CVPixelBufferRelease(source);CVPixelBufferRelease(destination);}
    void finish(int status,const char *reason){provider->busy=false;callback(context,status,reason);}
};
id<MTLTexture> texture(const std::shared_ptr<Provider>&p,CVPixelBufferRef image){
    auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:CVPixelBufferGetWidth(image) height:CVPixelBufferGetHeight(image) mipmapped:NO];
    d.storageMode=MTLStorageModeShared;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;
    return [p->device newTextureWithDescriptor:d iosurface:CVPixelBufferGetIOSurface(image) plane:0];
}
bool opaqueSource(CVPixelBufferRef image){
    if(CVPixelBufferLockBaseAddress(image,kCVPixelBufferLock_ReadOnly)!=kCVReturnSuccess)return false;
    auto *base=static_cast<const uint8_t*>(CVPixelBufferGetBaseAddress(image));const size_t row=CVPixelBufferGetBytesPerRow(image),width=CVPixelBufferGetWidth(image),height=CVPixelBufferGetHeight(image);
    bool result=base!=nullptr;for(size_t y=0;result&&y<height;++y)for(size_t x=0;result&&x<width;++x)result=base[y*row+x*4+3]==255;
    CVPixelBufferUnlockBaseAddress(image,kCVPixelBufferLock_ReadOnly);return result;
}
}
extern "C" MLNeuralProvider ml_neural_create_with_options(const char *path,float intensity,int temporal,char *error,size_t capacity){
    auto p=std::make_shared<Provider>();p->device=MTLCreateSystemDefaultDevice();p->queue=[p->device newCommandQueue];p->intensity=intensity;p->temporal=temporal;
    p->orientation=path&&!std::strcmp(path,"/test/orientation");
    NSError *failure=nil;auto library=[p->device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal;kernel void proof(texture2d<float,access::read> a [[texture(0)]],texture2d<float,access::write> b [[texture(1)]],constant float4 &options [[buffer(0)]],uint2 q [[thread_position_in_grid]]){if(q.x>=a.get_width()||q.y>=a.get_height())return;float4 v=a.read(q);if(options.z>.5){v.r=a.read(uint2(0,0)).r;v.g=float(q.y+1)/255;v.b=options.x==.5?v.a:a.read(uint2(a.get_width()-1,a.get_height()-1)).b;v.a=1;}else{v.r=options.x;v.g=options.x==.5?v.a:(options.y>.5?.75:.25);}b.write(v,q);}" options:nil error:&failure];
    p->kernel=[p->device newComputePipelineStateWithFunction:[library newFunctionWithName:@"proof"] error:&failure];
    if(!p->kernel){if(error&&capacity)snprintf(error,capacity,"%s",failure.localizedDescription.UTF8String?:"Metal unavailable");return nullptr;}
    providers.fetch_add(1,std::memory_order_relaxed);return new std::shared_ptr<Provider>(p);
}
extern "C" MLNeuralProvider ml_neural_create(const char *path,char *error,size_t capacity){return ml_neural_create_with_options(path,1,0,error,capacity);}
extern "C" int ml_neural_submit(MLNeuralProvider opaque,const void *source,const void *destination,const void *event,uint64_t producer,uint64_t done,uint64_t,int,MLNeuralCompletion callback,void *context){
    auto p=*static_cast<std::shared_ptr<Provider>*>(opaque);if(p->busy.exchange(true))return ML_NEURAL_BUSY;
    submissions.fetch_add(1,std::memory_order_relaxed);
    auto f=std::make_shared<Frame>();f->provider=p;f->source=CVPixelBufferRetain((CVPixelBufferRef)source);f->destination=CVPixelBufferRetain((CVPixelBufferRef)destination);f->event=(__bridge id<MTLSharedEvent>)event;f->done=done;f->callback=callback;f->context=context;
    auto queue=dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0);f->listener=[[MTLSharedEventListener alloc]initWithDispatchQueue:queue];
    [f->event notifyListener:f->listener atValue:producer block:^(id<MTLSharedEvent>,uint64_t){
        if(f->claimed.exchange(true))return;
        if(std::getenv("MACLAUNCHER_TEST_NEURAL_UNSUPPORTED")){f->event.signaledValue=done;f->finish(ML_NEURAL_PASSTHROUGH,"Neural rendering requires an opaque SDR frame");return;}
        if(std::getenv("MACLAUNCHER_TEST_NEURAL_FAIL")){f->event.signaledValue=done;f->finish(ML_NEURAL_FAILED,"Test transient provider failure");return;}
        // Like the MLX provider, admit only a source whose every pixel is opaque.
        if(std::getenv("MACLAUNCHER_TEST_NEURAL_REQUIRE_OPAQUE")&&!opaqueSource(f->source)){f->event.signaledValue=done;f->finish(ML_NEURAL_PASSTHROUGH,"Neural rendering requires an opaque SDR frame");return;}
        auto encode=^{auto commands=[p->queue commandBuffer];auto encoder=[commands computeCommandEncoder];float options[]={p->intensity,p->temporal?1.f:0.f,p->orientation?1.f:0.f,0};
        [encoder setComputePipelineState:p->kernel];[encoder setTexture:texture(p,f->source) atIndex:0];[encoder setTexture:texture(p,f->destination) atIndex:1];[encoder setBytes:options length:sizeof(options) atIndex:0];
        [encoder dispatchThreads:MTLSizeMake(CVPixelBufferGetWidth(f->source),CVPixelBufferGetHeight(f->source),1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
        [commands encodeSignalEvent:f->event value:done];[commands addCompletedHandler:^(id<MTLCommandBuffer>){f->finish(ML_NEURAL_RENDERED,"");}];[commands commit];};
        const char *delay=std::getenv("MACLAUNCHER_TEST_NEURAL_DELAY_MS");const auto milliseconds=delay?std::min(4000,std::max(0,std::atoi(delay))):0;
        if(milliseconds)dispatch_after(dispatch_time(DISPATCH_TIME_NOW,milliseconds*NSEC_PER_MSEC),queue,encode);else encode();
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,100*NSEC_PER_MSEC),queue,^{if(!f->claimed.exchange(true)){f->event.signaledValue=done;f->finish(ML_NEURAL_FAILED,"Producer did not submit its frame");}});
    return ML_NEURAL_RENDERED;
}
// Providers created so far, for checks that a warmed node is reused.
extern "C" unsigned ml_test_neural_providers(){return providers.load(std::memory_order_relaxed);}
// Frames the providers accepted, for checks that a warm-up reached its provider.
extern "C" unsigned ml_test_neural_submissions(){return submissions.load(std::memory_order_relaxed);}
extern "C" void ml_neural_destroy(MLNeuralProvider value){delete static_cast<std::shared_ptr<Provider>*>(value);}
