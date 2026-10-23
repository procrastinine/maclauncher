#include "temporal-frame.h"
#include "temporal-camera.h"
#include "temporal-controls.hpp"
#include "log.hpp"
#include "temporal-plan.hpp"
#include "frame-capture.hpp"
#import <MetalFX/MetalFX.h>
#import <objc/runtime.h>
#include <dlfcn.h>
#include <atomic>
#include <array>
#include <cmath>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <cstdio>
#import <QuartzCore/QuartzCore.h>

namespace {
thread_local bool internalScaler=false;
struct InternalScope {bool before=internalScaler;InternalScope(){internalScaler=true;}~InternalScope(){internalScaler=before;}};
int answer(RSTemporalResult *r,uint32_t status,const char *reason){r->status=status;snprintf(r->reason,sizeof(r->reason),"%s",reason?reason:"");return status;}
bool texture(id<MTLTexture> t,id<MTLDevice> d){return t&&t.device==d&&t.textureType==MTLTextureType2D&&t.sampleCount==1;}
bool region(id<MTLTexture> t,uint32_t x,uint32_t y,uint32_t w,uint32_t h){return w&&h&&x<=t.width&&y<=t.height&&w<=t.width-x&&h<=t.height-y;}
bool finite(const RSTemporalFrame &f){return std::isfinite(f.jitterX)&&std::isfinite(f.jitterY)&&std::isfinite(f.motionScaleX)&&std::isfinite(f.motionScaleY)&&std::isfinite(f.preExposure)&&f.preExposure>0&&std::isfinite(f.sharpness)&&f.sharpness>=0&&f.sharpness<=1&&std::isfinite(f.frameTimeMs)&&f.frameTimeMs>0;}
bool validCamera(const RSTemporalCamera *c){
    constexpr uint32_t allowed=RS_TEMPORAL_RESET|RS_TEMPORAL_DEPTH_REVERSED|RS_TEMPORAL_DEPTH_INFINITE|RS_TEMPORAL_HDR|RS_TEMPORAL_JITTERED_MOTION|RS_TEMPORAL_OUTPUT_MOTION;
    return c&&c->size==sizeof(*c)&&c->version==1&&c->frameId&&!(c->flags&~allowed)&&!c->reserved&&
        !c->reserved2[0]&&!c->reserved2[1]&&!c->reserved2[2]&&!c->reserved2[3]&&
        std::isfinite(c->nearPlane)&&c->nearPlane>0&&std::isfinite(c->verticalFov)&&c->verticalFov>0&&c->verticalFov<3.14159265f&&
        std::isfinite(c->frameTimeMs)&&c->frameTimeMs>=0&&c->frameTimeMs<=1000&&
        (c->flags&RS_TEMPORAL_DEPTH_INFINITE?c->farPlane==0:(std::isfinite(c->farPlane)&&c->farPlane>c->nearPlane));
}
struct CameraTextures {
    void *owner=nullptr;
    __weak id color=nil,depth=nil,motion=nil;
    RSTemporalCamera camera{};
    bool pending=false,blocked=false;
};
std::array<CameraTextures,64> textureCameras;
std::mutex textureCameraMutex;
std::atomic<unsigned> textureCameraCount{0};
void recountCameras(){unsigned count=0;for(auto &record:textureCameras)if(record.pending)++count;textureCameraCount.store(count,std::memory_order_release);}
bool takeTextureCamera(id color,id depth,id motion,RSTemporalCamera &camera){
    if(!textureCameraCount.load(std::memory_order_acquire))return false;
    std::lock_guard<std::mutex> lock(textureCameraMutex);
    bool found=false;
    for(auto &record:textureCameras){
        if(!record.pending)continue;
        if(!record.color||!record.depth||!record.motion){record={};continue;}
        if(record.color==color&&record.depth==depth&&record.motion==motion){camera=record.camera;record={};found=true;}
    }
    recountCameras();return found;
}

extern "C" void rsClearTemporalCameraTextures(void *owner){
    if(!owner)return;
    std::lock_guard<std::mutex> lock(textureCameraMutex);
    for(auto &record:textureCameras)if(record.owner==owner)record={};
    recountCameras();
}
extern "C" int rsSetTemporalCameraForTextures(void *owner,void *color,void *depth,void *motion,const RSTemporalCamera *camera){
    if(!owner)return RS_TEMPORAL_INVALID;
    if(!camera){rsClearTemporalCameraTextures(owner);return RS_TEMPORAL_OK;}
    if(!color||!depth||!motion||!validCamera(camera)){
        rsClearTemporalCameraTextures(owner);return RS_TEMPORAL_INVALID;
    }
    id<MTLTexture> c=(__bridge id)color,d=(__bridge id)depth,m=(__bridge id)motion;
    if(!texture(c,c.device)||!texture(d,c.device)||!texture(m,c.device)){
        rsClearTemporalCameraTextures(owner);return RS_TEMPORAL_INVALID;
    }
    std::lock_guard<std::mutex> lock(textureCameraMutex);
    CameraTextures *free=nullptr;
    for(auto &record:textureCameras){
        if(record.owner&&(!record.color||!record.depth||!record.motion))record={};
        if(!record.owner){if(!free)free=&record;continue;}
        if(record.color==c&&record.depth==d&&record.motion==m){
            // A collision invalidates both submissions until the owner's next
            // explicit frame boundary. No later registration can replace it.
            record.pending=false;record.blocked=true;recountCameras();return RS_TEMPORAL_BUSY;
        }
    }
    if(!free)return RS_TEMPORAL_BUSY;
    free->owner=owner;free->color=c;free->depth=d;free->motion=m;free->camera=*camera;free->pending=true;
    recountCameras();return RS_TEMPORAL_OK;
}
std::array<std::atomic<const RSTemporalProvider*>,3> loadedProviders{};
struct Provider {
    void *library=nullptr;const RSTemporalProvider *api=nullptr;
    explicit Provider(const char *name,unsigned slot){const auto path=getenv(name);if(!path||path[0]!='/')return;
        library=dlopen(path,RTLD_NOW|RTLD_LOCAL);if(!library){macfx::nativeLog("Temporal provider could not load");return;}
        const auto get=reinterpret_cast<RSGetTemporalProvider>(dlsym(library,"rsGetTemporalProvider"));if(get)api=get(1);
        if(!api||api->size<sizeof(RSTemporalProvider)||api->version!=1||!api->encode||!api->release)api=nullptr;
        loadedProviders[slot].store(api,std::memory_order_release);
    }
};
const RSTemporalProvider *provider(unsigned method){
    if(method==RS_TEMPORAL_FSR4){static Provider p("RESHADE_FSR4_LIBRARY",2);return p.api;}
    if(method==RS_TEMPORAL_FSR3){static Provider p("RESHADE_FSR3_LIBRARY",1);return p.api;}
    if(method==RS_TEMPORAL_FSR2){static Provider p("RESHADE_FSR2_LIBRARY",0);return p.api;}return nullptr;
}
struct Scaler {
    id<MTLDevice> device;id<MTLFXTemporalScaler> scaler;
    std::array<uint64_t,10> key{};std::mutex mutex;
    std::atomic<bool> pending{false},reset{true};uint64_t frame=0;
};
struct Completion {
    std::weak_ptr<Scaler> context;
    std::atomic<bool> finished{false};
    explicit Completion(const std::shared_ptr<Scaler>& c):context(c){}
    void finish(bool success){if(finished.exchange(true))return;if(auto c=context.lock()){if(!success)c->reset=true;c->pending=false;}}
    ~Completion(){finish(false);}
};
std::mutex ownersMutex;std::unordered_map<void*,std::shared_ptr<Scaler>> owners;
std::shared_ptr<Scaler> owner(void *key){std::lock_guard<std::mutex> lock(ownersMutex);auto &p=owners[key];if(!p)p=std::make_shared<Scaler>();return p;}
int metalfx(const RSTemporalFrame &f,RSTemporalResult *r){
    if(f.commandBufferKind)return answer(r,RS_TEMPORAL_UNAVAILABLE,"This temporal entry point uses a Metal command buffer.");
    auto commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;
    auto c=(__bridge id<MTLTexture>)f.color,d=(__bridge id<MTLTexture>)f.depth,m=(__bridge id<MTLTexture>)f.motion,o=(__bridge id<MTLTexture>)f.output;
    auto device=commands.device;if(![MTLFXTemporalScalerDescriptor supportsDevice:device])return answer(r,RS_TEMPORAL_UNAVAILABLE,"MetalFX Temporal is unavailable on this device.");
    if(commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences)return answer(r,RS_TEMPORAL_INVALID,"A retaining, uncommitted Metal command buffer is required.");
    if(o.storageMode!=MTLStorageModePrivate)return answer(r,RS_TEMPORAL_INVALID,"MetalFX requires a private output texture.");
    if(f.exposure){auto exposure=(__bridge id<MTLTexture>)f.exposure;if(exposure.width!=1||exposure.height!=1||exposure.pixelFormat!=MTLPixelFormatR16Float)return answer(r,RS_TEMPORAL_INVALID,"MetalFX requires a 1 by 1 R16Float exposure texture.");}
    if(f.flags&(RS_TEMPORAL_OUTPUT_MOTION|RS_TEMPORAL_JITTERED_MOTION)){if(@available(macOS 27.0,*)){}else return answer(r,RS_TEMPORAL_UNAVAILABLE,"These motion-vector conventions require macOS 27 or later.");}
    if(f.colorX||f.colorY||f.depthX||f.depthY||f.motionX||f.motionY||f.outputX||f.outputY){if(@available(macOS 27.0,*)){}else return answer(r,RS_TEMPORAL_UNAVAILABLE,"Temporal texture subregions require macOS 27 or later.");}
    auto context=owner(f.owner);std::unique_lock<std::mutex> lock(context->mutex,std::try_to_lock);
    if(!lock.owns_lock()||context->pending.load())return answer(r,RS_TEMPORAL_BUSY,"A temporal frame is still in flight.");
    if(context->frame&&f.frameId<=context->frame&&!(f.flags&RS_TEMPORAL_RESET))return answer(r,RS_TEMPORAL_INVALID,"Temporal frame identities must increase.");
    const auto maxW=f.maxRenderWidth?f.maxRenderWidth:f.renderWidth,maxH=f.maxRenderHeight?f.maxRenderHeight:f.renderHeight;
    const std::array<uint64_t,10> key={maxW,maxH,f.outputWidth,f.outputHeight,c.pixelFormat,d.pixelFormat,m.pixelFormat,o.pixelFormat,f.flags&~(RS_TEMPORAL_RESET|RS_TEMPORAL_CAMERA_VALID|RS_TEMPORAL_DEPTH_REVERSED|RS_TEMPORAL_DEPTH_INFINITE),f.reactive?((__bridge id<MTLTexture>)f.reactive).pixelFormat:0};
    if(context->key!=key||context->device!=device||!context->scaler){
        auto descriptor=[MTLFXTemporalScalerDescriptor new];descriptor.inputWidth=maxW;descriptor.inputHeight=maxH;descriptor.outputWidth=f.outputWidth;descriptor.outputHeight=f.outputHeight;
        descriptor.colorTextureFormat=c.pixelFormat;descriptor.depthTextureFormat=d.pixelFormat;descriptor.motionTextureFormat=m.pixelFormat;descriptor.outputTextureFormat=o.pixelFormat;
        descriptor.autoExposureEnabled=bool(f.flags&RS_TEMPORAL_AUTO_EXPOSURE);descriptor.inputContentPropertiesEnabled=YES;
        if(@available(macOS 14.0,*)){descriptor.inputContentMinScale=[MTLFXTemporalScalerDescriptor supportedInputContentMinScaleForDevice:device];descriptor.inputContentMaxScale=[MTLFXTemporalScalerDescriptor supportedInputContentMaxScaleForDevice:device];}
        else {descriptor.inputContentMinScale=1;descriptor.inputContentMaxScale=2;}
        if(@available(macOS 14.4,*)){descriptor.reactiveMaskTextureEnabled=f.reactive!=nullptr;if(f.reactive)descriptor.reactiveMaskTextureFormat=((__bridge id<MTLTexture>)f.reactive).pixelFormat;}
        else if(f.reactive)return answer(r,RS_TEMPORAL_UNAVAILABLE,"A temporal reactive mask requires macOS 14.4 or later.");
        if(@available(macOS 27.0,*)){descriptor.outputResolutionMotionVectorsEnabled=bool(f.flags&RS_TEMPORAL_OUTPUT_MOTION);descriptor.jitteredMotionVectorsEnabled=bool(f.flags&RS_TEMPORAL_JITTERED_MOTION);}
        InternalScope scope;auto next=[descriptor newTemporalScalerWithDevice:device];if(!next)return answer(r,RS_TEMPORAL_UNAVAILABLE,"MetalFX could not create a temporal scaler for these inputs.");
        context->scaler=next;context->key=key;context->device=device;context->reset=true;
    }
    auto s=context->scaler;
    if((c.usage&s.colorTextureUsage)!=s.colorTextureUsage||(d.usage&s.depthTextureUsage)!=s.depthTextureUsage||(m.usage&s.motionTextureUsage)!=s.motionTextureUsage||(o.usage&s.outputTextureUsage)!=s.outputTextureUsage)return answer(r,RS_TEMPORAL_INVALID,"Temporal textures do not meet MetalFX usage requirements.");
    if(f.reactive){if(@available(macOS 14.4,*)){auto mask=(__bridge id<MTLTexture>)f.reactive;
        if((mask.usage&s.reactiveTextureUsage)!=s.reactiveTextureUsage)return answer(r,RS_TEMPORAL_INVALID,"The reactive mask does not meet MetalFX usage requirements.");}}
    s.colorTexture=c;s.depthTexture=d;s.motionTexture=m;s.outputTexture=o;s.exposureTexture=(__bridge id<MTLTexture>)f.exposure;
    if(@available(macOS 14.4,*))s.reactiveMaskTexture=(__bridge id<MTLTexture>)f.reactive;
    s.inputContentWidth=f.renderWidth;s.inputContentHeight=f.renderHeight;s.jitterOffsetX=f.jitterX;s.jitterOffsetY=f.jitterY;s.motionVectorScaleX=f.motionScaleX;s.motionVectorScaleY=f.motionScaleY;s.preExposure=f.preExposure;
    s.depthReversed=bool(f.flags&RS_TEMPORAL_DEPTH_REVERSED);s.reset=context->reset.exchange(false)||bool(f.flags&RS_TEMPORAL_RESET)||(context->frame&&f.frameId!=context->frame+1);
    if(@available(macOS 27.0,*)){s.colorContentOffsetX=f.colorX;s.colorContentOffsetY=f.colorY;s.depthContentOffsetX=f.depthX;s.depthContentOffsetY=f.depthY;s.motionContentOffsetX=f.motionX;s.motionContentOffsetY=f.motionY;s.reactiveMaskContentOffsetX=f.colorX;s.reactiveMaskContentOffsetY=f.colorY;s.outputOffsetX=f.outputX;s.outputOffsetY=f.outputY;}
    r->reset=s.reset;
    {InternalScope scope;[s encodeToCommandBuffer:commands];}
    context->pending=true;context->frame=f.frameId;
    // Retaining command buffers own the encoded Metal resources. A weak owner
    // avoids a cycle if a scaler internally retains its latest command buffer.
    auto completion=std::make_shared<Completion>(context);
    [commands addCompletedHandler:^(id<MTLCommandBuffer> completed){completion->finish(completed.status==MTLCommandBufferStatusCompleted);}];
    r->encoded=1;return answer(r,RS_TEMPORAL_OK,"");
}
}
extern "C" int rsProcessTemporalFrame(const RSTemporalFrame *f,RSTemporalResult *r){
    if(!r||r->size<sizeof(*r)||r->version!=1)return RS_TEMPORAL_INVALID;
    r->encoded=r->reset=0;r->reason[0]=0;r->method=f?f->method:0;
    if(!f||f->size<sizeof(*f)||f->version!=1||!f->owner||!f->commandBuffer||!f->frameId||f->method<1||f->method>4||f->flags>255||f->reserved||f->commandBufferKind>1||!finite(*f))return answer(r,RS_TEMPORAL_INVALID,"Invalid temporal frame inputs.");
    @autoreleasepool{@try{try{
        id commands=(__bridge id)f->commandBuffer;id<MTLDevice> device=[commands device];
        auto c=(__bridge id<MTLTexture>)f->color,d=(__bridge id<MTLTexture>)f->depth,m=(__bridge id<MTLTexture>)f->motion,o=(__bridge id<MTLTexture>)f->output;
        const bool outputMotion=f->flags&RS_TEMPORAL_OUTPUT_MOTION;
        if(!texture(c,device)||!texture(d,device)||!texture(m,device)||!texture(o,device)||c==o||d==o||m==o||
           !region(c,f->colorX,f->colorY,f->renderWidth,f->renderHeight)||!region(d,f->depthX,f->depthY,f->renderWidth,f->renderHeight)||
           !region(m,f->motionX,f->motionY,outputMotion?f->outputWidth:f->renderWidth,outputMotion?f->outputHeight:f->renderHeight)||!region(o,f->outputX,f->outputY,f->outputWidth,f->outputHeight))return answer(r,RS_TEMPORAL_INVALID,"Temporal textures must have matching devices, regions and motion-vector dimensions.");
        const uint32_t maxW=f->maxRenderWidth?:f->renderWidth,maxH=f->maxRenderHeight?:f->renderHeight;
        if(maxW<f->renderWidth||maxH<f->renderHeight||maxW>c.width||maxH>c.height||maxW>d.width||maxH>d.height||maxW>16384||maxH>16384||f->outputWidth>16384||f->outputHeight>16384)return answer(r,RS_TEMPORAL_INVALID,"Invalid maximum temporal render dimensions.");
        for(const auto optional:{f->exposure,f->reactive,f->transparency})if(optional&&(!texture((__bridge id<MTLTexture>)optional,device)||optional==f->output))return answer(r,RS_TEMPORAL_INVALID,"Invalid optional temporal texture.");
        if(f->exposure&&!region((__bridge id<MTLTexture>)f->exposure,0,0,1,1))return answer(r,RS_TEMPORAL_INVALID,"Invalid exposure texture dimensions.");
        for(const auto mask:{f->reactive,f->transparency})if(mask&&!region((__bridge id<MTLTexture>)mask,f->colorX,f->colorY,f->renderWidth,f->renderHeight))return answer(r,RS_TEMPORAL_INVALID,"Invalid temporal mask dimensions.");
        if(f->method==RS_TEMPORAL_METALFX)return metalfx(*f,r);
        const auto p=provider(f->method);if(!p||!(p->methods&(1u<<f->method)))return answer(r,RS_TEMPORAL_UNAVAILABLE,"The selected temporal provider is unavailable.");
        return p->encode(f,r);
    }catch(const std::exception&e){return answer(r,RS_TEMPORAL_FAILED,e.what());}}@catch(NSException*e){return answer(r,RS_TEMPORAL_FAILED,e.reason.UTF8String?:"Temporal encoding failed.");}}
}
extern "C" void rsReleaseTemporalOwner(void *key){
    {std::lock_guard<std::mutex> lock(ownersMutex);owners.erase(key);}
    for(auto &slot:loadedProviders)if(const auto p=slot.load(std::memory_order_acquire))p->release(key);
}

