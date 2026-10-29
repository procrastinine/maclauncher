#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "image-admission.hpp"
#include "effects-plan.hpp"
#include "live-controls.hpp"
#import <Metal/Metal.h>
#include <CommonCrypto/CommonDigest.h>
#include <atomic>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace macfx {
class InPlaceRequest {
    std::mutex mutex;EffectPlanState plans;
public:
    std::string read(){
        const auto &live=liveState();thread_local uint64_t generation=~uint64_t(0);thread_local std::string controls;
        if(generation!=live.generation){generation=live.generation;controls.clear();if(const auto packet=live.controls.get()){
            unsigned char hash[CC_SHA256_DIGEST_LENGTH];CC_SHA256(packet,sizeof(*packet),hash);char text[65];
            for(unsigned i=0;i<sizeof(hash);++i)std::snprintf(text+i*2,3,"%02x",hash[i]);controls=text;}}
        std::lock_guard lock(mutex);plans.poll();const auto plan=plans.snapshot();
        return (plan?plan->revision:effectSelection().revision)+controls;
    }
};
// A transiently occupied processor may reuse only a completed image from this
// exact native output contract. Pressure keeps that completed image available;
// only an actual failure selects the stable original route.
class InPlaceHistory {
    struct Image {id<MTLTexture> texture;id<MTLRenderPipelineState> paste;unsigned pending=0;};
public:
    struct State {
        std::mutex mutex;id<MTLDevice> device;NSUInteger width=0,height=0;MTLPixelFormat format=MTLPixelFormatInvalid;
        uintptr_t color=0;std::string request;uint64_t epoch=1,next=0,completedSequence=0;bool original=false;
        std::vector<std::shared_ptr<Image>> images;std::shared_ptr<Image> completed;
    };
    using Session=std::shared_ptr<State>;
private:
    struct Flight {
        Session state;std::shared_ptr<Image> image;uint64_t epoch,sequence;bool publish;std::atomic<bool> ended{false};
        id<MTLTexture> source,target;
        Flight(Session s,std::shared_ptr<Image> i,uint64_t e,bool p,uint64_t n=0):state(std::move(s)),image(std::move(i)),epoch(e),sequence(n),publish(p){}
        void finish(bool success){if(ended.exchange(true))return;std::lock_guard lock(state->mutex);--image->pending;
            if(success&&publish&&state->epoch==epoch&&!state->original&&sequence>state->completedSequence){
                state->completed=image;state->completedSequence=sequence;}}
        ~Flight(){finish(false);}
    };
    std::mutex mutex;Session current;
public:
    Session prepare(id<MTLTexture> output,std::string request,uintptr_t color=0) {
        std::lock_guard lock(mutex);
        if(!current||current->device!=output.device||current->width!=output.width||current->height!=output.height||current->format!=output.pixelFormat||current->color!=color){
            current=std::make_shared<State>();current->device=output.device;current->width=output.width;current->height=output.height;current->format=output.pixelFormat;current->color=color;
        }
        std::lock_guard state(current->mutex);
        if(current->request!=request){current->request=std::move(request);++current->epoch;current->original=false;}
        return current;
    }
    void reset(){std::lock_guard lock(mutex);current.reset();}
    Session retained(id<MTLTexture>output,uintptr_t color){std::lock_guard lock(mutex);if(!current)return {};std::lock_guard state(current->mutex);return current->device==output.device&&current->width==output.width&&current->height==output.height&&current->format==output.pixelFormat&&current->color==color&&!current->original&&current->completed?current:Session{};}
    static bool original(const Session &state){std::lock_guard lock(state->mutex);return state->original;}
    static void bypass(const Session &state){std::lock_guard lock(state->mutex);state->original=true;state->completed.reset();++state->epoch;}
    static bool transient(const Session &state){
        std::lock_guard lock(state->mutex);if(state->original)return false;
        return true;
    }
    static void capture(const Session &state,id<MTLCommandBuffer> commands,id<MTLTexture> output,id<MTLRenderPipelineState> paste=nil) {
        std::shared_ptr<Image> slot;uint64_t epoch,sequence;
        {std::lock_guard lock(state->mutex);if(state->original)return;epoch=state->epoch;
         for(const auto &image:state->images)if(image!=state->completed&&!image->pending){slot=image;break;}
         if(!slot&&state->images.size()<2){slot=std::make_shared<Image>();state->images.push_back(slot);}
         if(!slot)return;++slot->pending;sequence=++state->next;}
        auto flight=std::make_shared<Flight>(state,slot,epoch,true,sequence);
        flight->source=output;
            if(!slot->texture){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:state->format width:state->width height:state->height mipmapped:NO];
                descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead;
                slot->texture=newAdmittedTexture(state->device,descriptor,reinterpret_cast<uintptr_t>(state.get()),"in-place-history");
                if(!slot->texture)throw std::runtime_error("Processed frame history is unavailable");}
            slot->paste=paste;
            auto copy=[commands blitCommandEncoder];if(!copy)throw std::runtime_error("Processed frame history copy is unavailable");
            [copy copyFromTexture:output sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(state->width,state->height,1)
                toTexture:slot->texture destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];
            [commands addCompletedHandler:^(id<MTLCommandBuffer> finished){flight->finish(finished.status==MTLCommandBufferStatusCompleted);}];
    }
    static bool replay(const Session &state,id<MTLCommandBuffer> commands,id<MTLTexture> output){
        if(!transient(state))return false;
        std::shared_ptr<Image> slot;
        {std::lock_guard lock(state->mutex);slot=state->completed;if(!slot)return false;++slot->pending;}
        auto flight=std::make_shared<Flight>(state,slot,0,false);
        flight->target=output;
            if(output.framebufferOnly){
                if(!slot->paste)throw std::runtime_error("Processed framebuffer history is unavailable");
                auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=output;
                pass.colorAttachments[0].loadAction=MTLLoadActionDontCare;pass.colorAttachments[0].storeAction=MTLStoreActionStore;
                auto encoder=[commands renderCommandEncoderWithDescriptor:pass];if(!encoder)throw std::runtime_error("Processed framebuffer replay is unavailable");
                [encoder setRenderPipelineState:slot->paste];[encoder setFragmentTexture:slot->texture atIndex:0];
                [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];
            }else{
                auto copy=[commands blitCommandEncoder];if(!copy)throw std::runtime_error("Processed frame replay is unavailable");
                [copy copyFromTexture:slot->texture sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(state->width,state->height,1)
                    toTexture:output destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];
            }
            [commands addCompletedHandler:^(id<MTLCommandBuffer>){flight->finish(false);}];return true;
    }
};
}
