// Copyright (c) MacLauncher contributors. MIT license.
#include "video-frame.h"
#include "effects-execution.hpp"
#include <mutex>
#include <cstdio>
#include <cmath>
#include <stdexcept>
namespace {
void message(char *out,uint32_t capacity,const std::string &text){if(out&&capacity)std::snprintf(out,capacity,"%s",text.c_str());}
struct Video {
    id<MTLCommandQueue> queue;
    macfx::EffectPlanExecutor executor;
    std::mutex lock;
    explicit Video(id<MTLCommandQueue> value):queue(value){}
};
}
extern "C" void *rsVideoCreate(void *queue,char *error,uint32_t capacity){
    @autoreleasepool {try {
        if(!queue)throw std::runtime_error("A Metal command queue is required for video export");
        return new Video((__bridge id<MTLCommandQueue>)queue);
    }catch(const std::exception &problem){message(error,capacity,problem.what());return nullptr;}}
}
extern "C" void rsVideoRelease(void *handle){delete static_cast<Video*>(handle);}
extern "C" int rsVideoProcess(void *handle,const RSVideoFrame *request,char *error,uint32_t capacity){
    @autoreleasepool {id<MTLCommandBuffer> commands=nil;try {
        if(!handle||!request||request->size<sizeof(RSVideoFrame)||request->version!=1||!request->sourceTexture||!request->outputTexture||
            !std::isfinite(request->timeMs)||!std::isfinite(request->frameTimeMs)||request->frameTimeMs<=0)
            throw std::runtime_error("Invalid offline video frame");
        auto &video=*static_cast<Video*>(handle);std::lock_guard<std::mutex> guard(video.lock);
        auto source=(__bridge id<MTLTexture>)request->sourceTexture,target=(__bridge id<MTLTexture>)request->outputTexture;
        if(source.device!=video.queue.device||target.device!=video.queue.device||source.pixelFormat!=MTLPixelFormatBGRA8Unorm||target.pixelFormat!=MTLPixelFormatBGRA8Unorm)
            throw std::runtime_error("Video export requires SDR BGRA8 images on the selected Metal device");
        commands=[video.queue commandBuffer];if(!commands)throw std::runtime_error("Cannot allocate a video command buffer");
        macfx::ShaderFrame frame{commands,source,target,request->frameId,request->timeMs,request->frameTimeMs};frame.opaqueDisplay=true;
        const auto selection=video.executor.prepare(frame);
        if(!selection.error.empty())throw std::runtime_error(selection.error);
        if(!selection.execution)throw std::runtime_error("The video graphics plan could not be prepared");
        const auto encoded=selection.execution->encode(frame);
        // Producer events must be submitted even when a later row fails.
        [commands commit];[commands waitUntilCompleted];
        if(commands.status!=MTLCommandBufferStatusCompleted)throw std::runtime_error(commands.error.localizedDescription.UTF8String?:"Video GPU processing failed");
        if(!encoded.encoded||!encoded.reason.empty())throw std::runtime_error(encoded.reason.empty()?"The video graphics plan could not process a frame":encoded.reason);
        const auto complete=selection.execution->finishOffline();
        if(!complete.encoded)throw std::runtime_error(complete.reason);
        return 0;
    }catch(const std::exception &problem){
        if(commands&&commands.status<MTLCommandBufferStatusCommitted){[commands commit];[commands waitUntilCompleted];}
        message(error,capacity,problem.what());return 1;
    }}
}
