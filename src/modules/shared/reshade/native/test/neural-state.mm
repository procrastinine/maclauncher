// Copyright (c) MacLauncher contributors. MIT license.
// Actual NeuralNode state ownership with CPU-only provider/CoreVideo/NSObject
// boundaries. No Metal device, queue, GPU work or model is created.
#include "neural-node.hpp"
#include "neural-provider.h"
#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>
#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <dlfcn.h>
#include <mutex>
#include <thread>
namespace neural_state {
std::atomic<unsigned> creates{0},destroys{0},pixelLeases{0};
std::mutex lock;std::condition_variable changed;bool releaseCreation=false;
id device;
void *create(const char *,float,int,char *,size_t){
    ++creates;changed.notify_all();std::unique_lock guard(lock);
    changed.wait(guard,[]{return releaseCreation;});return new unsigned(creates.load());
}
void destroy(void *value){delete static_cast<unsigned*>(value);++destroys;}
int submit(MLNeuralProvider,const void*,const void*,const void*,uint64_t,uint64_t,uint64_t,int,MLNeuralCompletion,void*){fputs("Unexpected neural submission\n",stderr);_Exit(1);}
void *open(const char*,int){return reinterpret_cast<void*>(1);}
int close(void*){return 0;}
void *symbol(void*,const char *name){
    if(!std::strcmp(name,"ml_neural_create_with_options"))return reinterpret_cast<void*>(create);
    if(!std::strcmp(name,"ml_neural_submit"))return reinterpret_cast<void*>(submit);
    if(!std::strcmp(name,"ml_neural_destroy"))return reinterpret_cast<void*>(destroy);
    return nullptr;
}
id<MTLDevice> systemDevice(){return (id<MTLDevice>)device;}
CVReturn pixelCreate(CFAllocatorRef,size_t,size_t,OSType,CFDictionaryRef,CVPixelBufferRef *out){
    ++pixelLeases;*out=(CVPixelBufferRef)CFBridgingRetain([NSObject new]);return kCVReturnSuccess;
}
void pixelRelease(CVPixelBufferRef value){assert(value);CFRelease(value);--pixelLeases;}
size_t pixelSize(CVPixelBufferRef){return 256;}
IOSurfaceRef surface(CVPixelBufferRef value){return (IOSurfaceRef)value;}
}
@interface NeuralStateTexture:NSObject
@end
@implementation NeuralStateTexture
- (id)device{return neural_state::device;}
- (NSUInteger)width{return 8;}
- (NSUInteger)height{return 8;}
- (MTLPixelFormat)pixelFormat{return MTLPixelFormatBGRA8Unorm;}
- (MTLTextureType)textureType{return MTLTextureType2D;}
- (NSUInteger)sampleCount{return 1;}
- (BOOL)isFramebufferOnly{return NO;}
- (MTLTextureUsage)usage{return MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;}
@end
// State preparation also builds its alpha-preserving copy pipelines; these
// doubles name the functions and pipelines without compiling Metal source.
@interface NeuralStateLibrary:NSObject
@end
@implementation NeuralStateLibrary
- (id)newFunctionWithName:(NSString*)name{(void)name;return [NSObject new];}
@end
@interface NeuralStateDevice:NSObject
@end
@implementation NeuralStateDevice
- (uint64_t)registryID{return 17;}
- (NSUInteger)recommendedMaxWorkingSetSize{return 64u<<20;}
- (NSUInteger)currentAllocatedSize{return 0;}
- (id)newTextureWithDescriptor:(MTLTextureDescriptor*)descriptor iosurface:(IOSurfaceRef)surface plane:(NSUInteger)plane{(void)descriptor;(void)surface;(void)plane;return [NeuralStateTexture new];}
- (id)newLibraryWithSource:(NSString*)source options:(MTLCompileOptions*)options error:(NSError**)error{(void)source;(void)options;(void)error;return [NeuralStateLibrary new];}
- (id)newComputePipelineStateWithFunction:(id)function error:(NSError**)error{(void)error;return function?[NSObject new]:nil;}
@end
@interface NeuralStateCommands:NSObject
@end
@implementation NeuralStateCommands
- (id)device{return neural_state::device;}
- (MTLCommandBufferStatus)status{return MTLCommandBufferStatusNotEnqueued;}
- (BOOL)retainedReferences{return YES;}
@end
#define dlopen neural_state::open
#define dlsym neural_state::symbol
#define dlclose neural_state::close
#define MTLCreateSystemDefaultDevice neural_state::systemDevice
#define CVPixelBufferCreate neural_state::pixelCreate
#define CVPixelBufferRelease neural_state::pixelRelease
#define CVPixelBufferGetDataSize neural_state::pixelSize
#define CVPixelBufferGetIOSurface neural_state::surface
#ifndef MACFX_NEURAL_STATE_SOURCE
#define MACFX_NEURAL_STATE_SOURCE <neural-node.mm>
#endif
#include MACFX_NEURAL_STATE_SOURCE
int main(){@autoreleasepool{
#if !defined(__arm64__)
    return 77;
#endif
    if(@available(macOS 14.0,*)){}else return 77;
    setenv("RESHADE_NEURAL_LIBRARY","/controlled/cpu-provider",1);
    neural_state::device=[NeuralStateDevice new];
    auto node=macfx::makeNeuralNode({"/controlled/model",1,false});
    assert(neural_state::creates==0); // Merely retaining a row/Off creates no provider.
    id<MTLCommandBuffer>commands=(id<MTLCommandBuffer>)[NeuralStateCommands new];
    id<MTLTexture>image=(id<MTLTexture>)[NeuralStateTexture new];
    macfx::ShaderFrame frame{commands,image,image};frame.color=macfx::SpatialColor::Perceptual;
    macfx::ShaderResult a,b;
    std::thread first([&]{@autoreleasepool{a=node->prepare(frame);}});
    {std::unique_lock guard(neural_state::lock);assert(neural_state::changed.wait_for(guard,std::chrono::seconds(1),[]{return neural_state::creates>=1;}));}
    std::thread second([&]{@autoreleasepool{b=node->prepare(frame);}});
    {std::unique_lock guard(neural_state::lock);
        // The old unsynchronized member starts a second provider while the
        // first creation is blocked. A serialized owner keeps one creation.
        neural_state::changed.wait_for(guard,std::chrono::milliseconds(250),[]{return neural_state::creates>=2;});
        neural_state::releaseCreation=true;
    }neural_state::changed.notify_all();first.join();second.join();
    assert(a.encoded&&b.encoded);std::fprintf(stderr,"actual NeuralNode concurrent preparation providerCreates=%u pixelLeases=%u\n",neural_state::creates.load(),neural_state::pixelLeases.load());
    assert(neural_state::creates==1&&neural_state::destroys==0&&neural_state::pixelLeases==2);
    assert(macfx::finishNeuralNode(node).encoded);node.reset();
    assert(neural_state::destroys==1&&neural_state::pixelLeases==0);
    {
        auto owner=std::make_shared<macfx::State>(macfx::NeuralSpec{"/controlled/model",1,false},(id<MTLDevice>)neural_state::device);
        owner->lastStatus=ML_NEURAL_RENDERED;owner->lastError="Newer frame completed";
        auto abandoned=std::make_shared<macfx::Flight>();abandoned->owner=owner;abandoned->images=std::make_shared<macfx::Images>();
        abandoned->submission.store(2);
        macfx::completed(new std::shared_ptr<macfx::Flight>(abandoned),ML_NEURAL_FAILED,"The neural source was not submitted");
        assert(abandoned->providerDone.load()&&abandoned->result.load()==ML_NEURAL_FAILED);
        assert(!owner->failed&&owner->lastStatus==ML_NEURAL_RENDERED&&owner->lastError=="Newer frame completed");
        // The state owns a warm-up only until it resolves; no cycle remains.
        auto warming=std::make_shared<macfx::Flight>();warming->owner=owner;warming->images=abandoned->images;warming->warmup=true;warming->submission.store(1);
        {std::lock_guard guard(owner->lock);owner->warming=warming;}const std::weak_ptr<macfx::Flight>resolved=warming;
        macfx::completed(new std::shared_ptr<macfx::Flight>(warming),ML_NEURAL_RENDERED,"");warming.reset();
        assert(resolved.expired()&&!owner->warming);
        auto failed=std::make_shared<macfx::Flight>();failed->owner=owner;failed->images=abandoned->images;failed->submission.store(1);
        macfx::completed(new std::shared_ptr<macfx::Flight>(failed),ML_NEURAL_FAILED,"The model could not infer this image");
        assert(owner->failed&&owner->lastStatus==ML_NEURAL_FAILED&&owner->lastError=="The model could not infer this image");
        // The failure is not final: the owner is unavailable for its backoff,
        // and a frame that was already in flight does not extend it.
        {std::lock_guard guard(owner->lock);assert(owner->unavailable()&&owner->retryDelay==std::chrono::milliseconds(1000));}
        auto inFlight=std::make_shared<macfx::Flight>();inFlight->owner=owner;inFlight->images=abandoned->images;inFlight->submission.store(1);
        macfx::completed(new std::shared_ptr<macfx::Flight>(inFlight),ML_NEURAL_FAILED,"The model could not infer this image");
        {std::lock_guard guard(owner->lock);assert(owner->retryDelay==std::chrono::milliseconds(1000));owner->retryAt=std::chrono::steady_clock::now();assert(!owner->unavailable()&&!owner->failed);}
    }
    assert(neural_state::creates==2&&neural_state::destroys==2&&neural_state::pixelLeases==0);
    std::puts("actual NeuralNode CPU ownership: inactive row inert, concurrent warmup creates one state, preparation/offline snapshots retained, final owner releases provider/images once; no GPU/model claim");
    std::puts("abandoned source leaves the newer image/model state healthy; actual provider failure remains local and retries after its backoff");
}}
