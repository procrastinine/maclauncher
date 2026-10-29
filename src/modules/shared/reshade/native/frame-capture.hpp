#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Metal/Metal.h>
#include "log.hpp"
#include "native-config.hpp"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <exception>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <sys/time.h>
#include <unistd.h>
namespace macfx {
void writeCapturedFrame(const std::string &,const void *,unsigned,unsigned,bool,bool,unsigned);
// One reservation follows one admitted source frame through its final output.
// Neither an unsuccessful read nor an abandoned command consumes the request.
class FrameCapture {
    struct Image {id<MTLBuffer> bytes;id<MTLTexture> texture;unsigned width=0,height=0,stride=0;bool bgra=false;};
    static bool supported(id<MTLTexture> texture) {
        return texture&&(texture.pixelFormat==MTLPixelFormatBGRA8Unorm||texture.pixelFormat==MTLPixelFormatBGRA8Unorm_sRGB||
            texture.pixelFormat==MTLPixelFormatRGBA8Unorm||texture.pixelFormat==MTLPixelFormatRGBA8Unorm_sRGB);
    }
    static bool readable(id<MTLCommandBuffer> commands,id<MTLTexture> texture) {
        return commands&&supported(texture)&&commands.status<MTLCommandBufferStatusCommitted&&commands.device==texture.device&&texture.sampleCount==1&&!texture.framebufferOnly;
    }
    static void unsupported(id<MTLTexture> texture) {
        static std::atomic<bool>warned{false};if(!warned.exchange(true))nativeLog("Frame capture needs an 8-bit RGB image; format="+std::to_string(texture?texture.pixelFormat:MTLPixelFormatInvalid)+"; request remains pending");
    }
    struct State {
        std::mutex mutex;uint64_t ticket;std::string prefix;Image before,after;bool beforeFlip=false,afterFlip=false,sourceDone=false,finalDone=false,writing=false;
        const int64_t capturedAt=std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        State(uint64_t value,std::string path,bool flip):ticket(value),prefix(std::move(path)),beforeFlip(flip){}
        ~State(){abandon();}
        void abandon(){std::lock_guard guard(mutex);if(writing)return;if(ticket){finishCaptureFrame(ticket,false);ticket=0;}before={};after={};}
        void completed(bool source,bool success){
            Image first,last;std::string name;uint64_t reservation=0;bool inputFlip=false,outputFlip=false;
            {std::lock_guard guard(mutex);if(!ticket)return;
                if(!success){finishCaptureFrame(ticket,false);ticket=0;before={};after={};return;}
                if(source){sourceDone=true;before.texture=nil;}else{finalDone=true;after.texture=nil;}
                if(!sourceDone||!finalDone||writing)return;
                writing=true;first=before;last=after;name=prefix;reservation=ticket;inputFlip=beforeFlip;outputFlip=afterFlip;
            }
            // Per-ticket files and capture-start times keep a late old pair
            // from satisfying a newer request. There is only one writer.
            const auto temporary=name+".capture-"+std::to_string(reservation);
            const auto input=temporary+"-before.png",output=temporary+"-after.png";
            struct Remove{const std::string&a,&b;~Remove(){unlink(a.c_str());unlink(b.c_str());}}remove{input,output};
            bool published=false;
            @try{try{if(captureFrameCurrent(reservation)){
                writeCapturedFrame(input,first.bytes.contents,first.width,first.height,first.bgra,inputFlip,first.stride);
                writeCapturedFrame(output,last.bytes.contents,last.width,last.height,last.bgra,outputFlip,last.stride);
                const timeval time{time_t(capturedAt/1000000),suseconds_t(capturedAt%1000000)},times[2]{time,time};
                if(utimes(input.c_str(),times)||utimes(output.c_str(),times))throw std::runtime_error("Cannot timestamp the captured frame");
                if(captureFrameCurrent(reservation)){
                    if(std::rename(input.c_str(),(name+"-before.png").c_str())||std::rename(output.c_str(),(name+"-after.png").c_str()))throw std::runtime_error("Cannot publish the captured frame pair");
                    published=true;nativeLog("Metal frame capture saved: "+name);
                }
            }}catch(const std::exception&error){nativeLog(error.what());}}@catch(NSException*error){nativeLog(error.reason.UTF8String?:"Frame capture publication failed");}
            {std::lock_guard guard(mutex);finishCaptureFrame(reservation,published);ticket=0;before={};after={};writing=false;}
        }
    };
    // A command owns its readback resources even with retainedReferences=NO.
    // This witness owns no command buffer; an unsubmitted buffer's destruction
    // returns the reservation instead of creating a callback/capture cycle.
    struct Completion {
        std::shared_ptr<State>state;Image image;bool source;std::atomic<bool>observed{false};
        Completion(std::shared_ptr<State>value,Image readback,bool input):state(std::move(value)),image(std::move(readback)),source(input){}
        ~Completion(){if(!observed.load(std::memory_order_acquire))state->abandon();}
        void completed(id<MTLCommandBuffer>commands){observed.store(true,std::memory_order_release);state->completed(source,commands.status==MTLCommandBufferStatusCompleted);}
    };
    std::shared_ptr<State>state;std::atomic<bool>finished{false};
    explicit FrameCapture(std::shared_ptr<State>value):state(std::move(value)){}
    static bool read(const std::shared_ptr<State>&state,id<MTLCommandBuffer>commands,id<MTLTexture>texture,bool source,bool flip) {
        if(!readable(commands,texture))return false;
        const unsigned width=texture.width,height=texture.height,stride=(width*4+255)&~255u;
        auto bytes=[commands.device newBufferWithLength:size_t(stride)*height options:MTLResourceStorageModeShared];if(!bytes)return false;
        Image image{bytes,texture,width,height,stride,texture.pixelFormat==MTLPixelFormatBGRA8Unorm||texture.pixelFormat==MTLPixelFormatBGRA8Unorm_sRGB};
        auto completion=std::make_shared<Completion>(state,image,source);
        {std::lock_guard guard(state->mutex);if(!state->ticket)return false;if(source)state->before=image;else{state->after=image;state->afterFlip=flip;}}
        [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){@autoreleasepool{completion->completed(completed);}}];
        auto copy=[commands blitCommandEncoder];if(!copy)return false;
        @try{[copy copyFromTexture:texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(width,height,1)
            toBuffer:bytes destinationOffset:0 destinationBytesPerRow:stride destinationBytesPerImage:size_t(stride)*height];}
        @finally{[copy endEncoding];}
        return true;
    }
public:
    ~FrameCapture(){if(!finished.load(std::memory_order_acquire))state->abandon();}
    static bool configured(){return nativeConfig().capture.configured();}
    static bool pending(uint64_t frame){const auto&capture=nativeConfig().capture;if(!capture.configured())return false;return capture.trigger?captureTriggerPending():frame==capture.frame;}
    static std::shared_ptr<FrameCapture>begin(id<MTLCommandBuffer>commands,id<MTLTexture>source,uint64_t frame,bool flip=false){
        if(!pending(frame))return {};if(!supported(source)){unsupported(source);return {};}if(!readable(commands,source))return {};
        const auto ticket=claimCaptureFrame(frame);if(!ticket)return {};
        struct Reservation{uint64_t ticket;~Reservation(){if(ticket)finishCaptureFrame(ticket,false);}}reservation{ticket};
        std::shared_ptr<State>state;
        @try{try{state=std::make_shared<State>(ticket,nativeConfig().capture.prefix,flip);reservation.ticket=0;
            if(!read(state,commands,source,true,flip)){state->abandon();return {};}
            return std::shared_ptr<FrameCapture>(new FrameCapture(state));
        }catch(...){if(state)state->abandon();}}@catch(NSException*error){(void)error;if(state)state->abandon();}return {};
    }
    void finish(id<MTLCommandBuffer>commands,id<MTLTexture>output,bool flip=false){
        if(finished.exchange(true,std::memory_order_acq_rel))return;
        @try{try{if(!supported(output))unsupported(output);if(!read(state,commands,output,false,flip))state->abandon();}catch(...){state->abandon();}}
        @catch(NSException*error){(void)error;state->abandon();}
    }
};
}
