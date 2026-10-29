#include "temporal-frame.h"
#include "temporal-camera.h"
#include "temporal-controls.hpp"
#include "temporal-command-order.hpp"
#include "log.hpp"
#include "temporal-plan.hpp"
#include "temporal-provider.hpp"
#include "scene-frame.h"
#include "frame-capture.hpp"
#include "xess-node.hpp"
#include "metalfx-denoised.hpp"
#include "denoised-ingress.hpp"
#include "image-color.hpp"
#include "color-island.hpp"
#include "scene-matrices.hpp"
#include "scene-aovs.hpp"
#include "scene-destination.hpp"
#include "metal4-scene-ingress.hpp"
#include "metal4-sdk-history.hpp"
#include "metalfx-image-ingress.hpp"
#include "metalfx-generation-resources.hpp"
#include "presentation-hold.hpp"
#include "runtime-status.hpp"
#include "recorded-scene.h"
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
#include <cstring>
#include <filesystem>
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
    rsClearTemporalMatricesTextures(owner);
    rsClearTemporalSceneDestinationTextures(owner);
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
std::array<std::atomic<const RSTemporalProvider*>,5> loadedProviders{};
struct Provider {
    void *library=nullptr;const RSTemporalProvider *api=nullptr;RSPrepareTemporalResources prepare=nullptr;RSTemporalProviderProfiles profiles=nullptr;
    explicit Provider(const char *name,unsigned slot,const char *directory,const char *filename){const auto supplied=getenv(name);std::string bundled;
        if(!supplied||!*supplied){
            Dl_info origin{};if(!dladdr(static_cast<const void*>(&loadedProviders),&origin)||!origin.dli_fname)return;
            const auto root=std::filesystem::path(origin.dli_fname).parent_path()/"temporal";
            bundled=(root/directory/filename).string();
        }
        const auto path=bundled.empty()?supplied:bundled.c_str();if(!path||path[0]!='/')return;
        library=dlopen(path,RTLD_NOW|RTLD_LOCAL);if(!library){macfx::nativeLog("Temporal provider could not load");return;}
        const auto get=reinterpret_cast<RSGetTemporalProvider>(dlsym(library,"rsGetTemporalProvider"));if(get)api=get(1);
        if(!api||api->size<sizeof(RSTemporalProvider)||api->version!=1||!api->encode||!api->release)api=nullptr;
        if(api)prepare=reinterpret_cast<RSPrepareTemporalResources>(dlsym(library,"rsPrepareTemporalResources"));
        if(api)profiles=reinterpret_cast<RSTemporalProviderProfiles>(dlsym(library,"rsTemporalProviderProfiles"));
        loadedProviders[slot].store(api,std::memory_order_release);
    }
};
const Provider *providerDescriptor(unsigned method){
    if(method==RS_TEMPORAL_FSR4){static Provider p("RESHADE_FSR4_LIBRARY",2,"fsr4","libmaclauncher-fsr4.dylib");return &p;}
    if(method==RS_TEMPORAL_FSR3){static Provider p("RESHADE_FSR3_LIBRARY",1,"fsr","libmaclauncher-fsr3.dylib");return &p;}
    if(method==RS_TEMPORAL_FSR2){static Provider p("RESHADE_FSR2_LIBRARY",0,"fsr","libmaclauncher-fsr2.dylib");return &p;}
    if(method==RS_TEMPORAL_ASR){static Provider p("RESHADE_ASR_LIBRARY",3,"asr","libmaclauncher-asr.dylib");return &p;}
    if(method==RS_TEMPORAL_SGSR2){static Provider p("RESHADE_SGSR2_LIBRARY",4,"sgsr2","libmaclauncher-sgsr2.dylib");return &p;}return nullptr;
}
const RSTemporalProvider *provider(unsigned method){const auto value=providerDescriptor(method);return value?value->api:nullptr;}
struct Scaler {
    id<MTLDevice> device;id<MTLFXTemporalScaler> scaler;
    std::array<uint64_t,10> key{};std::mutex mutex;
    std::atomic<unsigned> pending{0};std::atomic<bool> reset{true};uint64_t frame=0;
    __weak id<MTLCommandBuffer> tail;
    std::optional<macfx::ImageColorDescription>color;
};
struct Completion {
    std::weak_ptr<Scaler> context;
    std::atomic<bool> finished{false},encoded{false};
    explicit Completion(const std::shared_ptr<Scaler>& c):context(c){c->pending.fetch_add(1,std::memory_order_relaxed);}
    void finish(bool success){if(finished.exchange(true))return;if(auto c=context.lock()){if(!success)c->reset=true;c->pending.fetch_sub(1,std::memory_order_release);}}
    ~Completion(){finish(false);}
};
// Driver/framework callbacks can outlive C++ global teardown. Explicit owner
// retirement still releases live scalers; process exit does not tear MPSGraph
// objects down after its internal synchronization has already disappeared.
std::mutex&ownersMutex=*new std::mutex;
auto&owners=*new std::unordered_map<void*,std::shared_ptr<Scaler>>;
struct SceneOwner{std::mutex mutex;id<MTLDevice>device=nil;std::shared_ptr<macfx::SceneComputeEncoder>encoder;macfx::EffectPlanExecutor denoised;std::shared_ptr<const macfx::EffectPlanSnapshot>colorSnapshot;uint32_t colorMethod=0,colorProfile=0;float colorSharpness=-1;};
auto&sceneOwners=*new std::unordered_map<void*,std::shared_ptr<SceneOwner>>;
// An encoder's plan executor reports under the encoder's own status context.
// Its acceptance is reported here after each encoded scene; a presenter that
// consumes the receipt reports the stages under its own context, and an
// unconsumed receipt keeps them here. A stopped encoder retires its context,
// so acceptance never waits for it.
struct OrderedSceneOwner{std::mutex mutex;macfx::EffectPlanExecutor plan;std::atomic<bool> statusReported{false};};
void acceptEncodedScene(uintptr_t context,const macfx::EffectExecution&execution,uint64_t frameId){
    const auto controls=macfx::presentationControlsDigest();
    macfx::RuntimeStatusEvent event;event.context=context;event.processing=true;event.resourceAccepted=true;event.phase=macfx::RuntimeStatusPhase::Encoded;
    event.frameId=frameId;event.planRevision=execution.revision();event.controlsDigest=controls;macfx::observeRuntimeStatus(event);
}
void stopEncoderStatus(uintptr_t context,std::atomic<bool>&reported){if(reported.exchange(false,std::memory_order_acq_rel))macfx::retireRuntimeStatus(context);}
auto&orderedSceneOwners=*new std::unordered_map<void*,std::shared_ptr<OrderedSceneOwner>>;
int xess(const RSTemporalFrame&f,const macfx::ImageColorDescription&color,RSTemporalResult*r,bool prepareOnly=false){
    std::shared_ptr<SceneOwner>context;{std::lock_guard lock(ownersMutex);auto&value=sceneOwners[f.owner];if(!value)value=std::make_shared<SceneOwner>();context=value;}
    std::unique_lock lock(context->mutex,std::try_to_lock);if(!lock.owns_lock())return answer(r,RS_TEMPORAL_BUSY,"The scene owner is processing another frame");
    auto commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;
    if(!context->encoder||context->device!=commands.device){context->device=commands.device;context->encoder=macfx::makeXessSceneEncoder(commands.device);}
    auto state=context->encoder->preparationStatus();if(state.busy)return answer(r,RS_TEMPORAL_BUSY,state.reason.c_str());
    context->encoder->setColorDescription(color);auto ready=context->encoder->prepare(f);if(!ready.encoded)return answer(r,ready.busy?RS_TEMPORAL_BUSY:RS_TEMPORAL_UNAVAILABLE,ready.reason.c_str());
    if(prepareOnly)return answer(r,RS_TEMPORAL_OK,"");
    auto encoded=context->encoder->encode(f);r->encoded=encoded.encoded;r->reset=bool(f.flags&RS_TEMPORAL_RESET);return answer(r,encoded.encoded?RS_TEMPORAL_OK:encoded.busy?RS_TEMPORAL_BUSY:RS_TEMPORAL_FAILED,encoded.reason.c_str());
}
int denoised(const RSTemporalFrame&f,const macfx::ImageColorDescription&color,RSTemporalResult*r,bool prepareOnly){
 std::shared_ptr<SceneOwner>owner;{std::lock_guard lock(ownersMutex);auto&entry=sceneOwners[f.owner];if(!entry)entry=std::make_shared<SceneOwner>();owner=entry;}
 std::unique_lock lock(owner->mutex,std::try_to_lock);if(!lock)return answer(r,RS_TEMPORAL_BUSY,"The scene owner is processing another frame");
 static const auto snapshot=[](){auto value=std::make_shared<macfx::EffectPlanSnapshot>();value->mode="advanced";value->revision="5f33c7e56a93514e6968d33a87733bb6a7b5e1dba22953309d7a3734f94284c4";macfx::EffectPlanNode node;node.id="denoised-provider";node.kind="temporal";node.method="metalfx-denoised";node.preservesCoordinates=true;node.requirements.depth=node.requirements.motion=node.requirements.viewMatrix=node.requirements.projectionMatrix=node.requirements.noisyColor=true;node.requirements.sceneAovs=(1u<<RS_SCENE_AOV_NORMAL)|(1u<<RS_SCENE_AOV_ROUGHNESS)|(1u<<RS_SCENE_AOV_DIFFUSE_ALBEDO)|(1u<<RS_SCENE_AOV_SPECULAR_ALBEDO);value->nodes.push_back(std::move(node));return std::shared_ptr<const macfx::EffectPlanSnapshot>(value);}();
 auto commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;macfx::DepthFrame depth{(__bridge id<MTLTexture>)f.depth,f.frameId,macfx::FrameOrigin::TopLeft};macfx::ShaderFrame frame{commands,(__bridge id<MTLTexture>)f.color,(__bridge id<MTLTexture>)f.output,f.frameId,CACurrentMediaTime()*1000,f.frameTimeMs,macfx::FrameOrigin::TopLeft,macfx::spatialColorForDescription(color),&depth,color.alpha==macfx::ColorAlpha::Opaque};
 const auto selected=owner->denoised.prepareSceneContinuation(frame,&f,macfx::imageColorLabel(color),color,snapshot,"provider-only-denoised");
 if(selected.holdPrevious||selected.preparing&&!selected.execution)return answer(r,RS_TEMPORAL_BUSY,selected.error.c_str());if(!selected.execution||!selected.execution->replacesTemporal())return answer(r,RS_TEMPORAL_UNAVAILABLE,selected.error.empty()?"Denoised scaling requires matching noisy color, material attachments and scene matrices":selected.error.c_str());
 if(prepareOnly)return answer(r,RS_TEMPORAL_OK,"");const auto encoded=selected.execution->encodeScene(frame,f);r->encoded=encoded.encoded;r->reset=bool(f.flags&RS_TEMPORAL_RESET);return answer(r,encoded.encoded?RS_TEMPORAL_OK:encoded.busy?RS_TEMPORAL_BUSY:RS_TEMPORAL_FAILED,encoded.reason.c_str());
}
int normalizedLegacy(const RSTemporalFrame&f,const macfx::ImageColorDescription&color,RSTemporalResult*r,bool prepareOnly){
 std::shared_ptr<SceneOwner>owner;{std::lock_guard lock(ownersMutex);auto&entry=sceneOwners[f.owner];if(!entry)entry=std::make_shared<SceneOwner>();owner=entry;}
 std::unique_lock lock(owner->mutex,std::try_to_lock);if(!lock)return answer(r,RS_TEMPORAL_BUSY,"The scene owner is processing another frame");
 if(!owner->colorSnapshot||owner->colorMethod!=f.method||owner->colorProfile!=f.reserved||owner->colorSharpness!=f.sharpness){
  auto value=std::make_shared<macfx::EffectPlanSnapshot>();value->mode="advanced";uint32_t sharpness;std::memcpy(&sharpness,&f.sharpness,sizeof(sharpness));value->revision="abi1-linear-"+std::to_string(f.method)+':'+std::to_string(f.reserved)+':'+std::to_string(sharpness);
  macfx::EffectPlanNode node;node.id="temporal-provider";node.kind="temporal";node.method=macfx::linearABI1TemporalMethod(f.method);node.preservesCoordinates=true;node.requirements.depth=node.requirements.motion=true;node.requirements.camera=f.method!=RS_TEMPORAL_FSR4;node.settings.values["temporalSharpness"]=double(f.sharpness);
  if(f.method==RS_TEMPORAL_ASR){static const char*profiles[]={"quality","quality","balanced","performance","ultra-performance"};node.settings.values["asrQuality"]=std::string(profiles[f.reserved]);}
  if(f.method==RS_TEMPORAL_FSR4){static const char*profiles[]={"exact-fast","exact-fast","lite","lite2"};node.settings.values["fsr4Profile"]=std::string(profiles[f.reserved]);}
  value->nodes.push_back(std::move(node));owner->colorSnapshot=std::move(value);owner->colorMethod=f.method;owner->colorProfile=f.reserved;owner->colorSharpness=f.sharpness;
 }
 auto commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;macfx::DepthFrame depth{(__bridge id<MTLTexture>)f.depth,f.frameId,macfx::FrameOrigin::TopLeft};macfx::ShaderFrame frame{commands,(__bridge id<MTLTexture>)f.color,(__bridge id<MTLTexture>)f.output,f.frameId,CACurrentMediaTime()*1000,f.frameTimeMs,macfx::FrameOrigin::TopLeft,macfx::spatialColorForDescription(color),&depth,color.alpha==macfx::ColorAlpha::Opaque};
 const auto selected=owner->denoised.prepareSceneContinuation(frame,&f,macfx::imageColorLabel(color),color,owner->colorSnapshot,"provider-only-color");
 if(selected.holdPrevious||selected.preparing&&!selected.execution)return answer(r,RS_TEMPORAL_BUSY,selected.error.c_str());if(!selected.execution||!selected.execution->replacesTemporal())return answer(r,RS_TEMPORAL_UNAVAILABLE,selected.error.empty()?"The temporal color boundary could not be prepared":selected.error.c_str());
 if(prepareOnly)return answer(r,RS_TEMPORAL_OK,"");const auto encoded=selected.execution->encodeScene(frame,f);r->encoded=encoded.encoded;r->reset=bool(f.flags&RS_TEMPORAL_RESET);return answer(r,encoded.encoded?RS_TEMPORAL_OK:encoded.busy?RS_TEMPORAL_BUSY:RS_TEMPORAL_FAILED,encoded.reason.c_str());
}
std::shared_ptr<Scaler> owner(void *key){std::lock_guard<std::mutex> lock(ownersMutex);auto &p=owners[key];if(!p)p=std::make_shared<Scaler>();return p;}
int metalfx(const RSTemporalFrame &f,RSTemporalResult *r,bool prepareOnly=false,const macfx::ImageColorDescription*explicitColor=nullptr){
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
    if(!lock.owns_lock())return answer(r,RS_TEMPORAL_BUSY,"The temporal owner is encoding another frame.");
    if(!prepareOnly&&context->frame&&f.frameId<=context->frame&&!(f.flags&RS_TEMPORAL_RESET))return answer(r,RS_TEMPORAL_INVALID,"Temporal frame identities must increase.");
    const auto maxW=f.maxRenderWidth?f.maxRenderWidth:f.renderWidth,maxH=f.maxRenderHeight?f.maxRenderHeight:f.renderHeight;
    const std::array<uint64_t,10> key={maxW,maxH,f.outputWidth,f.outputHeight,c.pixelFormat,d.pixelFormat,m.pixelFormat,o.pixelFormat,f.flags&~(RS_TEMPORAL_RESET|RS_TEMPORAL_CAMERA_VALID|RS_TEMPORAL_DEPTH_REVERSED|RS_TEMPORAL_DEPTH_INFINITE),f.reactive?((__bridge id<MTLTexture>)f.reactive).pixelFormat:0};
    if(context->key!=key||context->device!=device||!context->scaler){
        // A replacement starts a different history generation. Its former
        // completion callbacks must retire before the owner is reused.
        if(context->pending.load(std::memory_order_acquire))return answer(r,RS_TEMPORAL_BUSY,"The previous temporal history is still in use.");
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
    if(prepareOnly){r->encoded=0;r->reset=context->reset.load();return answer(r,RS_TEMPORAL_OK,"");}
    if(context->pending.load(std::memory_order_acquire)&&!macfx::orderedTemporalCommands(context->tail,commands))
        return answer(r,RS_TEMPORAL_BUSY,"Temporal history requires ordered command buffers.");
    auto s=context->scaler;
    const auto outputColor=explicitColor?*explicitColor:macfx::describeImageColor(f.flags&RS_TEMPORAL_HDR?macfx::ImageColorSpace::ExtendedSRGB:macfx::ImageColorSpace::SRGB);
    const bool colorReset=context->color&&!macfx::sameImageColorDescription(*context->color,outputColor);
    macfx::MetalFxScalerMutation mutation(s);
    if(!mutation)return answer(r,RS_TEMPORAL_BUSY,"The owned temporal scaler is retained by matching interpolation work.");
    if((c.usage&s.colorTextureUsage)!=s.colorTextureUsage||(d.usage&s.depthTextureUsage)!=s.depthTextureUsage||(m.usage&s.motionTextureUsage)!=s.motionTextureUsage||(o.usage&s.outputTextureUsage)!=s.outputTextureUsage)return answer(r,RS_TEMPORAL_INVALID,"Temporal textures do not meet MetalFX usage requirements.");
    if(f.reactive){if(@available(macOS 14.4,*)){auto mask=(__bridge id<MTLTexture>)f.reactive;
        if((mask.usage&s.reactiveTextureUsage)!=s.reactiveTextureUsage)return answer(r,RS_TEMPORAL_INVALID,"The reactive mask does not meet MetalFX usage requirements.");}}
    s.colorTexture=c;s.depthTexture=d;s.motionTexture=m;s.outputTexture=o;s.exposureTexture=(__bridge id<MTLTexture>)f.exposure;
    if(@available(macOS 14.4,*))s.reactiveMaskTexture=(__bridge id<MTLTexture>)f.reactive;
    s.inputContentWidth=f.renderWidth;s.inputContentHeight=f.renderHeight;s.jitterOffsetX=f.jitterX;s.jitterOffsetY=f.jitterY;s.motionVectorScaleX=f.motionScaleX;s.motionVectorScaleY=f.motionScaleY;s.preExposure=f.preExposure;
    s.depthReversed=bool(f.flags&RS_TEMPORAL_DEPTH_REVERSED);s.reset=context->reset.exchange(false)||colorReset||bool(f.flags&RS_TEMPORAL_RESET)||(context->frame&&f.frameId!=context->frame+1);
    if(@available(macOS 27.0,*)){s.colorContentOffsetX=f.colorX;s.colorContentOffsetY=f.colorY;s.depthContentOffsetX=f.depthX;s.depthContentOffsetY=f.depthY;s.motionContentOffsetX=f.motionX;s.motionContentOffsetY=f.motionY;s.reactiveMaskContentOffsetX=f.colorX;s.reactiveMaskContentOffsetY=f.colorY;s.outputOffsetX=f.outputX;s.outputOffsetY=f.outputY;}
    r->reset=s.reset;
    // Track this exact buffer before encoding, including a partially failed
    // encode. The weak owner avoids a scaler -> buffer -> owner cycle.
    auto completion=std::make_shared<Completion>(context);
    [commands addCompletedHandler:^(id<MTLCommandBuffer> completed){completion->finish(completed.status==MTLCommandBufferStatusCompleted&&completion->encoded.load(std::memory_order_acquire));}];
    context->tail=commands;
    {InternalScope scope;[s encodeToCommandBuffer:commands];}
    // Metadata belongs to this exact invocation. The legacy flag contract is
    // used only when no explicit source/output description was supplied.
    auto published=f;if(s.reset)published.flags|=RS_TEMPORAL_RESET;
    mutation.publish(published,macfx::MetalFxScalerProfile::Temporal,outputColor);
    context->color=outputColor;context->frame=f.frameId;
    completion->encoded.store(true,std::memory_order_release);
    r->encoded=1;return answer(r,RS_TEMPORAL_OK,"");
}
}
macfx::InternalTemporalScope::InternalTemporalScope()noexcept:previous(internalScaler){internalScaler=true;}
macfx::InternalTemporalScope::~InternalTemporalScope(){internalScaler=previous;}
const char*macfx::linearABI1TemporalMethod(uint32_t method)noexcept{
 // FSR/ASR HDR permutations require linear RGB. The packaged FSR4 shader
 // colorspace is LINEAR (0), independently of the legacy HDR flag. SGSR2's
 // original reversible tone map also consumes linear RGB.
 switch(method){case RS_TEMPORAL_FSR2:return "fsr2";case RS_TEMPORAL_FSR3:return "fsr3";case RS_TEMPORAL_FSR4:return "fsr4";case RS_TEMPORAL_ASR:return "asr";case RS_TEMPORAL_SGSR2:return "sgsr2";default:return nullptr;}
}
static int processTemporalProviderFrame(const RSTemporalFrame *f,const RSImageColorDescription*explicitColor,RSTemporalResult *r,bool prepareOnly=false,bool normalizedABI=false){
    if(!r||r->size<sizeof(*r)||r->version!=1)return RS_TEMPORAL_INVALID;
    r->encoded=r->reset=0;r->reason[0]=0;r->method=f?f->method:0;
    if(!f||f->size<sizeof(*f)||f->version!=1||!f->owner||!f->commandBuffer||!f->frameId||f->method<1||f->method>RS_TEMPORAL_METALFX_DENOISED||f->flags>255||!rsTemporalFrameOptionsValid(f)||f->commandBufferKind>1||!finite(*f))return answer(r,RS_TEMPORAL_INVALID,"Invalid temporal frame inputs.");
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
        macfx::bindTemporalMatricesForTextures(*f);macfx::bindTemporalAovsForTextures(*f);
        if(f->method==RS_TEMPORAL_METALFX_DENOISED){if(f->commandBufferKind)return answer(r,RS_TEMPORAL_UNAVAILABLE,"Denoised reconstruction requires the classic Metal recording boundary");const auto attachments=macfx::temporalSceneAovs(*f);const auto color=explicitColor?macfx::readImageColor(*explicitColor):attachments?macfx::readImageColor(attachments->value.color):macfx::describeImageColor(macfx::ImageColorSpace::ExtendedSRGB);return denoised(*f,color,r,prepareOnly);}
        if(f->method==RS_TEMPORAL_XESS){auto color=explicitColor?macfx::readImageColor(*explicitColor):macfx::describeImageColor(f->flags&RS_TEMPORAL_HDR?macfx::ImageColorSpace::ExtendedSRGB:macfx::ImageColorSpace::SRGB);return xess(*f,color,r,prepareOnly);}
        if(f->method==RS_TEMPORAL_METALFX){const auto color=explicitColor?std::optional<macfx::ImageColorDescription>(macfx::readImageColor(*explicitColor)):std::nullopt;return metalfx(*f,r,prepareOnly,color?&*color:nullptr);}
        if(!normalizedABI&&macfx::linearABI1TemporalMethod(f->method)){const auto attachments=macfx::temporalSceneAovs(*f);if(explicitColor||attachments){if(f->commandBufferKind)return answer(r,RS_TEMPORAL_UNAVAILABLE,"Explicit temporal color conversion requires the classic Metal recording boundary");const auto color=macfx::readImageColor(explicitColor?*explicitColor:attachments->value.color);return normalizedLegacy(*f,color,r,prepareOnly);}}
        if(explicitColor)return answer(r,RS_TEMPORAL_UNAVAILABLE,"This temporal provider requires its normalized ABI1 color contract");
        const auto loaded=providerDescriptor(f->method);const auto p=loaded?loaded->api:nullptr;if(!p||!(p->methods&(1u<<f->method)))return answer(r,RS_TEMPORAL_UNAVAILABLE,"The selected temporal provider is unavailable.");
        if(f->method==RS_TEMPORAL_FSR4&&f->reserved>1&&(!loaded->profiles||!(loaded->profiles(f->method)&(1u<<f->reserved))))return answer(r,RS_TEMPORAL_UNAVAILABLE,"The installed FSR 4 provider does not contain the selected model profile.");
        if(prepareOnly)return loaded->prepare?loaded->prepare(f,r):answer(r,RS_TEMPORAL_UNAVAILABLE,"The temporal provider has no resource-only preparation hook.");
        return p->encode(f,r);
    }catch(const std::exception&e){return answer(r,RS_TEMPORAL_FAILED,e.what());}}@catch(NSException*e){return answer(r,RS_TEMPORAL_FAILED,e.reason.UTF8String?:"Temporal encoding failed.");}}
}
extern "C" int rsProcessTemporalProviderFrame(const RSTemporalFrame*f,RSTemporalResult*r){return processTemporalProviderFrame(f,nullptr,r);}
int macfx::encodeTemporalProvider(const RSTemporalFrame*f,RSTemporalResult*r){return processTemporalProviderFrame(f,nullptr,r,false,true);}
int macfx::encodeTemporalProvider(const RSTemporalFrame*f,RSTemporalResult*r,const ImageColorDescription&color){const auto value=writeImageColor(color);return processTemporalProviderFrame(f,&value,r);}
bool macfx::prepareTemporalProvider(const RSTemporalFrame*f,RSTemporalResult*r){
    if(f&&f->method!=RS_TEMPORAL_METALFX&&f->method!=RS_TEMPORAL_XESS&&f->method!=RS_TEMPORAL_METALFX_DENOISED){const auto loaded=providerDescriptor(f->method);if(loaded&&loaded->api&&!loaded->prepare)return false;}
    processTemporalProviderFrame(f,nullptr,r,true,true);return true;
}
bool macfx::prepareTemporalProvider(const RSTemporalFrame*f,RSTemporalResult*r,const ImageColorDescription&color){
    if(f&&f->method!=RS_TEMPORAL_METALFX&&f->method!=RS_TEMPORAL_XESS&&f->method!=RS_TEMPORAL_METALFX_DENOISED){const auto loaded=providerDescriptor(f->method);if(loaded&&loaded->api&&!loaded->prepare)return false;}
    const auto value=writeImageColor(color);processTemporalProviderFrame(f,&value,r,true);return true;
}
static int processTemporalFrame(const RSTemporalFrame*f,const RSImageColorDescription*explicitColor,RSTemporalResult*r,bool originalRetained=false){
    if(!r||r->size<sizeof(*r)||r->version!=1)return RS_TEMPORAL_INVALID;
    if(!macfx::effectPlanRequested()){if(originalRetained){r->encoded=0;return answer(r,RS_TEMPORAL_UNAVAILABLE,"The complete original renderer output is retained; no ordered scene work is requested");}return processTemporalProviderFrame(f,explicitColor,r);}
    r->encoded=r->reset=0;r->method=f?f->method:0;r->reason[0]=0;
    if(!f||f->size<sizeof(*f)||f->version!=1||!f->owner||!f->commandBuffer||!f->frameId||f->method>RS_TEMPORAL_METALFX_DENOISED||f->flags>255||!rsTemporalFrameOptionsValid(f)||f->commandBufferKind||!finite(*f))return answer(r,RS_TEMPORAL_INVALID,"Invalid ordered scene frame inputs");
    @autoreleasepool{@try{try{
        auto commands=(__bridge id<MTLCommandBuffer>)f->commandBuffer;auto device=commands.device;
        auto color=(__bridge id<MTLTexture>)f->color,depth=(__bridge id<MTLTexture>)f->depth,motion=(__bridge id<MTLTexture>)f->motion,output=(__bridge id<MTLTexture>)f->output;
        if(!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted||!texture(color,device)||(depth&&!texture(depth,device))||(motion&&!texture(motion,device))||!texture(output,device)||color==output||depth==output||motion==output||
            !region(color,f->colorX,f->colorY,f->renderWidth,f->renderHeight)||(depth&&!region(depth,f->depthX,f->depthY,f->renderWidth,f->renderHeight))||(motion&&!region(motion,f->motionX,f->motionY,f->flags&RS_TEMPORAL_OUTPUT_MOTION?f->outputWidth:f->renderWidth,f->flags&RS_TEMPORAL_OUTPUT_MOTION?f->outputHeight:f->renderHeight))||!region(output,f->outputX,f->outputY,f->outputWidth,f->outputHeight))return answer(r,RS_TEMPORAL_INVALID,"Ordered scene resources must have matched devices, regions and unsubmitted retained commands");
        macfx::bindTemporalMatricesForTextures(*f);macfx::bindTemporalAovsForTextures(*f);
        std::shared_ptr<OrderedSceneOwner>owner;{std::lock_guard lock(ownersMutex);auto&entry=orderedSceneOwners[f->owner];if(!entry){entry=std::make_shared<OrderedSceneOwner>();entry->plan.setStatusContext(reinterpret_cast<uintptr_t>(entry.get()));}owner=entry;}
        std::unique_lock lock(owner->mutex,std::try_to_lock);if(!lock.owns_lock())return answer(r,RS_TEMPORAL_BUSY,"This scene owner is processing another frame");
        const auto statusContext=reinterpret_cast<uintptr_t>(owner.get());
        if(!owner->plan.requiresTemporal()){stopEncoderStatus(statusContext,owner->statusReported);return originalRetained?answer(r,RS_TEMPORAL_UNAVAILABLE,"The complete original renderer output is retained; image work belongs to its ordinary consumer"):processTemporalProviderFrame(f,explicitColor,r);}
        // Unknown optional source metadata cannot claim the completed SDK
        // image as a preparing output and stall its ordinary image consumer.
        if(originalRetained&&!explicitColor&&!macfx::temporalSceneAovs(*f))return answer(r,RS_TEMPORAL_UNAVAILABLE,"Matching source color metadata is required by the optional scene reconstruction; the original output is retained");
        if(!originalRetained&&(f->outputX||f->outputY||f->outputWidth!=output.width||f->outputHeight!=output.height))return answer(r,RS_TEMPORAL_UNAVAILABLE,"The ordered scene boundary requires the complete declared output texture");
        if(!macfx::reserveExplicitTemporalOutput(commands,output,f->owner,f->frameId))return answer(r,RS_TEMPORAL_BUSY,"This exact scene output already has a producer for these commands");
        const auto destination=macfx::takeTemporalSceneDestination(*f);std::shared_ptr<macfx::TemporalSceneContinuation>early;
        if(destination)if(auto value=macfx::temporalSceneContinuation(destination->window);value&&value->frameId()==f->frameId&&owner->plan.snapshot()&&value->execution()->revision()==owner->plan.snapshot()->revision){const auto ready=value->ready(commands);if(!ready.encoded)return answer(r,ready.busy?RS_TEMPORAL_BUSY:RS_TEMPORAL_FAILED,ready.reason.c_str());early=std::move(value);}
        auto actual=*f;if(early&&early->displayMapped()){actual.preExposure=1;actual.exposure=nullptr;actual.flags&=~RS_TEMPORAL_AUTO_EXPOSURE;}f=&actual;
        const auto attachments=macfx::temporalSceneAovs(*f);
        auto description=explicitColor?macfx::readImageColor(*explicitColor):attachments?macfx::readImageColor(attachments->value.color):macfx::describeImageColor(f->flags&RS_TEMPORAL_HDR?macfx::ImageColorSpace::ExtendedSRGB:macfx::ImageColorSpace::LegacySDR);
        if(!explicitColor&&!attachments)description.alpha=macfx::ColorAlpha::Opaque;
        macfx::DepthFrame guide{depth,f->frameId,macfx::FrameOrigin::TopLeft};
        macfx::ShaderFrame frame{commands,color,output,f->frameId,CACurrentMediaTime()*1000,f->frameTimeMs,macfx::FrameOrigin::TopLeft,macfx::spatialColorForDescription(description),&guide,description.alpha==macfx::ColorAlpha::Opaque};
        const auto selected=early?owner->plan.prepareSceneContinuation(frame,f,macfx::imageColorLabel(description),description,early->execution()->sceneSuffixSnapshot(),early->execution()->sceneOutputIdentity()):originalRetained?owner->plan.prepareRecordedScene(frame,*f,description):owner->plan.prepareWithColorDescription(frame,true,f,macfx::imageColorLabel(description),description);
        if(selected.holdPrevious||(selected.preparing&&(!selected.execution||!selected.execution->hasTemporal()))){macfx::publishTemporalPreparation(commands,output,f->frameId,selected.error);return answer(r,RS_TEMPORAL_BUSY,selected.error.c_str());}
        if(!selected.execution||!selected.execution->hasTemporal())return answer(r,RS_TEMPORAL_UNAVAILABLE,selected.error.empty()?"The ordered scene provider could not be prepared":selected.error.c_str());
        if(!originalRetained&&!selected.execution->replacesTemporal()){
            RSTemporalResult original{};original.size=sizeof(original);original.version=1;
            if(!f->method){
                if(f->renderWidth!=f->outputWidth||f->renderHeight!=f->outputHeight||color.pixelFormat!=output.pixelFormat)return answer(r,RS_TEMPORAL_UNAVAILABLE,"Raw scene output needs matching color dimensions and format before its image pipeline");
                auto copy=[commands blitCommandEncoder];if(!copy)return answer(r,RS_TEMPORAL_BUSY,"The raw scene output copy is unavailable");
                [copy copyFromTexture:color sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(f->colorX,f->colorY,0) sourceSize:MTLSizeMake(f->renderWidth,f->renderHeight,1) toTexture:output destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];
            }else{const auto code=processTemporalProviderFrame(f,explicitColor,&original);if(code!=RS_TEMPORAL_OK||!original.encoded){*r=original;return code;}}
        }
        auto capture=macfx::FrameCapture::begin(commands,selected.execution->replacesTemporal()?color:output,f->frameId);bool displayMapped=early&&early->displayMapped();
        const auto encoded=originalRetained?selected.execution->encodeRecordedScene(frame,*f,&displayMapped,&guide):selected.execution->encodeScene(frame,*f,&displayMapped,&guide,displayMapped);if(!encoded.encoded)return answer(r,encoded.busy?RS_TEMPORAL_BUSY:RS_TEMPORAL_FAILED,encoded.reason.c_str());
        if(destination)macfx::publishTemporalSceneContinuation(commands,*destination,*f,selected.execution,displayMapped);else macfx::publishTemporalOutputWithDepth(commands,output,f->frameId,selected.execution,std::move(capture),&guide,displayMapped,f);
        acceptEncodedScene(statusContext,*selected.execution,f->frameId);owner->statusReported.store(true,std::memory_order_release);r->encoded=1;r->reset=bool(f->flags&RS_TEMPORAL_RESET);return answer(r,RS_TEMPORAL_OK,"");
    }catch(const std::exception&e){return answer(r,RS_TEMPORAL_FAILED,e.what());}}@catch(NSException*e){return answer(r,RS_TEMPORAL_FAILED,e.reason.UTF8String?:"Ordered scene encoding failed");}}
}
extern "C" int rsProcessTemporalFrame(const RSTemporalFrame*f,RSTemporalResult*r){return processTemporalFrame(f,nullptr,r);}
extern "C" uint32_t rsTemporalProviderMethodMask(void){return (1u<<RS_TEMPORAL_METALFX)|(1u<<RS_TEMPORAL_FSR2)|(1u<<RS_TEMPORAL_FSR3)|(1u<<RS_TEMPORAL_FSR4)|(1u<<RS_TEMPORAL_XESS)|(1u<<RS_TEMPORAL_ASR)|(1u<<RS_TEMPORAL_SGSR2)|(1u<<RS_TEMPORAL_METALFX_DENOISED);}
extern "C" uint32_t rsMetalFxDenoisedAPI(void){return 1;}
extern "C" uint32_t rsMetal4SceneAPI(void){return 1;}
extern "C" uint32_t rsTemporalProfileAPI(void){return 1;}
extern "C" int rsProcessTemporalFrameColor(const RSTemporalFrame*f,const RSImageColorDescription*c,RSTemporalResult*r){if(!c){if(r&&r->size>=sizeof(*r)&&r->version==1)return answer(r,RS_TEMPORAL_INVALID,"Explicit temporal color metadata is required");return RS_TEMPORAL_INVALID;}return processTemporalFrame(f,c,r);}
namespace {
struct RecordedSceneOwner {
    std::atomic<unsigned>references{1};std::atomic<uint64_t>latest{0};std::atomic<bool>reset{true};uint64_t generation;
    explicit RecordedSceneOwner(uint64_t value):generation(value){}
    ~RecordedSceneOwner(){rsReleaseTemporalOwner(this);}
};
void retainRecordedScene(void*value){static_cast<RecordedSceneOwner*>(value)->references.fetch_add(1,std::memory_order_relaxed);}
void releaseRecordedScene(void*value){auto owner=static_cast<RecordedSceneOwner*>(value);if(owner->references.fetch_sub(1,std::memory_order_acq_rel)==1)delete owner;}
int encodeRecordedScene(void*value,const RSVulkanSceneEncodingV1*input,RSTemporalResult*result){
    if(!input||input->size!=sizeof(*input)||input->version!=1||!result||result->size!=sizeof(*result)||result->version!=1)return 0;
    result->encoded=0;auto owner=static_cast<RecordedSceneOwner*>(value);
    if(input->frame.owner!=owner){answer(result,RS_TEMPORAL_INVALID,"The recorded scene belongs to another native generation");return 0;}
    auto frame=input->frame;if(owner->reset.load(std::memory_order_acquire))frame.flags|=RS_TEMPORAL_RESET;
    if(input->aovs&&rsBindTemporalSceneAovs(&frame,input->aovs)!=RS_TEMPORAL_OK){answer(result,RS_TEMPORAL_UNAVAILABLE,"The recorded scene attachment contract is unavailable");return 0;}
    if(input->matrices&&rsBindTemporalSceneMatrices(&frame,input->matrices)!=RS_TEMPORAL_OK){answer(result,RS_TEMPORAL_UNAVAILABLE,"The recorded scene matrix contract is unavailable");return 0;}
    const auto status=processTemporalFrame(&frame,input->color,result,true);
    if(status==RS_TEMPORAL_OK&&result->encoded){owner->latest.store(frame.frameId,std::memory_order_release);owner->reset.store(false,std::memory_order_release);return 1;}
    owner->reset.store(true,std::memory_order_release);return 0;
}
}
extern "C" __attribute__((visibility("default"))) uint32_t rsRecordedSceneConsumerAPI(void){return 1;}
extern "C" __attribute__((visibility("default"))) uint32_t rsRecordedSceneImageDemand1(void){
    const auto demand=macfx::effectPlanSceneFrameDemand(),aovs=macfx::effectPlanSceneAovDemand();
    if(!(demand&~uint32_t(RS_SCENE_COLOR))&&!aovs)return 0;
    uint32_t result=(1u<<RS_VULKAN_SCENE_COLOR)|(1u<<RS_VULKAN_SCENE_OUTPUT);
    if(demand&RS_SCENE_DEPTH)result|=1u<<RS_VULKAN_SCENE_DEPTH;if(demand&RS_SCENE_MOTION)result|=1u<<RS_VULKAN_SCENE_MOTION;
    if(demand&RS_SCENE_EXPOSURE)result|=1u<<RS_VULKAN_SCENE_EXPOSURE;if(demand&RS_SCENE_REACTIVE)result|=(1u<<RS_VULKAN_SCENE_REACTIVE)|(1u<<RS_VULKAN_SCENE_TRANSPARENCY);
    return result|(aovs<<RS_VULKAN_SCENE_AOV_FIRST);
}
extern "C" __attribute__((visibility("default"))) int rsCreateRecordedSceneConsumer1(uint64_t generation,RSRecordedSceneConsumerV1*output){
    if(!generation||!output||output->size!=sizeof(*output)||output->version!=1)return 0;
    try{auto owner=new RecordedSceneOwner(generation);output->owner=owner;output->callbacks={sizeof(output->callbacks),1,owner,retainRecordedScene,releaseRecordedScene,encodeRecordedScene,
        [](void*value,uint64_t frame,uint32_t completion,const RSTemporalResult*){auto owner=static_cast<RecordedSceneOwner*>(value);if(completion!=RS_VULKAN_SCENE_GPU_COMPLETED&&owner->latest.load(std::memory_order_acquire)==frame)owner->reset.store(true,std::memory_order_release);}};return 1;}catch(...){return 0;}
}
extern "C" void rsReleaseTemporalOwner(void *key){
    rsReleaseTemporalSceneMatrices(key);rsReleaseTemporalSceneAovs(key);
    macfx::releaseTemporalSceneContinuations(key);
    std::shared_ptr<SceneOwner>retired;std::shared_ptr<OrderedSceneOwner>ordered;{std::lock_guard<std::mutex> lock(ownersMutex);owners.erase(key);auto found=sceneOwners.find(key);if(found!=sceneOwners.end()){retired=std::move(found->second);sceneOwners.erase(found);}const auto plan=orderedSceneOwners.find(key);if(plan!=orderedSceneOwners.end()){ordered=std::move(plan->second);orderedSceneOwners.erase(plan);}}
    if(ordered)stopEncoderStatus(reinterpret_cast<uintptr_t>(ordered.get()),ordered->statusReported);
    for(auto &slot:loadedProviders)if(const auto p=slot.load(std::memory_order_acquire))p->release(key);
}

