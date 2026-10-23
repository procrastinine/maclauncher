#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
#include "log.hpp"
#include <atomic>
#include <cstdlib>
#include <exception>
#include <memory>
#include <string>
#include <unistd.h>
namespace macfx {
void writeCapturedFrame(const std::string &,const void *,unsigned,unsigned,bool,bool,unsigned);
// This opt-in capture belongs to an entire admitted source frame. A batch can
// carry it across generation/presentation; only its first final output saves
// a pair, after the actual final command buffer completes successfully.
class FrameCapture {
    struct Image {id<MTLBuffer> bytes;unsigned width=0,height=0,stride=0;bool bgra=false;};
    std::string prefix;Image before;bool beforeFlip=false;std::atomic<bool> finished{false};
    static Image read(id<MTLCommandBuffer> commands,id<MTLTexture> texture) {
        const bool bgra=texture.pixelFormat==MTLPixelFormatBGRA8Unorm||texture.pixelFormat==MTLPixelFormatBGRA8Unorm_sRGB;
        if(!bgra&&texture.pixelFormat!=MTLPixelFormatRGBA8Unorm&&texture.pixelFormat!=MTLPixelFormatRGBA8Unorm_sRGB)return {};
        const unsigned width=texture.width,height=texture.height,stride=(width*4+255)&~255u;
        auto bytes=[commands.device newBufferWithLength:stride*height options:MTLResourceStorageModeShared];if(!bytes)return {};
        auto copy=[commands blitCommandEncoder];if(!copy)return {};
        [copy copyFromTexture:texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(width,height,1) toBuffer:bytes destinationOffset:0 destinationBytesPerRow:stride destinationBytesPerImage:stride*height];[copy endEncoding];return {bytes,width,height,stride,bgra};
    }
    FrameCapture(std::string path,id<MTLCommandBuffer> commands,id<MTLTexture> source,bool flip):prefix(std::move(path)),before(read(commands,source)),beforeFlip(flip){}
public:
    static std::shared_ptr<FrameCapture> begin(id<MTLCommandBuffer> commands,id<MTLTexture> source,uint64_t frame,bool flip=false) {
        const auto path=getenv("RESHADE_CAPTURE_PREFIX");if(!path||!*path)return {};
        const auto trigger=getenv("RESHADE_CAPTURE_TRIGGER"),at=getenv("RESHADE_CAPTURE_FRAME");
        if(!(trigger?unlink(trigger)==0:frame==(at?strtoull(at,nullptr,10):120)))return {};
        auto result=std::shared_ptr<FrameCapture>(new FrameCapture(path,commands,source,flip));return result->before.bytes?result:nullptr;
    }
    void finish(id<MTLCommandBuffer> commands,id<MTLTexture> output,bool outputFlip=false) {
        if(finished.exchange(true))return;const auto after=read(commands,output);if(!after.bytes)return;
        const auto first=before;const auto name=prefix;const bool inputFlip=beforeFlip;
        [commands addCompletedHandler:^(id<MTLCommandBuffer> completed){@autoreleasepool{if(completed.status==MTLCommandBufferStatusCompleted)try{
            writeCapturedFrame(name+"-before.png",first.bytes.contents,first.width,first.height,first.bgra,inputFlip,first.stride);
            writeCapturedFrame(name+"-after.png",after.bytes.contents,after.width,after.height,after.bgra,outputFlip,after.stride);
            nativeLog("Metal frame capture saved: "+name);
        }catch(const std::exception &error){nativeLog(error.what());}}}];
    }
};
}
