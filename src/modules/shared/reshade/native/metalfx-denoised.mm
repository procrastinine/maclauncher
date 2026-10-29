// Copyright (c) MacLauncher contributors. MIT license.
#include "metalfx-denoised.hpp"
#include "scene-aov-normalize.hpp"
#include "scene-guides.hpp"
#include "color-conversion.hpp"
#include "color-island.hpp"
#include "image-admission.hpp"
#include "image-color.hpp"
#include "temporal-provider.hpp"
#include "metalfx-generation-resources.hpp"
#import <MetalFX/MetalFX.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>

namespace macfx { namespace {
constexpr uint32_t requiredAovs=(1u<<RS_SCENE_AOV_NORMAL)|(1u<<RS_SCENE_AOV_ROUGHNESS)|
    (1u<<RS_SCENE_AOV_DIFFUSE_ALBEDO)|(1u<<RS_SCENE_AOV_SPECULAR_ALBEDO);
constexpr uint32_t optionalAovs=(1u<<RS_SCENE_AOV_SPECULAR_HIT_DISTANCE)|
    (1u<<RS_SCENE_AOV_DENOISE_MASK)|(1u<<RS_SCENE_AOV_TRANSPARENCY);
using Key=std::vector<uint64_t>;
uint64_t bits(float value){uint32_t result;std::memcpy(&result,&value,sizeof(result));return result;}
void colorKey(Key&key,const ImageColorDescription&color){
    for(auto value:{uint64_t(color.primaries),uint64_t(color.transfer),uint64_t(color.range),uint64_t(color.alpha),
        bits(color.referenceWhite),bits(color.peakLuminance),bits(color.blackLuminance),bits(color.hlgSystemGamma),uint64_t(color.sceneReferred)})key.push_back(value);
}
bool region(id<MTLTexture>image,unsigned x,unsigned y,unsigned width,unsigned height){
    return image&&width&&height&&x<=image.width&&y<=image.height&&width<=image.width-x&&height<=image.height-y;
}
void imageKey(Key&key,id<MTLTexture>image){
    key.insert(key.end(),{uint64_t(image.pixelFormat),uint64_t(image.width),uint64_t(image.height),uint64_t(image.usage)});
}
struct Inputs {
    std::shared_ptr<const SceneAovLease>lease;
    RSSceneMatrices matrices{};
    ImageColorDescription working,aovColor;
    uint32_t mask=0;
    Key key;
};
ShaderResult inspect(id<MTLDevice>device,const RSTemporalFrame&frame,const ImageColorDescription&color,Inputs&inputs){
    if(frame.commandBufferKind)return {false,"MetalFX denoised scaling needs the producer's classic Metal command recording boundary"};
    auto commands=(__bridge id<MTLCommandBuffer>)frame.commandBuffer;
    if(frame.size<sizeof(frame)||frame.version!=1||!frame.owner||!frame.frameId||!commands||commands.device!=device||
        !commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted)
        return {false,"MetalFX denoising requires the actual retaining, unsubmitted scene commands"};
    if(!color.valid()||!frame.renderWidth||!frame.renderHeight||!frame.outputWidth||!frame.outputHeight||
        std::max({frame.renderWidth,frame.renderHeight,frame.outputWidth,frame.outputHeight})>16384||
        !std::isfinite(frame.preExposure)||frame.preExposure<=0||!std::isfinite(frame.jitterX)||!std::isfinite(frame.jitterY)||
        !std::isfinite(frame.motionScaleX)||!std::isfinite(frame.motionScaleY))
        return {false,"MetalFX denoising requires valid scene extents, color, exposure and motion conventions"};
    const auto source=(__bridge id<MTLTexture>)frame.color,depth=(__bridge id<MTLTexture>)frame.depth,
        motion=(__bridge id<MTLTexture>)frame.motion,output=(__bridge id<MTLTexture>)frame.output;
    const unsigned motionWidth=frame.flags&RS_TEMPORAL_OUTPUT_MOTION?frame.outputWidth:frame.renderWidth,
        motionHeight=frame.flags&RS_TEMPORAL_OUTPUT_MOTION?frame.outputHeight:frame.renderHeight;
    if(!region(source,frame.colorX,frame.colorY,frame.renderWidth,frame.renderHeight)||
        !region(depth,frame.depthX,frame.depthY,frame.renderWidth,frame.renderHeight)||
        !region(motion,frame.motionX,frame.motionY,motionWidth,motionHeight)||
        !region(output,frame.outputX,frame.outputY,frame.outputWidth,frame.outputHeight))
        return {false,"MetalFX denoising needs matching actual color, depth, motion and output regions"};
    for(auto texture:{source,depth,motion,output})if(texture.device!=device||texture.textureType!=MTLTextureType2D||texture.sampleCount!=1||texture.framebufferOnly)
        return {false,"MetalFX denoising needs resolved accessible scene textures on the current GPU"};
    if(output==source||output==depth||output==motion)return {false,"MetalFX denoising requires a separate output image"};
    for(auto texture:{source,depth,motion})if(texture.usage!=MTLTextureUsageUnknown&&!(texture.usage&MTLTextureUsageShaderRead))
        return {false,"MetalFX denoising needs readable source color and guides"};
    if(!(output.usage&MTLTextureUsageRenderTarget))return {false,"The denoised output needs color-conversion render-target usage"};
    inputs.lease=temporalSceneAovs(frame);
    if(!inputs.lease||inputs.lease->value.frameId!=frame.frameId||!(inputs.lease->value.flags&RS_SCENE_AOV_COLOR_NOISY))
        return {false,"Needs the actual noisy scene color and matching denoiser attachments"};
    const auto&packet=inputs.lease->value;
    for(unsigned slot=0;slot<RS_SCENE_AOV_COUNT;++slot)if((requiredAovs&(1u<<slot))&&!packet.images[slot].texture)
        return {false,"Needs matching renderer "+std::string(sceneAovNames[slot])+" for denoised scaling"};
    // Material specular reflectance is required. Resolved lit specular is not
    // an albedo and is never substituted for the missing material input.
    auto working=readImageColor(packet.color);
    if(working.transfer!=ColorTransfer::Linear||working.range!=ColorRange::Full||!working.sceneReferred)
        return {false,"Denoiser material attachments require their actual linear scene color description"};
    if(std::abs(packet.preExposure-frame.preExposure)>std::max(1e-6f,std::abs(frame.preExposure)*1e-5f))
        return {false,"The noisy scene color and denoiser attachments have different pre-exposure"};
    inputs.aovColor=working;inputs.working=working;inputs.working.alpha=ColorAlpha::Straight;
    auto matrices=sceneMatricesForImage(frame,temporalSceneMatrices(frame),false,false);
    if(!matrices||matrices->frameId!=frame.frameId||
        (matrices->flags&(RS_SCENE_VIEW_VALID|RS_SCENE_PROJECTION_VALID))!=(RS_SCENE_VIEW_VALID|RS_SCENE_PROJECTION_VALID))
        return {false,"Needs the actual current world-to-view and view-to-clip matrices"};
    if(!(matrices->flags&(RS_SCENE_CLIP_ZERO_TO_ONE|RS_SCENE_CLIP_MINUS_ONE_TO_ONE)))
        return {false,"MetalFX denoising needs the renderer's declared projection depth interval"};
    if(matrices->flags&RS_SCENE_PROJECTION_Y_DOWN)
        for(unsigned row=0;row<4;++row)matrices->projection[row*4+1]=-matrices->projection[row*4+1];
    if(matrices->flags&RS_SCENE_CLIP_MINUS_ONE_TO_ONE)
        for(unsigned row=0;row<4;++row)matrices->projection[row*4+2]=.5f*(matrices->projection[row*4+2]+matrices->projection[row*4+3]);
    inputs.matrices=*matrices;
    inputs.mask=requiredAovs;
    for(unsigned slot=0;slot<RS_SCENE_AOV_COUNT;++slot)if((optionalAovs&(1u<<slot))&&packet.images[slot].texture)inputs.mask|=1u<<slot;
    auto&key=inputs.key;
    key={uint64_t(reinterpret_cast<uintptr_t>((__bridge void*)commands.commandQueue)),frame.renderWidth,frame.renderHeight,
        frame.outputWidth,frame.outputHeight,frame.colorX,frame.colorY,frame.depthX,frame.depthY,frame.motionX,frame.motionY,
        frame.outputX,frame.outputY,frame.flags&~uint32_t(RS_TEMPORAL_RESET|RS_TEMPORAL_CAMERA_VALID),inputs.mask,
        matrices->flags,packet.pass,packet.colorPass};
    for(auto image:{source,depth,motion,output})imageKey(key,image);
    for(auto raw:{frame.flags&RS_TEMPORAL_AUTO_EXPOSURE?nullptr:frame.exposure,frame.reactive}){
        auto image=(__bridge id<MTLTexture>)raw;
        if(image&&(image.device!=device||image.textureType!=MTLTextureType2D||image.sampleCount!=1||image.framebufferOnly))
            return {false,"Optional denoiser guides need resolved images on the current GPU"};
        imageKey(key,image);
    }
    for(unsigned slot=0;slot<RS_SCENE_AOV_COUNT;++slot)if(inputs.mask&(1u<<slot)){
        const auto&image=packet.images[slot];imageKey(key,(__bridge id<MTLTexture>)image.texture);
        key.insert(key.end(),{image.x,image.y,image.width,image.height,image.encoding,image.space,image.channel,image.origin,
            bits(image.scale),bits(image.bias),image.pass});
    }
    colorKey(key,color);colorKey(key,inputs.aovColor);colorKey(key,inputs.working);return {true,{}};
}
struct Resources {
    id<MTLCommandQueue>queue;
    id<MTLTexture>cropped=nil,color=nil,output=nil,overlay=nil;
    SceneGuideTargets guides;
    SceneGuideEncoder guideEncoder;
    SceneAovNormalizer normalizer;
    ColorEncoder colors;
    Resources(id<MTLCommandQueue>q):queue(q),guideEncoder(q.device),normalizer(q),colors(q.device){}
};
enum class FlightStatus {Pending,Completed,Failed,Abandoned};
struct Flight {
    // No SDK or strong command-buffer reference: SDK implementations may
    // retain their last commands, including when the producer never submits.
    std::shared_ptr<Resources>resources;
    std::shared_ptr<const SceneAovLease>attachments;
    __weak id<MTLCommandBuffer>commands;
    uint64_t frame=0,view=0,epoch=0,revision=0;
    float jitterX=0,jitterY=0;
    std::atomic<FlightStatus>status{FlightStatus::Pending};
    ShaderResult result()const{
        switch(status.load(std::memory_order_acquire)){
            case FlightStatus::Completed:return {true,{}};
            case FlightStatus::Pending:return {false,"The denoised scene GPU work is pending",true};
            case FlightStatus::Abandoned:return {false,"The denoised scene commands were superseded before submission"};
            default:return {false,"The denoised scene GPU work failed"};
        }
    }
};
struct State {
    Key key;
    std::shared_ptr<Resources>resources;
    id scaler=nil;
    ImageColorDescription sourceColor,workingColor,aovColor;
    std::mutex mutex;
    std::shared_ptr<Flight>flight;
    bool poisoned=false;
    uint64_t frame=0,view=0,epoch=0,revision=0;
    float jitterX=0,jitterY=0;
};
struct FlightAttempt {
    std::shared_ptr<State>state;
    std::shared_ptr<Flight>flight;
    bool encoded=false;
    ~FlightAttempt(){if(!encoded){flight->status.store(FlightStatus::Failed,std::memory_order_release);state->poisoned=true;}}
};
id<MTLTexture>texture(id<MTLDevice>device,MTLPixelFormat format,unsigned width,unsigned height,uintptr_t owner,
    MTLTextureUsage usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget){
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];
    descriptor.storageMode=MTLStorageModePrivate;
    descriptor.usage=usage;
    auto value=newAdmittedTexture(device,descriptor,owner,"metalfx-denoised");
    if(!value)throw std::runtime_error("Cannot allocate admitted denoised scene images");return value;
}
std::shared_ptr<State>prepareState(id<MTLDevice>device,const RSTemporalFrame&frame,const ImageColorDescription&source,const Inputs&inputs){
    if(@available(macOS 26.0,*)){
        if(![MTLFXTemporalDenoisedScalerDescriptor supportsDevice:device])throw std::runtime_error("MetalFX denoised scaling is unavailable on this GPU");
        auto state=std::make_shared<State>();state->key=inputs.key;state->sourceColor=source;state->workingColor=inputs.working;state->aovColor=inputs.aovColor;
        auto commands=(__bridge id<MTLCommandBuffer>)frame.commandBuffer;
        auto resources=std::make_shared<Resources>(commands.commandQueue);state->resources=resources;
        const auto owner=reinterpret_cast<uintptr_t>(resources.get());
        resources->cropped=texture(device,((__bridge id<MTLTexture>)frame.color).pixelFormat,frame.renderWidth,frame.renderHeight,owner,MTLTextureUsageShaderRead);
        resources->color=texture(device,MTLPixelFormatRGBA16Float,frame.renderWidth,frame.renderHeight,owner);
        resources->output=texture(device,MTLPixelFormatRGBA16Float,frame.outputWidth,frame.outputHeight,owner);
        if(inputs.mask&(1u<<RS_SCENE_AOV_TRANSPARENCY))resources->overlay=texture(device,MTLPixelFormatRGBA16Float,frame.renderWidth,frame.renderHeight,owner);
        auto&guides=resources->guides;guides.width=frame.renderWidth;guides.height=frame.renderHeight;
        guides.depth=texture(device,MTLPixelFormatR32Float,frame.renderWidth,frame.renderHeight,owner);
        guides.motion=texture(device,MTLPixelFormatRG32Float,frame.renderWidth,frame.renderHeight,owner);
        if(frame.exposure&&!(frame.flags&RS_TEMPORAL_AUTO_EXPOSURE))guides.exposure=texture(device,MTLPixelFormatR16Float,1,1,owner);
        if(frame.reactive)guides.reactive=texture(device,MTLPixelFormatR32Float,frame.renderWidth,frame.renderHeight,owner);
        for(auto result:{resources->guideEncoder.prepare(),resources->normalizer.prepare(inputs.lease->value,frame.renderWidth,frame.renderHeight,inputs.mask,RS_SCENE_AOV_SPACE_WORLD,false),
            resources->colors.prepare(MTLPixelFormatRGBA16Float),resources->colors.prepare(((__bridge id<MTLTexture>)frame.output).pixelFormat)})
            if(!result.encoded){if(result.busy)throw ImageBudgetExceeded(result.reason);throw std::runtime_error(result.reason);}
        const auto layout=resources->normalizer.layout();
        auto descriptor=[MTLFXTemporalDenoisedScalerDescriptor new];
        descriptor.inputWidth=frame.renderWidth;descriptor.inputHeight=frame.renderHeight;
        descriptor.outputWidth=frame.outputWidth;descriptor.outputHeight=frame.outputHeight;
        descriptor.colorTextureFormat=resources->color.pixelFormat;descriptor.outputTextureFormat=resources->output.pixelFormat;
        descriptor.depthTextureFormat=guides.depth.pixelFormat;descriptor.motionTextureFormat=guides.motion.pixelFormat;
        descriptor.normalTextureFormat=((__bridge id<MTLTexture>)layout.images[RS_SCENE_AOV_NORMAL].texture).pixelFormat;
        descriptor.roughnessTextureFormat=((__bridge id<MTLTexture>)layout.images[RS_SCENE_AOV_ROUGHNESS].texture).pixelFormat;
        descriptor.diffuseAlbedoTextureFormat=((__bridge id<MTLTexture>)layout.images[RS_SCENE_AOV_DIFFUSE_ALBEDO].texture).pixelFormat;
        descriptor.specularAlbedoTextureFormat=((__bridge id<MTLTexture>)layout.images[RS_SCENE_AOV_SPECULAR_ALBEDO].texture).pixelFormat;
        descriptor.autoExposureEnabled=bool(frame.flags&RS_TEMPORAL_AUTO_EXPOSURE);
        descriptor.reactiveMaskTextureEnabled=guides.reactive!=nil;
        if(guides.reactive)descriptor.reactiveMaskTextureFormat=guides.reactive.pixelFormat;
        descriptor.specularHitDistanceTextureEnabled=bool(inputs.mask&(1u<<RS_SCENE_AOV_SPECULAR_HIT_DISTANCE));
        if(descriptor.specularHitDistanceTextureEnabled)descriptor.specularHitDistanceTextureFormat=((__bridge id<MTLTexture>)layout.images[RS_SCENE_AOV_SPECULAR_HIT_DISTANCE].texture).pixelFormat;
        descriptor.denoiseStrengthMaskTextureEnabled=bool(inputs.mask&(1u<<RS_SCENE_AOV_DENOISE_MASK));
        if(descriptor.denoiseStrengthMaskTextureEnabled)descriptor.denoiseStrengthMaskTextureFormat=((__bridge id<MTLTexture>)layout.images[RS_SCENE_AOV_DENOISE_MASK].texture).pixelFormat;
        descriptor.transparencyOverlayTextureEnabled=bool(inputs.mask&(1u<<RS_SCENE_AOV_TRANSPARENCY));
        if(descriptor.transparencyOverlayTextureEnabled)descriptor.transparencyOverlayTextureFormat=resources->overlay.pixelFormat;
        descriptor.requiresSynchronousInitialization=YES;
        {InternalTemporalScope scope;state->scaler=[descriptor newTemporalDenoisedScalerWithDevice:device];}
        if(!state->scaler)throw std::runtime_error("MetalFX cannot create a denoised scaler for the declared formats and extents");
        id<MTLFXTemporalDenoisedScaler>scaler=state->scaler;
        auto fits=[](id<MTLTexture>image,MTLTextureUsage usage){return image&&(image.usage&usage)==usage;};
        if(!fits(resources->color,scaler.colorTextureUsage)||!fits(resources->output,scaler.outputTextureUsage)||
            !fits(guides.depth,scaler.depthTextureUsage)||!fits(guides.motion,scaler.motionTextureUsage)||
            !fits((__bridge id<MTLTexture>)layout.images[RS_SCENE_AOV_NORMAL].texture,scaler.normalTextureUsage)||
            !fits((__bridge id<MTLTexture>)layout.images[RS_SCENE_AOV_ROUGHNESS].texture,scaler.roughnessTextureUsage)||
            !fits((__bridge id<MTLTexture>)layout.images[RS_SCENE_AOV_DIFFUSE_ALBEDO].texture,scaler.diffuseAlbedoTextureUsage)||
            !fits((__bridge id<MTLTexture>)layout.images[RS_SCENE_AOV_SPECULAR_ALBEDO].texture,scaler.specularAlbedoTextureUsage))
            throw std::runtime_error("The admitted scene images do not meet this MetalFX denoiser's texture-usage requirements");
        if(guides.reactive){
            const auto usage=scaler.reactiveTextureUsage;
            if(!fits(guides.reactive,usage))throw std::runtime_error("The admitted reactive mask does not meet MetalFX usage requirements");
        }
        for(auto slot:{RS_SCENE_AOV_SPECULAR_HIT_DISTANCE,RS_SCENE_AOV_DENOISE_MASK,RS_SCENE_AOV_TRANSPARENCY})if(inputs.mask&(1u<<slot)){
            const auto usage=slot==RS_SCENE_AOV_SPECULAR_HIT_DISTANCE?scaler.specularHitDistanceTextureUsage:
                slot==RS_SCENE_AOV_DENOISE_MASK?scaler.denoiseStrengthMaskTextureUsage:scaler.transparencyOverlayTextureUsage;
            if(!fits(slot==RS_SCENE_AOV_TRANSPARENCY?resources->overlay:(__bridge id<MTLTexture>)layout.images[slot].texture,usage))
                throw std::runtime_error("An admitted denoiser attachment does not meet MetalFX usage requirements");
        }
        return state;
    }
    throw std::runtime_error("MetalFX denoised scaling requires macOS 26 or later");
}
class Encoder final:public SceneComputeEncoder {
    id<MTLDevice>device;
    std::mutex mutex;
    ImageColorDescription color;
    std::shared_ptr<State>state;
    std::shared_ptr<Flight>last;
public:
    explicit Encoder(id<MTLDevice>d):device(d){}
    void setColorDescription(const ImageColorDescription&value)override{std::lock_guard guard(mutex);color=value;}
    ShaderResult framePreparationStatus(const RSTemporalFrame&frame)override{
        std::shared_ptr<State>current;{std::lock_guard guard(mutex);current=state;}if(!current)return {false,"Prepare the denoised scene resources"};
        std::unique_lock lock(current->mutex,std::try_to_lock);if(!lock)return {true,{}};
        if(auto flight=current->flight;flight&&flight->status.load(std::memory_order_acquire)==FlightStatus::Pending){auto commands=flight->commands;
            if(commands&&commands.status==MTLCommandBufferStatusCompleted){current->frame=flight->frame;current->view=flight->view;current->epoch=flight->epoch;current->revision=flight->revision;current->jitterX=flight->jitterX;current->jitterY=flight->jitterY;flight->status.store(FlightStatus::Completed,std::memory_order_release);}
            else if(commands&&commands.status==MTLCommandBufferStatusError){current->poisoned=true;flight->status.store(FlightStatus::Failed,std::memory_order_release);}
            else if(!commands||(commands.status<MTLCommandBufferStatusCommitted&&commands!=(__bridge id<MTLCommandBuffer>)frame.commandBuffer)){current->poisoned=true;flight->status.store(FlightStatus::Abandoned,std::memory_order_release);}
        }
        return current->poisoned?ShaderResult{false,"Prepare fresh denoiser history after discarded or failed commands"}:ShaderResult{true,{}};
    }
    ShaderResult prepare(const RSTemporalFrame&frame)override{@autoreleasepool{@try{try{
        ImageColorDescription source;std::shared_ptr<State>previous;{std::lock_guard guard(mutex);source=color;previous=state;}
        Inputs inputs;auto valid=inspect(device,frame,source,inputs);if(!valid.encoded)return valid;
        if(previous){
            std::lock_guard guard(previous->mutex);
            if(previous->key==inputs.key&&!previous->poisoned)return {true,{}};
        }
        // Only the shared preparation worker calls this method. SDK creation,
        // synchronous compilation and every GPU allocation stay off encode.
        if([NSThread isMainThread])return {false,"Prepare MetalFX denoised scene resources on the graphics preparation worker",true};
        auto next=prepareState(device,frame,source,inputs);
        std::lock_guard guard(mutex);if(!sameImageColorDescription(source,color))return {false,"The scene color changed during denoiser preparation",true};
        state=std::move(next);return {true,{}};
    }catch(const ImageBudgetExceeded&error){return {false,error.what(),true};}
     catch(const std::exception&error){return {false,error.what()};}
    }@catch(NSException*error){return {false,error.reason.UTF8String?:"MetalFX denoiser preparation failed"};}}}
    ShaderResult encode(const RSTemporalFrame&frame)override{@autoreleasepool{@try{try{
        if(@available(macOS 26.0,*)){
            ImageColorDescription source;std::shared_ptr<State>selected;{std::lock_guard guard(mutex);source=color;selected=state;}
            Inputs inputs;auto valid=inspect(device,frame,source,inputs);if(!valid.encoded)return valid;
            if(!selected||selected->key!=inputs.key)return {false,"Prepare denoised scene resources for the actual queue and image contract",true};
            std::unique_lock lock(selected->mutex,std::try_to_lock);
            if(!lock.owns_lock())return {false,"The denoised scene owner is busy",true};
            if(selected->poisoned)return {false,"Prepare fresh denoiser history after discarded commands",true};
            if(selected->flight&&selected->flight->status.load(std::memory_order_acquire)==FlightStatus::Pending)
                return {false,"A denoised scene frame is still in flight",true};
            MetalFxScalerMutation mutation(selected->scaler);
            if(!mutation)return {false,"The owned denoised scaler is retained by matching interpolation work",true};
            const auto&packet=inputs.lease->value;
            const bool sameEpoch=selected->view==packet.viewId&&selected->epoch==packet.epoch&&selected->revision==packet.imageRevision;
            if(sameEpoch&&selected->frame&&frame.frameId<=selected->frame&&!(frame.flags&RS_TEMPORAL_RESET))
                return {false,"Denoised scene frame identities must increase"};
            auto commands=(__bridge id<MTLCommandBuffer>)frame.commandBuffer;
            const auto resources=selected->resources;
            auto flight=std::make_shared<Flight>();flight->commands=commands;flight->resources=resources;flight->attachments=inputs.lease;
            flight->frame=frame.frameId;flight->view=packet.viewId;flight->epoch=packet.epoch;flight->revision=packet.imageRevision;
            flight->jitterX=frame.jitterX;flight->jitterY=frame.jitterY;
            selected->flight=flight;{std::lock_guard guard(mutex);last=flight;}
            FlightAttempt attempt{selected,flight};
            const std::weak_ptr<State>weak=selected;
            [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){
                const auto result=completed.status==MTLCommandBufferStatusCompleted?FlightStatus::Completed:FlightStatus::Failed;
                if(auto current=weak.lock()){std::lock_guard guard(current->mutex);
                    if(current->flight!=flight||flight->status.load(std::memory_order_acquire)!=FlightStatus::Pending)return;
                    if(result==FlightStatus::Completed){current->frame=flight->frame;current->view=flight->view;current->epoch=flight->epoch;current->revision=flight->revision;current->jitterX=flight->jitterX;current->jitterY=flight->jitterY;}
                    else current->poisoned=true;
                    // Publish readiness only after accepted history is coherent.
                    flight->status.store(result,std::memory_order_release);
                }else{
                    auto expected=FlightStatus::Pending;flight->status.compare_exchange_strong(expected,result,std::memory_order_acq_rel);
                }
            }];
            auto fail=[&](ShaderResult result){flight->status.store(FlightStatus::Failed,std::memory_order_release);selected->poisoned=true;return result;};
            auto copy=[commands blitCommandEncoder];if(!copy)return fail({false,"Cannot crop the real denoiser color",true});
            [copy copyFromTexture:(__bridge id<MTLTexture>)frame.color sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(frame.colorX,frame.colorY,0)
                sourceSize:MTLSizeMake(frame.renderWidth,frame.renderHeight,1) toTexture:resources->cropped destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];
            ColorConversion enter;enter.source=selected->sourceColor;enter.target=selected->workingColor;enter.frameId=frame.frameId;
            auto result=resources->colors.encode(commands,resources->cropped,resources->color,enter);if(!result.encoded)return fail(result);
            auto guideInput=frame;guideInput.transparency=nullptr;if(frame.flags&RS_TEMPORAL_AUTO_EXPOSURE)guideInput.exposure=nullptr;
            auto normalized=frame;normalized.colorX=normalized.colorY=0;
            const bool reset=!selected->frame||!sameEpoch||frame.frameId!=selected->frame+1||bool(frame.flags&RS_TEMPORAL_RESET);
            const bool removeMotionJitter=frame.flags&RS_TEMPORAL_JITTERED_MOTION;
            const float correctionX=removeMotionJitter&&!reset?(frame.jitterX-selected->jitterX)/frame.renderWidth:0,
                correctionY=removeMotionJitter&&!reset?(frame.jitterY-selected->jitterY)/frame.renderHeight:0;
            result=resources->guideEncoder.encode(commands,guideInput,resources->guides,normalized,correctionX,correctionY,
                bool(frame.flags&RS_TEMPORAL_JITTERED_MOTION),true);
            if(!result.encoded)return fail(result);
            RSSceneAovs aovs{};result=resources->normalizer.encode(commands,packet,temporalSceneMatrices(frame),aovs);if(!result.encoded)return fail(result);
            if(resources->overlay){
                ColorConversion overlay;overlay.source=selected->aovColor;overlay.target=selected->workingColor;overlay.frameId=frame.frameId;
                result=resources->colors.encode(commands,(__bridge id<MTLTexture>)aovs.images[RS_SCENE_AOV_TRANSPARENCY].texture,resources->overlay,overlay);
                if(!result.encoded)return fail(result);
            }
            id<MTLFXTemporalDenoisedScaler>scaler=selected->scaler;
            scaler.colorTexture=resources->color;scaler.depthTexture=resources->guides.depth;scaler.motionTexture=resources->guides.motion;
            scaler.outputTexture=resources->output;scaler.exposureTexture=resources->guides.exposure;scaler.reactiveMaskTexture=resources->guides.reactive;
            scaler.normalTexture=(__bridge id<MTLTexture>)aovs.images[RS_SCENE_AOV_NORMAL].texture;
            scaler.roughnessTexture=(__bridge id<MTLTexture>)aovs.images[RS_SCENE_AOV_ROUGHNESS].texture;
            scaler.diffuseAlbedoTexture=(__bridge id<MTLTexture>)aovs.images[RS_SCENE_AOV_DIFFUSE_ALBEDO].texture;
            scaler.specularAlbedoTexture=(__bridge id<MTLTexture>)aovs.images[RS_SCENE_AOV_SPECULAR_ALBEDO].texture;
            scaler.specularHitDistanceTexture=(__bridge id<MTLTexture>)aovs.images[RS_SCENE_AOV_SPECULAR_HIT_DISTANCE].texture;
            scaler.denoiseStrengthMaskTexture=(__bridge id<MTLTexture>)aovs.images[RS_SCENE_AOV_DENOISE_MASK].texture;
            scaler.transparencyOverlayTexture=resources->overlay;
            scaler.jitterOffsetX=normalized.jitterX;scaler.jitterOffsetY=normalized.jitterY;
            scaler.motionVectorScaleX=normalized.motionScaleX;scaler.motionVectorScaleY=normalized.motionScaleY;
            scaler.preExposure=frame.preExposure;scaler.depthReversed=bool(frame.flags&RS_TEMPORAL_DEPTH_REVERSED);
            scaler.shouldResetHistory=reset;
            simd_float4x4 view,projection;std::memcpy(&view,inputs.matrices.view,sizeof(view));std::memcpy(&projection,inputs.matrices.projection,sizeof(projection));
            scaler.worldToViewMatrix=view;scaler.viewToClipMatrix=projection;
            {InternalTemporalScope scope;[scaler encodeToCommandBuffer:commands];}
            ColorConversion leave;leave.source=selected->workingColor;leave.source.alpha=ColorAlpha::Opaque;leave.target=selected->sourceColor;
            leave.alphaSource=resources->cropped;leave.frameId=frame.frameId;leave.outputX=frame.outputX;leave.outputY=frame.outputY;
            leave.outputWidth=frame.outputWidth;leave.outputHeight=frame.outputHeight;
            result=resources->colors.encode(commands,resources->output,(__bridge id<MTLTexture>)frame.output,leave);
            if(!result.encoded)return fail(result);
            // Link only the RGB-identity output boundary. A gamut/transfer or
            // storage conversion is a distinct image and stays standalone.
            auto outputRGB=selected->sourceColor;outputRGB.alpha=selected->workingColor.alpha;
            if(selected->sourceColor.alpha!=ColorAlpha::Premultiplied&&sameImageColorDescription(outputRGB,selected->workingColor)&&
                ((__bridge id<MTLTexture>)frame.output).pixelFormat==resources->output.pixelFormat&&
                !frame.outputX&&!frame.outputY){
                auto sdkFrame=normalized;sdkFrame.owner=frame.owner;sdkFrame.frameId=frame.frameId;
                sdkFrame.color=(__bridge void*)resources->color;sdkFrame.depth=(__bridge void*)resources->guides.depth;sdkFrame.motion=(__bridge void*)resources->guides.motion;sdkFrame.output=(__bridge void*)resources->output;
                sdkFrame.exposure=(__bridge void*)resources->guides.exposure;sdkFrame.reactive=(__bridge void*)resources->guides.reactive;sdkFrame.transparency=(__bridge void*)resources->overlay;
                sdkFrame.colorX=sdkFrame.colorY=sdkFrame.depthX=sdkFrame.depthY=sdkFrame.motionX=sdkFrame.motionY=sdkFrame.outputX=sdkFrame.outputY=0;
                sdkFrame.renderWidth=frame.renderWidth;sdkFrame.renderHeight=frame.renderHeight;sdkFrame.outputWidth=frame.outputWidth;sdkFrame.outputHeight=frame.outputHeight;
                if(reset)sdkFrame.flags|=RS_TEMPORAL_RESET;
                mutation.publish(sdkFrame,MetalFxScalerProfile::Denoised,selected->sourceColor,(__bridge id<MTLTexture>)frame.output,resources);
            }
            attempt.encoded=true;return {true,{}};
        }
        return {false,"MetalFX denoised scaling requires macOS 26 or later"};
    }catch(const std::exception&error){return {false,error.what()};}
    }@catch(NSException*error){return {false,error.reason.UTF8String?:"MetalFX denoising could not encode the scene"};}}}
    ShaderResult completion()override{std::lock_guard guard(mutex);return last?last->result():ShaderResult{false,"No denoised scene has been encoded"};}
    std::function<ShaderResult()>completionTicket()override{std::lock_guard guard(mutex);auto flight=last;return [flight]{return flight?flight->result():ShaderResult{false,"No denoised scene has been encoded"};};}
};
}
std::shared_ptr<SceneComputeEncoder>makeMetalFxDenoisedEncoder(id<MTLDevice>device){return std::make_shared<Encoder>(device);}
}

uint32_t macfx::metalFxDenoisedAovDemand()noexcept{return requiredAovs;}