// Capture only an application's declared temporal-scaler interface. Render
// targets elsewhere in the command stream are never guessed to be motion or depth.
@interface MLTemporalOwner : NSObject {
@public
    IMP original;
    uint32_t descriptorFlags,kind,lastMethod,optionalMask;
    bool denoised,reactiveEnabled;
    uint64_t frame,failedShape;
    double previousTime;
    bool reset,originalReset,reported,cameraMismatchReported;
    std::string lastMetal4Reason;
    std::mutex cameraMutex;
    RSTemporalCamera camera;
    __weak id cameraCommands;
    std::atomic<bool> cameraPending;
    uint64_t cameraFrame,cameraViewport,destinationWindow,destinationFrame;void*destinationOwner;
    std::mutex planMutex;
    std::unique_ptr<macfx::EffectPlanExecutor> plan;
    std::atomic<bool> statusReported;
    std::shared_ptr<macfx::Metal4SceneIngress>metal4;
    std::shared_ptr<macfx::Metal4SdkHistory>sdkHistory;
    unsigned imageKind;
}
@end
@implementation MLTemporalOwner
- (void)dealloc {stopEncoderStatus(reinterpret_cast<uintptr_t>((__bridge void*)self),statusReported);rsReleaseTemporalOwner((__bridge void*)self);}
@end
namespace {
const char association=0;
struct EncodeHook {Class cls;IMP original;};
std::array<EncodeHook,32> encodeHooks{};std::atomic<unsigned> hookCount{0};std::mutex hooksMutex;
IMP originalEncode(id object){Class cls=object_getClass(object);const unsigned count=hookCount.load(std::memory_order_acquire);
    for(;cls;cls=class_getSuperclass(cls))for(unsigned i=0;i<count;++i)if(encodeHooks[i].cls==cls)return encodeHooks[i].original;return nullptr;
}
void invokeOriginal(id scaler,SEL selector,id commands,IMP implementation,bool reset){
    commands=macfx::Metal4ClassicBridge::recordingTarget(commands);
    if(!reset){reinterpret_cast<void(*)(id,SEL,id)>(implementation)(scaler,selector,commands);return;}
    if(@available(macOS 26.0,*))if([scaler respondsToSelector:@selector(shouldResetHistory)]){id<MTLFXTemporalDenoisedScalerBase>s=scaler;const BOOL previous=s.shouldResetHistory;s.shouldResetHistory=YES;reinterpret_cast<void(*)(id,SEL,id)>(implementation)(scaler,selector,commands);s.shouldResetHistory=previous;return;}
    id<MTLFXTemporalScalerBase>s=scaler;const BOOL previous=s.reset;s.reset=YES;reinterpret_cast<void(*)(id,SEL,id)>(implementation)(scaler,selector,commands);s.reset=previous;
}
void reportMetal4(MLTemporalOwner*state,const std::string&prefix,const macfx::ShaderResult&result){if(result.encoded){state->lastMetal4Reason.clear();state->reported=false;return;}if(state->lastMetal4Reason!=result.reason){macfx::nativeLog(prefix+result.reason);state->lastMetal4Reason=result.reason;}state->reported=true;}
struct Metal4OriginalFrame {
 id scaler;SEL selector;IMP implementation;MLTemporalOwner*owner;std::shared_ptr<macfx::Metal4SdkHistory>history;std::shared_ptr<macfx::Metal4SdkHistory::Ticket>ticket;bool recorded=false;
 Metal4OriginalFrame(id value,SEL call,IMP original,MLTemporalOwner*state):scaler(value),selector(call),implementation(original),owner(state){if(state->kind&&!state->imageKind){if(!state->sdkHistory)state->sdkHistory=std::make_shared<macfx::Metal4SdkHistory>();history=state->sdkHistory;bool reset=state->originalReset;if(state->denoised){if(@available(macOS 26.0,*))reset=reset||[(id<MTLFXTemporalDenoisedScalerBase>)value shouldResetHistory];}else reset=reset||[(id<MTLFXTemporalScalerBase>)value reset];ticket=history->begin(reset);}}
 macfx::ShaderResult record(id commands){invokeOriginal(scaler,selector,commands,implementation,ticket?ticket->reset:owner->originalReset);recorded=true;owner->originalReset=false;return {true,{}};}
 void fallback(id commands){if(!recorded)record(commands);if(history)history->original(ticket);}
 macfx::Metal4OriginalOperation operation(){auto h=history;auto t=ticket;return {[this](id commands){return record(commands);},[h,t]{return !h||h->omit(t);},[h,t]{if(h)h->original(t);},[h,t]{if(h)h->abandoned(t);},[h,t]{return !h||h->mayOmit(t);}};}
};
void encodeDenoisedTemporal(id scaler,SEL selector,id<MTLCommandBuffer>commands,IMP original,MLTemporalOwner*state){
 bool originalRecorded=false;Metal4OriginalFrame sdk(scaler,selector,original,state);if(@available(macOS 26.0,*)){@autoreleasepool{@try{try{
  const auto controls=macfx::temporalControls();if(!macfx::effectPlanRequested()&&controls.method<=RS_TEMPORAL_METALFX){sdk.fallback(commands);return;}
  id<MTLFXTemporalDenoisedScalerBase>source=scaler;RSTemporalFrame frame{};frame.size=sizeof(frame);frame.version=1;frame.owner=(__bridge void*)state;frame.commandBuffer=(__bridge void*)commands;frame.color=(__bridge void*)source.colorTexture;frame.depth=(__bridge void*)source.depthTexture;frame.motion=(__bridge void*)source.motionTexture;
  std::shared_ptr<const macfx::SceneAovLease>metadata;const auto found=macfx::takeTemporalAovsForTextures(frame,metadata);
  const auto fallback=[&](const std::string&reason){if(state->kind){sdk.fallback(commands);originalRecorded=sdk.recorded;}else if(!originalRecorded)invokeOriginal(scaler,selector,commands,original,state->originalReset);state->originalReset=false;state->reset=true;if(!state->reported){macfx::nativeLog("Original denoised scaler retained: "+reason);state->reported=true;}};
  if(found!=RS_TEMPORAL_OK||!metadata){fallback("the exact source color description is required; no primaries or reference white are inferred from texture formats");return;}
  auto packet=metadata->value;frame.frameId=packet.frameId;frame.method=RS_TEMPORAL_METALFX_DENOISED;frame.flags=state->descriptorFlags|(state->reset?RS_TEMPORAL_RESET:0);const double now=CACurrentMediaTime(),elapsed=state->previousTime?now-state->previousTime:1./60;state->previousTime=now;frame.frameTimeMs=float(std::clamp(elapsed*1000.,.001,1000.));frame.sharpness=controls.sharpness;if(state->reactiveEnabled)frame.reactive=(__bridge void*)source.reactiveMaskTexture;
  RSSceneMatrices matrices{};const auto captured=macfx::captureDenoisedScalerInputs(scaler,commands,frame.owner,packet.frameId,state->optionalMask,frame,packet,matrices);if(!captured.encoded){fallback(captured.reason);return;}
  auto lease=macfx::captureSceneAovs(packet,commands.device);if(!lease){fallback("the native denoised scene attachment contract is invalid");return;}lease->upstream=metadata;if(state->kind){frame.commandBufferKind=1;if(!state->metal4)state->metal4=std::make_shared<macfx::Metal4SceneIngress>(commands.device);const auto destination=macfx::takeTemporalSceneDestination(frame);auto result=state->metal4->encode(commands,frame,lease,matrices,destination,source.fence,macfx::Metal4ImageProvenance::Real,sdk.operation(),&sdk.recorded,now);originalRecorded=sdk.recorded;if(!result.encoded)sdk.fallback(commands);reportMetal4(state,"Original Metal 4 denoised output retained: ",result);if(result.encoded){state->reported=false;state->reset=false;}return;}if(macfx::bindSceneAovLease(frame,lease)!=RS_TEMPORAL_OK||rsBindTemporalSceneMatrices(&frame,&matrices)!=RS_TEMPORAL_OK){fallback("the exact native scene tuple could not be retained");return;}
  const auto color=macfx::readImageColor(packet.color);const auto destination=macfx::effectPlanRequested()?macfx::takeTemporalSceneDestination(frame):std::optional<macfx::TemporalSceneDestination>{};
  if(macfx::effectPlanRequested()){
   std::unique_lock lock(state->planMutex,std::try_to_lock);if(!lock){fallback("the ordered scene owner is processing another frame");return;}if(!state->plan){state->plan=std::make_unique<macfx::EffectPlanExecutor>();state->plan->setStatusContext(reinterpret_cast<uintptr_t>((__bridge void*)state));}
   if(!state->plan->requiresTemporal())stopEncoderStatus(reinterpret_cast<uintptr_t>((__bridge void*)state),state->statusReported);
   else{
    const bool direct=source.outputTexture.width==frame.outputWidth&&source.outputTexture.height==frame.outputHeight;if(!direct||(!destination&&!macfx::reserveTemporalOutput(commands,source.outputTexture))){fallback("the ordered scene boundary requires the complete declared final output");return;}
    macfx::DepthFrame depth{source.depthTexture,frame.frameId,macfx::FrameOrigin::TopLeft};macfx::ShaderFrame context{commands,source.colorTexture,source.outputTexture,frame.frameId,now*1000,frame.frameTimeMs,macfx::FrameOrigin::TopLeft,macfx::spatialColorForDescription(color),&depth,color.alpha==macfx::ColorAlpha::Opaque};
    const auto selected=state->plan->prepareWithColorDescription(context,true,&frame,macfx::imageColorLabel(color),color);if(selected.holdPrevious||selected.preparing&&!selected.execution||!selected.execution||!selected.execution->hasTemporal()){fallback(selected.error.empty()?"the ordered scene is preparing":selected.error);return;}
    bool originalEncoded=false;if(!selected.execution->replacesTemporal()){invokeOriginal(scaler,selector,commands,original,state->originalReset);originalEncoded=true;}
    if(source.fence){auto wait=[commands computeCommandEncoder];[wait waitForFence:source.fence];[wait endEncoding];}
    auto capture=macfx::FrameCapture::begin(commands,selected.execution->replacesTemporal()?source.colorTexture:source.outputTexture,frame.frameId);bool mapped=false;const auto encoded=selected.execution->encodeScene(context,frame,&mapped,&depth);
    if(!encoded.encoded){if(!originalEncoded)fallback(encoded.reason);else state->originalReset=false;return;}if(source.fence){auto update=[commands computeCommandEncoder];[update updateFence:source.fence];[update endEncoding];}
    if(destination)macfx::publishTemporalSceneContinuation(commands,*destination,frame,selected.execution,mapped);else macfx::publishTemporalOutputWithDepth(commands,source.outputTexture,frame.frameId,selected.execution,std::move(capture),&depth,mapped,&frame);state->reset=false;
    acceptEncodedScene(reinterpret_cast<uintptr_t>((__bridge void*)state),*selected.execution,frame.frameId);state->statusReported.store(true,std::memory_order_release);state->originalReset=true;state->reported=false;return;
   }
  }
  if(controls.method!=RS_TEMPORAL_METALFX_DENOISED){fallback("the selected replacement does not declare this noisy scene reconstruction contract");return;}
  if(source.fence){auto wait=[commands computeCommandEncoder];[wait waitForFence:source.fence];[wait endEncoding];}RSTemporalResult result{};result.size=sizeof(result);result.version=1;const auto code=processTemporalProviderFrame(&frame,&packet.color,&result);if(code!=RS_TEMPORAL_OK||!result.encoded){fallback(result.reason);return;}if(source.fence){auto update=[commands computeCommandEncoder];[update updateFence:source.fence];[update endEncoding];}state->reset=false;state->originalReset=true;state->reported=false;
 }catch(const std::exception&error){if(state->kind)sdk.fallback(commands);else if(!originalRecorded)invokeOriginal(scaler,selector,commands,original,true);macfx::nativeLog(std::string("Original denoised scaler retained: ")+error.what());}}@catch(NSException*error){if(state->kind)sdk.fallback(commands);else if(!originalRecorded)invokeOriginal(scaler,selector,commands,original,true);macfx::nativeLog(std::string("Original denoised scaler retained: ")+(error.reason.UTF8String?:"Metal rejected the optional scene"));}}}else invokeOriginal(scaler,selector,commands,original,false);
}
void encodeMetal4Image(id scaler,SEL selector,id commands,IMP original,MLTemporalOwner*state){
 Metal4OriginalFrame sdk(scaler,selector,original,state);if(state->imageKind==2||!macfx::effectPlanRequested())sdk.fallback(commands);if(!macfx::effectPlanRequested())return;
 @autoreleasepool{@try{try{macfx::MetalFxImageInputs inputs;auto kind=state->imageKind==1?macfx::MetalFxImageKind::Spatial:macfx::MetalFxImageKind::Interpolation;auto captured=macfx::captureMetalFxImageInputs(scaler,kind,commands,(__bridge void*)state,++state->frame,inputs);if(!captured.encoded){if(!state->reported)macfx::nativeLog("Original Metal 4 SDK image retained: "+captured.reason);state->reported=true;sdk.fallback(commands);return;}
 auto lookup=inputs.frame;lookup.depth=(__bridge void*)inputs.depth;lookup.motion=(__bridge void*)inputs.motion;std::shared_ptr<const macfx::SceneAovLease>metadata;if(macfx::takeTemporalAovsForTextures(lookup,metadata)!=RS_TEMPORAL_OK||!metadata){if(!state->reported)macfx::nativeLog("Original Metal 4 SDK image retained: needs the exact source color/frame description");state->reported=true;sdk.fallback(commands);return;}lookup.frameId=metadata->value.frameId;if(state->imageKind!=2)inputs.frame.frameId=metadata->value.frameId;inputs.frame.commandBufferKind=1;const double now=CACurrentMediaTime();if(!(inputs.frame.frameTimeMs>0)){inputs.frame.frameTimeMs=float(std::clamp((state->previousTime?now-state->previousTime:1./60)*1000.,.001,1000.));state->previousTime=now;}
 auto matrices=macfx::takeTemporalMatricesForTextures(lookup);if(!matrices&&inputs.matricesValid){inputs.matrices.frameId=lookup.frameId;matrices=inputs.matrices;}auto destination=macfx::takeTemporalSceneDestination(lookup);
 if(!state->metal4)state->metal4=std::make_shared<macfx::Metal4SceneIngress>(((__bridge id<MTLTexture>)inputs.frame.color).device);auto result=state->metal4->encode(commands,inputs.frame,metadata,matrices,destination,inputs.fence,state->imageKind==2?macfx::Metal4ImageProvenance::SyntheticUnpaired:macfx::Metal4ImageProvenance::Real,state->imageKind==2?macfx::Metal4OriginalOperation{}:sdk.operation(),state->imageKind==2?nullptr:&sdk.recorded,now);if(!result.encoded)sdk.fallback(commands);if(!result.encoded&&!state->reported){macfx::nativeLog("Original Metal 4 SDK image retained: "+(inputs.sceneReason.empty()?result.reason:inputs.sceneReason+"; "+result.reason));state->reported=true;}if(result.encoded)state->reported=false;
 }catch(const std::exception&e){sdk.fallback(commands);macfx::nativeLog(std::string("Original Metal 4 SDK image retained: ")+e.what());}}@catch(NSException*e){sdk.fallback(commands);macfx::nativeLog(std::string("Original Metal 4 SDK image retained: ")+(e.reason.UTF8String?:"Invalid SDK input metadata"));}}
}
void encodeTemporal(id scaler,SEL selector,id commands){
    MLTemporalOwner *state=objc_getAssociatedObject(scaler,&association);const auto original=state?state->original:originalEncode(scaler);if(!original)return;
    if(internalScaler||!state){invokeOriginal(scaler,selector,commands,original,false);return;}
    if(state->imageKind){encodeMetal4Image(scaler,selector,commands,original,state);return;}
    if(state->denoised){encodeDenoisedTemporal(scaler,selector,commands,original,state);return;}
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
    f.reserved=method==RS_TEMPORAL_ASR||method==RS_TEMPORAL_FSR4?controls.reserved:0;
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
    }else{
        // Providers later report only missing planes; name the actual cause once.
        if(hasCamera&&!state->cameraMismatchReported){macfx::nativeLog("Temporal camera ignored: its depth direction differs from the scaler's depthReversed");state->cameraMismatchReported=true;}
        state->cameraFrame=0;
    }
    if(@available(macOS 27.0,*)){f.colorX=uint32_t(s.colorContentOffsetX);f.colorY=uint32_t(s.colorContentOffsetY);f.depthX=uint32_t(s.depthContentOffsetX);f.depthY=uint32_t(s.depthContentOffsetY);f.motionX=uint32_t(s.motionContentOffsetX);f.motionY=uint32_t(s.motionContentOffsetY);f.outputX=uint32_t(s.outputOffsetX);f.outputY=uint32_t(s.outputOffsetY);}
    auto destinationFrame=f;if(!(f.flags&RS_TEMPORAL_CAMERA_VALID))destinationFrame.frameId=0;
    const auto sceneDestination=macfx::effectPlanRequested()?macfx::takeTemporalSceneDestination(destinationFrame):std::optional<macfx::TemporalSceneDestination>{};
    if(sceneDestination){if(!(f.flags&RS_TEMPORAL_CAMERA_VALID))f.frameId=sceneDestination->frameId;f.flags|=sceneDestination->flags;
        if(state->destinationOwner&&(state->destinationOwner!=sceneDestination->owner||state->destinationWindow!=sceneDestination->window->identity()||state->destinationFrame+1!=sceneDestination->frameId))f.flags|=RS_TEMPORAL_RESET;
        state->destinationOwner=sceneDestination->owner;state->destinationWindow=sceneDestination->window->identity();state->destinationFrame=sceneDestination->frameId;
    }else{state->destinationOwner=nullptr;state->destinationWindow=state->destinationFrame=0;}
    if(state->kind){
        Metal4OriginalFrame sdk(scaler,selector,original,state);
        if(!macfx::effectPlanRequested()){sdk.fallback(commands);return;}
        std::shared_ptr<const macfx::SceneAovLease>metadata;if(macfx::takeTemporalAovsForTextures(f,metadata)!=RS_TEMPORAL_OK||!metadata){if(!state->reported){macfx::nativeLog("Original Metal 4 temporal output retained: needs the exact source color/frame description");state->reported=true;}sdk.fallback(commands);return;}
        if((hasCamera||sceneDestination)&&metadata->value.frameId!=f.frameId){macfx::nativeLog("Original Metal 4 temporal output retained: scene frame identities differ");sdk.fallback(commands);return;}f.frameId=metadata->value.frameId;f.commandBufferKind=1;f.method=RS_TEMPORAL_METALFX;f.reserved=0;
        auto matrices=macfx::takeTemporalMatricesForTextures(f);if(!state->metal4)state->metal4=std::make_shared<macfx::Metal4SceneIngress>(s.colorTexture.device);auto result=state->metal4->encode(commands,f,metadata,matrices,sceneDestination,s.fence,macfx::Metal4ImageProvenance::Real,sdk.operation(),&sdk.recorded,now);if(!result.encoded)sdk.fallback(commands);reportMetal4(state,"Original Metal 4 temporal output retained: ",result);if(result.encoded){state->reported=false;state->reset=false;}return;
    }
    macfx::bindTemporalMatricesForTextures(f);macfx::bindTemporalAovsForTextures(f);
    if(macfx::effectPlanRequested()) {
        std::unique_lock<std::mutex> lock(state->planMutex,std::try_to_lock);
        if(lock.owns_lock()) {
            // Off and non-temporal plans keep no executor: one gated metadata read.
            if(!state->plan&&macfx::temporalPlanRequested()){state->plan=std::make_unique<macfx::EffectPlanExecutor>();state->plan->setStatusContext(reinterpret_cast<uintptr_t>((__bridge void*)state));}
            if(state->plan&&state->plan->requiresTemporal()) {
                const auto&destination=sceneDestination;
                const bool direct=!state->kind&&!f.outputX&&!f.outputY&&f.outputWidth==s.outputTexture.width&&f.outputHeight==s.outputTexture.height;
                const bool admitted=direct&&(destination||macfx::reserveTemporalOutput(commands,s.outputTexture));
                // This boundary is the game's real MetalFX producer. Saved
                // reconstruction nodes still consume its raw jittered input;
                // a scene-only suffix observes its actual reconstructed output.
                f.method=RS_TEMPORAL_METALFX;f.reserved=0;
                bool originalEncoded=false;
                std::string reason="The ordered temporal stage requires one complete, directly presented scene output";
                if(admitted)try {
                    macfx::DepthFrame depth{s.depthTexture,f.frameId,macfx::FrameOrigin::TopLeft};
                    macfx::ShaderFrame context{commands,s.colorTexture,s.outputTexture,f.frameId,now*1000,f.frameTimeMs,macfx::FrameOrigin::TopLeft,macfx::SpatialColor::Perceptual,&depth};
                    std::shared_ptr<macfx::TemporalSceneContinuation>early;
                    if(destination)if(auto value=macfx::temporalSceneContinuation(destination->window);value&&value->frameId()==f.frameId&&state->plan->snapshot()&&value->execution()->revision()==state->plan->snapshot()->revision){const auto ready=value->ready(commands);if(ready.encoded)early=std::move(value);else if(ready.busy){invokeOriginal(scaler,selector,commands,original,state->originalReset);state->originalReset=false;return;}}
                    if(early&&early->displayMapped()){f.preExposure=1;f.exposure=nullptr;f.flags&=~RS_TEMPORAL_AUTO_EXPOSURE;}
                    const auto attachments=macfx::temporalSceneAovs(f);
                    const auto actualColor=attachments?macfx::readImageColor(attachments->value.color):macfx::describeImageColor(f.flags&RS_TEMPORAL_HDR?macfx::ImageColorSpace::ExtendedSRGB:macfx::ImageColorSpace::LegacySDR);
                    const auto selected=early?state->plan->prepareSceneContinuation(context,&f,macfx::imageColorLabel(early->execution()->imageColor()),early->execution()->imageColor(),early->execution()->sceneSuffixSnapshot(),early->execution()->sceneOutputIdentity()):state->plan->prepareWithColorDescription(context,true,&f,macfx::imageColorLabel(actualColor),actualColor);
                    if(selected.holdPrevious||(selected.preparing&&(!selected.execution||!selected.execution->hasTemporal()))){
                        invokeOriginal(scaler,selector,commands,original,state->originalReset);originalEncoded=true;
                        if(!destination)macfx::publishTemporalPreparation(commands,s.outputTexture,f.frameId,selected.error);state->reset=true;state->originalReset=false;return;
                    }
                    if(selected.execution&&selected.execution->hasTemporal()) {
                        // A scene-only generator observes the game's original
                        // scaler. It does not force a reconstruction choice.
                        if(!selected.execution->replacesTemporal()){invokeOriginal(scaler,selector,commands,original,state->originalReset);originalEncoded=true;}
                        if(s.fence){auto wait=[(id<MTLCommandBuffer>)commands computeCommandEncoder];[wait waitForFence:s.fence];[wait endEncoding];}
                        auto capture=macfx::FrameCapture::begin(commands,selected.execution->replacesTemporal()?s.colorTexture:s.outputTexture,f.frameId);
                        bool displayMapped=early&&early->displayMapped();const auto encoded=selected.execution->encodeScene(context,f,&displayMapped,&depth,displayMapped);
                        if(encoded.encoded) {
                            if(s.fence){auto update=[(id<MTLCommandBuffer>)commands computeCommandEncoder];[update updateFence:s.fence];[update endEncoding];}
                            if(destination)macfx::publishTemporalSceneContinuation(commands,*destination,f,selected.execution,displayMapped);
                            else macfx::publishTemporalOutputWithDepth(commands,s.outputTexture,f.frameId,selected.execution,std::move(capture),&depth,displayMapped,&f);
                            acceptEncodedScene(reinterpret_cast<uintptr_t>((__bridge void*)state),*selected.execution,f.frameId);state->statusReported.store(true,std::memory_order_release);
                            // A transient first-frame fallback must not silence a later failure reason.
                            state->reset=false;state->originalReset=true;state->reported=false;return;
                        }reason=encoded.reason;
                    }else reason=selected.error;
                }catch(const std::exception &error){reason=error.what();}
                if(!state->reported){macfx::nativeLog("Original temporal scaler retained: "+reason);state->reported=true;}
                state->reset=true;if(!originalEncoded)invokeOriginal(scaler,selector,commands,original,state->originalReset);state->originalReset=false;return;
            }else{macfx::releaseTemporalSceneContinuations((__bridge void*)state);state->plan.reset();stopEncoderStatus(reinterpret_cast<uintptr_t>((__bridge void*)state),state->statusReported);}
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
        macfx::encodeTemporalProvider(&f,&result);
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

void rememberDenoisedScaler(id scaler,id descriptor,unsigned kind){if(!scaler||internalScaler)return;if(@available(macOS 26.0,*)){auto original=installEncode(scaler);if(!original)return;MTLFXTemporalDenoisedScalerDescriptor*d=descriptor;MLTemporalOwner*state=[MLTemporalOwner new];state->original=original;state->kind=kind;state->denoised=true;state->reset=state->originalReset=true;state->descriptorFlags=d.isAutoExposureEnabled?RS_TEMPORAL_AUTO_EXPOSURE:0;state->reactiveEnabled=d.isReactiveMaskTextureEnabled;state->optionalMask=(d.isSpecularHitDistanceTextureEnabled?1u<<RS_SCENE_AOV_SPECULAR_HIT_DISTANCE:0)|(d.isDenoiseStrengthMaskTextureEnabled?1u<<RS_SCENE_AOV_DENOISE_MASK:0)|(d.isTransparencyOverlayTextureEnabled?1u<<RS_SCENE_AOV_TRANSPARENCY:0);objc_setAssociatedObject(scaler,&association,state,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}}
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
typedef id(*Metal4ScalerFactory)(id,SEL,id,id) __attribute__((ns_returns_retained));
IMP newScaler=nullptr,newScaler4=nullptr,newDenoisedScaler=nullptr,newDenoisedScaler4=nullptr,newSpatialScaler4=nullptr,newInterpolator4=nullptr,newInterpolatorClassic=nullptr;
void rememberMetal4Image(id value,id device,unsigned kind){if(!value||internalScaler)return;macfx::Metal4ClassicBridge::install(device);auto original=installEncode(value);if(!original)return;auto state=[MLTemporalOwner new];state->original=original;state->kind=1;state->imageKind=kind;objc_setAssociatedObject(value,&association,state,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
static id createSpatialScaler4(id descriptor,SEL selector,id device,id compiler) __attribute__((ns_returns_retained));
static id createSpatialScaler4(id descriptor,SEL selector,id device,id compiler){id value=reinterpret_cast<Metal4ScalerFactory>(newSpatialScaler4)(descriptor,selector,device,compiler);rememberMetal4Image(value,device,1);return value;}
static id createInterpolator4(id descriptor,SEL selector,id device,id compiler) __attribute__((ns_returns_retained));
void markLinkedScaler(id descriptor){if(@available(macOS 26.0,*))if([descriptor respondsToSelector:@selector(scaler)]){auto linked=[(MTLFXFrameInterpolatorDescriptor*)descriptor scaler];MLTemporalOwner*owner=linked?objc_getAssociatedObject(linked,&association):nil;if(owner){if(!owner->sdkHistory)owner->sdkHistory=std::make_shared<macfx::Metal4SdkHistory>();owner->sdkHistory->linkedScaler();}}}
static id createInterpolatorClassic(id descriptor,SEL selector,id device) __attribute__((ns_returns_retained));
static id createInterpolatorClassic(id descriptor,SEL selector,id device){markLinkedScaler(descriptor);id value=reinterpret_cast<id(*)(id,SEL,id)>(newInterpolatorClassic)(descriptor,selector,device);if(value&&!internalScaler)macfx::observeMetalFxClassicInterpolator(value);return value;}
static id createInterpolator4(id descriptor,SEL selector,id device,id compiler){markLinkedScaler(descriptor);id value=reinterpret_cast<Metal4ScalerFactory>(newInterpolator4)(descriptor,selector,device,compiler);rememberMetal4Image(value,device,2);return value;}
id createScaler(id descriptor,SEL selector,id device){id value=reinterpret_cast<id(*)(id,SEL,id)>(newScaler)(descriptor,selector,device);rememberScaler(value,descriptor,0);return value;}
static id createScaler4(id descriptor,SEL selector,id device,id compiler) __attribute__((ns_returns_retained));
static id createScaler4(id descriptor,SEL selector,id device,id compiler){if(!internalScaler)macfx::Metal4ClassicBridge::install(device);id value=reinterpret_cast<Metal4ScalerFactory>(newScaler4)(descriptor,selector,device,compiler);rememberScaler(value,descriptor,1);return value;}
id createDenoisedScaler(id descriptor,SEL selector,id device){id value=reinterpret_cast<id(*)(id,SEL,id)>(newDenoisedScaler)(descriptor,selector,device);rememberDenoisedScaler(value,descriptor,0);return value;}
static id createDenoisedScaler4(id descriptor,SEL selector,id device,id compiler) __attribute__((ns_returns_retained));
static id createDenoisedScaler4(id descriptor,SEL selector,id device,id compiler){if(!internalScaler)macfx::Metal4ClassicBridge::install(device);id value=reinterpret_cast<Metal4ScalerFactory>(newDenoisedScaler4)(descriptor,selector,device,compiler);rememberDenoisedScaler(value,descriptor,1);return value;}
__attribute__((constructor)) void installTemporal(){@autoreleasepool{
    if(!getenv("RESHADE_TEMPORAL_CONTROL_FILE")&&!getenv("RESHADE_TEMPORAL_METHOD")&&!getenv("RESHADE_EFFECT_PLAN"))return;
    Class cls=(Class)objc_getClass("MTLFXTemporalScalerDescriptor");Method m=class_getInstanceMethod(cls,@selector(newTemporalScalerWithDevice:));if(m)newScaler=method_setImplementation(m,(IMP)createScaler);
    if(@available(macOS 26.0,*)){m=class_getInstanceMethod(cls,@selector(newTemporalScalerWithDevice:compiler:));if(m)newScaler4=method_setImplementation(m,(IMP)createScaler4);Class denoised=(Class)objc_getClass("MTLFXTemporalDenoisedScalerDescriptor");m=class_getInstanceMethod(denoised,@selector(newTemporalDenoisedScalerWithDevice:));if(m)newDenoisedScaler=method_setImplementation(m,(IMP)createDenoisedScaler);m=class_getInstanceMethod(denoised,@selector(newTemporalDenoisedScalerWithDevice:compiler:));if(m)newDenoisedScaler4=method_setImplementation(m,(IMP)createDenoisedScaler4);Class spatial=(Class)objc_getClass("MTLFXSpatialScalerDescriptor");m=class_getInstanceMethod(spatial,@selector(newSpatialScalerWithDevice:compiler:));if(m)newSpatialScaler4=method_setImplementation(m,(IMP)createSpatialScaler4);Class interpolation=(Class)objc_getClass("MTLFXFrameInterpolatorDescriptor");m=class_getInstanceMethod(interpolation,@selector(newFrameInterpolatorWithDevice:));if(m)newInterpolatorClassic=method_setImplementation(m,(IMP)createInterpolatorClassic);m=class_getInstanceMethod(interpolation,@selector(newFrameInterpolatorWithDevice:compiler:));if(m)newInterpolator4=method_setImplementation(m,(IMP)createInterpolator4);}
}}
}

extern "C" uint32_t rsGetTemporalMethod(void){return macfx::temporalControls().method;}