// Capture only an application's declared temporal-scaler interface. Render
// targets elsewhere in the command stream are never guessed to be motion or depth.
@interface MLTemporalOwner : NSObject {
@public
    IMP original;
    uint32_t descriptorFlags,kind,lastMethod;
    uint64_t frame,failedShape;
    double previousTime;
    bool reset,originalReset,reported;
    std::mutex cameraMutex;
    RSTemporalCamera camera;
    __weak id cameraCommands;
    std::atomic<bool> cameraPending;
    uint64_t cameraFrame,cameraViewport;
    std::mutex planMutex;
    std::unique_ptr<macfx::EffectPlanExecutor> plan;
}
@end
@implementation MLTemporalOwner
- (void)dealloc {rsReleaseTemporalOwner((__bridge void*)self);}
@end
namespace {
const char association=0;
struct EncodeHook {Class cls;IMP original;};
std::array<EncodeHook,32> encodeHooks{};std::atomic<unsigned> hookCount{0};std::mutex hooksMutex;
IMP originalEncode(id object){Class cls=object_getClass(object);const unsigned count=hookCount.load(std::memory_order_acquire);
    for(;cls;cls=class_getSuperclass(cls))for(unsigned i=0;i<count;++i)if(encodeHooks[i].cls==cls)return encodeHooks[i].original;return nullptr;
}
void invokeOriginal(id scaler,SEL selector,id commands,IMP implementation,bool reset){
    id<MTLFXTemporalScalerBase> s=scaler;const BOOL previous=s.reset;if(reset)s.reset=YES;
    reinterpret_cast<void(*)(id,SEL,id)>(implementation)(scaler,selector,commands);if(reset)s.reset=previous;
}
void encodeTemporal(id scaler,SEL selector,id commands){
    MLTemporalOwner *state=objc_getAssociatedObject(scaler,&association);const auto original=state?state->original:originalEncode(scaler);if(!original)return;
    if(internalScaler||!state){invokeOriginal(scaler,selector,commands,original,false);return;}
    const auto controls=macfx::temporalControls();const auto method=controls.method;
    RSTemporalCamera camera{};bool hasCamera=false;
    if(state->cameraPending.load(std::memory_order_acquire)){
        std::lock_guard<std::mutex> lock(state->cameraMutex);
        hasCamera=state->cameraPending&&state->cameraCommands==commands;
        if(hasCamera)camera=state->camera;
        state->cameraPending=false;state->cameraCommands=nil;
    }
    id<MTLFXTemporalScalerBase>s=scaler;
    RSTemporalCamera textureCamera{};
    const bool hasTextureCamera=textureCameraCount.load(std::memory_order_acquire)&&takeTextureCamera(s.colorTexture,s.depthTexture,s.motionTexture,textureCamera);
    if(!hasCamera&&hasTextureCamera){camera=textureCamera;hasCamera=true;}
    if(method!=state->lastMethod){rsReleaseTemporalOwner((__bridge void*)state);state->reset=state->originalReset=true;state->failedShape=0;state->reported=false;state->lastMethod=method;}
    ++state->frame;const double now=CACurrentMediaTime(),delta=state->previousTime?now-state->previousTime:1./60;state->previousTime=now;
    RSTemporalFrame f{};f.size=sizeof(f);f.version=1;f.owner=(__bridge void*)state;f.commandBuffer=(__bridge void*)commands;
    f.method=method;f.flags=state->descriptorFlags|(s.depthReversed?RS_TEMPORAL_DEPTH_REVERSED:0)|((state->reset||s.reset)?RS_TEMPORAL_RESET:0);f.frameId=state->frame;
    f.color=(__bridge void*)s.colorTexture;f.depth=(__bridge void*)s.depthTexture;f.motion=(__bridge void*)s.motionTexture;f.output=(__bridge void*)s.outputTexture;f.exposure=(__bridge void*)s.exposureTexture;
    if(@available(macOS 14.4,*))f.reactive=(__bridge void*)s.reactiveMaskTexture;
    f.renderWidth=uint32_t(s.inputContentWidth?:s.inputWidth);f.renderHeight=uint32_t(s.inputContentHeight?:s.inputHeight);f.outputWidth=uint32_t(s.outputWidth);f.outputHeight=uint32_t(s.outputHeight);f.maxRenderWidth=uint32_t(s.inputWidth);f.maxRenderHeight=uint32_t(s.inputHeight);
    f.jitterX=s.jitterOffsetX;f.jitterY=s.jitterOffsetY;f.motionScaleX=s.motionVectorScaleX;f.motionScaleY=s.motionVectorScaleY;f.preExposure=s.preExposure;f.sharpness=controls.sharpness;f.frameTimeMs=float(std::max(.001,std::min(delta*1000.,1000.)));f.commandBufferKind=state->kind;
    if(hasCamera&&bool(camera.flags&RS_TEMPORAL_DEPTH_REVERSED)==bool(s.depthReversed)){
        const bool discontinuity=state->cameraFrame&&(state->cameraViewport!=camera.viewportId||camera.frameId!=state->cameraFrame+1);
        f.flags|=RS_TEMPORAL_CAMERA_VALID|camera.flags|(discontinuity?RS_TEMPORAL_RESET:0);
        f.nearPlane=camera.nearPlane;f.farPlane=camera.farPlane;f.verticalFov=camera.verticalFov;
        f.frameId=camera.frameId;if(camera.frameTimeMs>0)f.frameTimeMs=camera.frameTimeMs;
        state->cameraFrame=camera.frameId;state->cameraViewport=camera.viewportId;
    }else state->cameraFrame=0;
    if(@available(macOS 27.0,*)){f.colorX=uint32_t(s.colorContentOffsetX);f.colorY=uint32_t(s.colorContentOffsetY);f.depthX=uint32_t(s.depthContentOffsetX);f.depthY=uint32_t(s.depthContentOffsetY);f.motionX=uint32_t(s.motionContentOffsetX);f.motionY=uint32_t(s.motionContentOffsetY);f.outputX=uint32_t(s.outputOffsetX);f.outputY=uint32_t(s.outputOffsetY);}
    if(macfx::effectPlanRequested()) {
        std::unique_lock<std::mutex> lock(state->planMutex,std::try_to_lock);
        if(lock.owns_lock()) {
            if(!state->plan)state->plan=std::make_unique<macfx::EffectPlanExecutor>();
            if(state->plan->requiresTemporal()) {
                const bool direct=!state->kind&&!f.outputX&&!f.outputY&&f.outputWidth==s.outputTexture.width&&f.outputHeight==s.outputTexture.height;
                const bool admitted=direct&&macfx::reserveTemporalOutput(commands,s.outputTexture);
                std::string reason="The ordered temporal stage requires one complete, directly presented scene output";
                if(admitted)try {
                    macfx::DepthFrame depth{s.depthTexture,f.frameId,macfx::FrameOrigin::TopLeft};
                    macfx::ShaderFrame context{commands,s.colorTexture,s.outputTexture,f.frameId,now*1000,f.frameTimeMs,macfx::FrameOrigin::TopLeft,macfx::SpatialColor::Perceptual,&depth};
                    const auto selected=state->plan->prepare(context,true,&f);
                    if(selected.execution&&selected.execution->hasTemporal()) {
                        if(s.fence){auto wait=[(id<MTLCommandBuffer>)commands computeCommandEncoder];[wait waitForFence:s.fence];[wait endEncoding];}
                        auto capture=macfx::FrameCapture::begin(commands,s.colorTexture,f.frameId);
                        const auto encoded=selected.execution->encodeScene(context,f);
                        if(encoded.encoded) {
                            if(s.fence){auto update=[(id<MTLCommandBuffer>)commands computeCommandEncoder];[update updateFence:s.fence];[update endEncoding];}
                            macfx::publishTemporalOutput(commands,s.outputTexture,f.frameId,selected.execution,std::move(capture));
                            state->reset=false;state->originalReset=true;return;
                        }reason=encoded.reason;
                    }else reason=selected.error;
                }catch(const std::exception &error){reason=error.what();}
                if(!state->reported){macfx::nativeLog("Original temporal scaler retained: "+reason);state->reported=true;}
                state->reset=true;invokeOriginal(scaler,selector,commands,original,state->originalReset);state->originalReset=false;return;
            }
        }
    }
    if(method<=RS_TEMPORAL_METALFX){invokeOriginal(scaler,selector,commands,original,state->originalReset);state->reset=state->originalReset=false;return;}
    uint64_t shape=1469598103934665603ull;for(const auto value:{f.method,f.renderWidth,f.renderHeight,f.outputWidth,f.outputHeight,f.flags&~RS_TEMPORAL_RESET,uint32_t(s.colorTextureFormat),uint32_t(s.depthTextureFormat),uint32_t(s.motionTextureFormat),uint32_t(s.outputTextureFormat)}){shape^=value;shape*=1099511628211ull;}
    RSTemporalResult result{};result.size=sizeof(result);result.version=1;
    // Classic MetalFX synchronizes untracked inputs and outputs through this
    // fence. Keep the wait/update around the entire replacement graph, including
    // Wine's surrounding translation-layer encoders. Metal 4 uses other barriers.
    const bool unsupportedFence=s.fence&&state->kind;
    if(!unsupportedFence&&shape!=state->failedShape){
        if(s.fence){auto wait=[(id<MTLCommandBuffer>)commands computeCommandEncoder];[wait waitForFence:s.fence];[wait endEncoding];}
        rsProcessTemporalFrame(&f,&result);
    }
    if(!unsupportedFence&&shape!=state->failedShape&&result.status==RS_TEMPORAL_OK&&result.encoded){
        if(s.fence){auto update=[(id<MTLCommandBuffer>)commands computeCommandEncoder];[update updateFence:s.fence];[update endEncoding];}
        state->reset=false;state->originalReset=true;if(!state->reported){macfx::nativeLog("Temporal provider active method="+std::to_string(method));state->reported=true;}return;
    }
    if(result.status!=RS_TEMPORAL_BUSY&&shape!=state->failedShape){state->failedShape=shape;rsReleaseTemporalOwner((__bridge void*)state);
        macfx::nativeLog(std::string("Original temporal scaler retained: ")+(unsupportedFence?"the Metal 4 scaler supplies a temporal fence":result.reason));}
    state->reset=true;invokeOriginal(scaler,selector,commands,original,state->originalReset);state->originalReset=false;
}
IMP installEncode(id scaler){std::lock_guard<std::mutex> lock(hooksMutex);Class cls=object_getClass(scaler);const auto selector=@selector(encodeToCommandBuffer:);
    for(unsigned i=0;i<hookCount;++i)if(encodeHooks[i].cls==cls)return encodeHooks[i].original;
    const unsigned n=hookCount;if(n>=encodeHooks.size())return nullptr;
    Method method=class_getInstanceMethod(cls,selector);if(!method)return nullptr;IMP original=method_getImplementation(method);
    if(original==(IMP)encodeTemporal)original=originalEncode(scaler);
    if(!original)return nullptr;encodeHooks[n]={cls,original};hookCount.store(n+1,std::memory_order_release);
    if(!class_addMethod(cls,selector,(IMP)encodeTemporal,method_getTypeEncoding(method)))method_setImplementation(class_getInstanceMethod(cls,selector),(IMP)encodeTemporal);
    return original;
}
void rememberScaler(id scaler,MTLFXTemporalScalerDescriptor *descriptor,unsigned kind){if(!scaler||internalScaler)return;auto original=installEncode(scaler);if(!original)return;
    MLTemporalOwner *state=[MLTemporalOwner new];state->original=original;state->kind=kind;state->reset=state->originalReset=true;state->cameraPending=false;
    state->descriptorFlags=descriptor.isAutoExposureEnabled?RS_TEMPORAL_AUTO_EXPOSURE:0;
    // Camera-aware integrations supply additional scene data per encode through
    // rsSetTemporalCamera. A plain MetalFX descriptor supplies neither projection
    // nor HDR range, so those inputs are never invented here.
    if(@available(macOS 27.0,*)){if(descriptor.isOutputResolutionMotionVectorsEnabled)state->descriptorFlags|=RS_TEMPORAL_OUTPUT_MOTION;if(descriptor.isJitteredMotionVectorsEnabled)state->descriptorFlags|=RS_TEMPORAL_JITTERED_MOTION;}
    objc_setAssociatedObject(scaler,&association,state,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

extern "C" int rsSetTemporalCamera(void *scaler,void *commands,const RSTemporalCamera *camera){
    if(!scaler)return RS_TEMPORAL_INVALID;
    MLTemporalOwner *state=objc_getAssociatedObject((__bridge id)scaler,&association);
    if(!state)return RS_TEMPORAL_UNAVAILABLE;
    std::lock_guard<std::mutex> lock(state->cameraMutex);
    const bool hadCamera=state->cameraPending&&state->cameraCommands;
    // Invalid or mismatched submissions also clear an earlier pending record.
    state->cameraPending=false;state->cameraCommands=nil;
    if(!camera)return RS_TEMPORAL_OK;
    if(!commands||!validCamera(camera))return RS_TEMPORAL_INVALID;
    if(hadCamera)return RS_TEMPORAL_BUSY;
    if(!state->kind&&[(__bridge id<MTLCommandBuffer>)commands status]>=MTLCommandBufferStatusCommitted)return RS_TEMPORAL_INVALID;
    state->camera=*camera;state->cameraCommands=(__bridge id)commands;state->cameraPending=true;
    return RS_TEMPORAL_OK;
}
IMP newScaler=nullptr,newScaler4=nullptr;
id createScaler(id descriptor,SEL selector,id device){id value=reinterpret_cast<id(*)(id,SEL,id)>(newScaler)(descriptor,selector,device);rememberScaler(value,descriptor,0);return value;}
id createScaler4(id descriptor,SEL selector,id device,id compiler){id value=reinterpret_cast<id(*)(id,SEL,id,id)>(newScaler4)(descriptor,selector,device,compiler);rememberScaler(value,descriptor,1);return value;}
__attribute__((constructor)) void installTemporal(){@autoreleasepool{
    if(!getenv("RESHADE_TEMPORAL_CONTROL_FILE")&&!getenv("RESHADE_TEMPORAL_METHOD")&&!getenv("RESHADE_EFFECT_PLAN"))return;
    Class cls=(Class)objc_getClass("MTLFXTemporalScalerDescriptor");Method m=class_getInstanceMethod(cls,@selector(newTemporalScalerWithDevice:));if(m)newScaler=method_setImplementation(m,(IMP)createScaler);
    if(@available(macOS 26.0,*)){m=class_getInstanceMethod(cls,@selector(newTemporalScalerWithDevice:compiler:));if(m)newScaler4=method_setImplementation(m,(IMP)createScaler4);}
}}
}

extern "C" uint32_t rsGetTemporalMethod(void){return macfx::temporalControls().method;}
