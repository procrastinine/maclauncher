// Native FSR 4.1.1 provider. The upstream renderer receives complete temporal
// inputs and records into the caller's Metal command buffer without waiting.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include "../frame.h"
#include "fsr411_runtime.h"
#include <mutex>

namespace {
struct Owner {
    std::unique_ptr<fsr411::View> view=std::make_unique<fsr411::View>();
    uint64_t lastFrame=0;
    bool hasFrame=false;
};
struct Context {
    fsr411::Runtime runtime;
    std::map<void *, Owner> owners;
    std::vector<std::unique_ptr<fsr411::View>> retired;
    Context(id<MTLDevice> device, const char *root, const char *build):runtime(device,root,build) {}
    void collect() {
        retired.erase(std::remove_if(retired.begin(),retired.end(),[](const auto &view) {
            return std::all_of(view->slots.begin(),view->slots.end(),[](const auto &slot){return slot->retired();});
        }),retired.end());
    }
};
std::mutex mutex;
std::map<void *,std::unique_ptr<Context>> contexts;
int result(RSTemporalResult *out, uint32_t status, const char *reason, bool encoded=false) {
    if(out && out->size>=sizeof(*out)) {
        out->version=1;out->status=status;out->encoded=encoded;out->method=RS_TEMPORAL_FSR4;
        std::snprintf(out->reason,sizeof(out->reason),"%s",reason?reason:"");
    }
    return status;
}
Fsr4InputSurface surface(id<MTLTexture> texture,uint32_t x,uint32_t y) {
    if(texture.width>UINT32_MAX || texture.height>UINT32_MAX)return {};
    return {uint32_t(texture.width),uint32_t(texture.height),x,y};
}
int encode(const RSTemporalFrame *f,RSTemporalResult *out) {
    @autoreleasepool {
        if(@available(macOS 26.0,*)) {} else
            return result(out,RS_TEMPORAL_UNAVAILABLE,"FSR 4 requires macOS 26 or newer");
        if(!f || f->size<sizeof(*f) || f->version!=1 || f->method!=RS_TEMPORAL_FSR4)
            return result(out,RS_TEMPORAL_INVALID,"Invalid FSR 4 temporal frame");
        if(!f->owner || !f->commandBuffer || !f->color || !f->depth || !f->motion || !f->output)
            return result(out,RS_TEMPORAL_INVALID,"FSR 4 requires color, depth, motion and output textures");
        const char *root=std::getenv("FSR4_ROOT"),*build=std::getenv("FSR4_BUILD_DIR");
        if(!root || root[0]!='/' || !build || build[0]!='/')
            return result(out,RS_TEMPORAL_UNAVAILABLE,"FSR 4 resources are not installed");
        std::lock_guard<std::mutex> lock(mutex);
        fsr411::Frame frame;
        frame.color=(__bridge id<MTLTexture>)f->color;frame.depth=(__bridge id<MTLTexture>)f->depth;
        frame.motion=(__bridge id<MTLTexture>)f->motion;frame.output=(__bridge id<MTLTexture>)f->output;
        frame.exposure=(__bridge id<MTLTexture>)f->exposure;
        auto device=frame.color.device;
        if(![device supportsFamily:MTLGPUFamilyApple7])
            return result(out,RS_TEMPORAL_UNAVAILABLE,"FSR 4 requires an Apple Silicon GPU");
        auto &context=contexts[(__bridge void *)device];
        if(!context)context=std::make_unique<Context>(device,root,build);
        context->collect();
        auto &owner=context->owners[f->owner];
        bool resetSequence=owner.hasFrame && (owner.lastFrame==UINT64_MAX || f->frameId!=owner.lastFrame+1);
        for(auto &slot:owner.view->slots)if(slot->completion && slot->completion.status==MTLCommandBufferStatusError){
            slot->busy=false;slot->completion=nil;owner.view->invalidate();
            owner.view->zeroScratch=owner.view->zeroTargets=true;resetSequence=true;
        }
        auto &input=frame.input;
        input.geometry={surface(frame.color,f->colorX,f->colorY),surface(frame.depth,f->depthX,f->depthY),
            surface(frame.motion,f->motionX,f->motionY),surface(frame.output,f->outputX,f->outputY),
            f->maxRenderWidth,f->maxRenderHeight};
        input.rw=f->renderWidth;input.rh=f->renderHeight;input.uw=f->outputWidth;input.uh=f->outputHeight;
        input.jitterX=f->jitterX;input.jitterY=f->jitterY;
        input.mvScaleX=f->motionScaleX;input.mvScaleY=f->motionScaleY;input.preExposure=f->preExposure;
        input.reset=resetSequence || !!(f->flags&RS_TEMPORAL_RESET);input.depthReversed=!!(f->flags&RS_TEMPORAL_DEPTH_REVERSED);
        input.jitteredMV=!!(f->flags&RS_TEMPORAL_JITTERED_MOTION);
        input.outputResMV=!!(f->flags&RS_TEMPORAL_OUTPUT_MOTION);
        input.autoExposure=!!(f->flags&RS_TEMPORAL_AUTO_EXPOSURE);
        input.hasExposureTexture=f->exposure!=nullptr;input.inputContentProperties=1;
        fsr411::Options options;
        options.profile=fsr411::Profile::ExactFast;options.allowCompile=false;
        options.ultraPerformance=f->renderWidth && double(f->outputWidth)/f->renderWidth>=2.99;
        options.rcas=f->sharpness>0;options.sharpness=f->sharpness;
        std::string error;
        @try {
            if(!context->runtime.encode((__bridge id)f->commandBuffer,*owner.view,frame,options,error))
                return result(out,error.find("in flight")!=std::string::npos?RS_TEMPORAL_BUSY:RS_TEMPORAL_FAILED,error.c_str());
        } @catch(NSException *exception) {
            owner.view->invalidate();return result(out,RS_TEMPORAL_FAILED,exception.reason.UTF8String);
        }
        owner.lastFrame=f->frameId;owner.hasFrame=true;
        if(out && out->size>=sizeof(*out))out->reset=owner.view->prepared.reset;
        return result(out,RS_TEMPORAL_OK,"",true);
    }
}
void release(void *identity) {
    std::lock_guard<std::mutex> lock(mutex);
    for(auto &pair:contexts) {
        auto &context=*pair.second;
        auto owner=context.owners.find(identity);
        if(owner!=context.owners.end()) {
            context.retired.push_back(std::move(owner->second.view));context.owners.erase(owner);
        }
        context.collect();
    }
}
const RSTemporalProvider provider={sizeof(RSTemporalProvider),1,1u<<RS_TEMPORAL_FSR4,0,encode,release};
}
extern "C" __attribute__((visibility("default")))
const RSTemporalProvider *rsGetTemporalProvider(uint32_t version) {return version==1?&provider:nullptr;}
