#include "live-controls.hpp"
#include "log.hpp"
#include "native-config.hpp"
#include "presentation-internal.hpp"
#include "effect.hpp"
#include "metal-library-cache.hpp"
#include "metal-frame-failure.hpp"
#include "uniform-sources.hpp"
#include "shader-history.hpp"
#include "gpu-completion.hpp"
#include "retroarch.hpp"
#include "effect-node.hpp"
#include "generation-timeline.hpp"
#include "shader-scene-inputs.hpp"
#include "effects-execution.hpp"
#include "image-color.hpp"
#include "color-island.hpp"
#include "isf-node.hpp"
#include "temporal-plan.hpp"
#include "frame-capture.hpp"
#include "metal4-diagnostics.hpp"
#include "source-texture.hpp"
#include "frame.hpp"
#include "frame.h"
#include "frame-depth.h"
#include "frame-depth.hpp"
#include "graphics.hpp"
#include "view-presentation.hpp"
#include "virtual-window.hpp"
#include "layer-presentation.hpp"
#include "resolution-scale.hpp"
#include "window.hpp"
#include "timing.hpp"
#include "diagnostics.hpp"
#include "command-deadline.hpp"
#include "runtime-status.hpp"
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <objc/runtime.h>
#include <chrono>
#include <algorithm>
#include <condition_variable>
#include <cmath>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <cstring>
#include <atomic>
#include <set>
#include "command-resources.hpp"
#include "image-admission.hpp"
#include "depth-demand.hpp"
#include "framebuffer-access.hpp"
#include "in-place-history.hpp"
#include "scene-copy-boundary.hpp"
#include "hook-originals.hpp"
#include "native-layer.h"
#include "contents-geometry.hpp"
#include <unistd.h>
#import <IOSurface/IOSurface.h>

namespace macfx {
namespace {thread_local const ShaderHistoryInput*currentShaderHistory=nullptr;}
ShaderHistoryScope::ShaderHistoryScope(const ShaderHistoryInput*p):previous(currentShaderHistory){currentShaderHistory=p;}
ShaderHistoryScope::~ShaderHistoryScope(){currentShaderHistory=previous;}
}

// Queue-local synchronization owns no reference back to the intercepted queue.
namespace { std::atomic<unsigned> nativeLayerRegistrations{0}; }

@interface RSMLayerResolution : NSObject {
@public
    CGSize publisherSize;
    bool recorded;
    std::mutex lock;
}
@end
@implementation RSMLayerResolution
@end

struct Metal4PendingFrame {
    id<MTLCommandBuffer>commands=nil;id<CAMetalDrawable>drawable=nil;
    uint64_t value=0,captureFrame=UINT64_MAX;bool ready=false,opaque=false,extended=false;
    CGColorSpaceRef color=nullptr;double sourceTime=0;
    ~Metal4PendingFrame(){if(color)CGColorSpaceRelease(color);}
};
API_AVAILABLE(macos(26.0))
@interface RSMMetal4Bridge : NSObject {
@public
    std::mutex lock;
    id<MTLCommandQueue> effects;
    id<MTLSharedEvent> producer;
    id<MTLSharedEvent> finished;
    std::atomic<bool> failed;
    std::atomic<uint64_t>failedPlan,failedControls,failedExtent;
    std::atomic<uint32_t>failedFormat;
    uint64_t sequence;
    dispatch_queue_t recordingQueue;
    std::map<uint64_t,std::shared_ptr<Metal4PendingFrame>>pending;
}
@end
@implementation RSMMetal4Bridge
@end

namespace {
void noteMetalDecision(uintptr_t owner,const char *reason,unsigned width=0,unsigned height=0,uintptr_t queue=0,uint32_t format=0) noexcept {
    macfx::observeRuntimeAdmission(owner,reason,width,height,queue,format);
    if(!macfx::diagnosticsEnabled())return;
    macfx::DiagnosticScope note(macfx::DiagnosticStage::MetalOwnership,owner,width,height,reason);
}
struct NativeHistory {
    macfx::InPlaceHistory images;macfx::InPlaceRequest request;
};
}
@interface RSMInPlaceHistory : NSObject {
@public std::shared_ptr<NativeHistory> history;
}
@end
@implementation RSMInPlaceHistory
@end
namespace {
std::shared_ptr<NativeHistory> nativeHistory(CAMetalLayer *layer,bool create){
    static char key;@synchronized(layer){auto owner=(RSMInPlaceHistory*)objc_getAssociatedObject(layer,&key);
        if(!owner&&create){owner=[RSMInPlaceHistory new];owner->history=std::make_shared<NativeHistory>();objc_setAssociatedObject(layer,&key,owner,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
        return owner?owner->history:nullptr;}
}
void replayNativeHistory(const macfx::InPlaceHistory::Session &state,id<MTLCommandBuffer> commands,id<MTLTexture> target,uintptr_t owner){
    if(!state)return;
    try{if(macfx::InPlaceHistory::replay(state,commands,target)){noteMetalDecision(owner,"history-replayed");return;}}
    catch(...){macfx::InPlaceHistory::bypass(state);}
    noteMetalDecision(owner,macfx::InPlaceHistory::original(state)?"history-original":"history-empty");
    if(macfx::InPlaceHistory::original(state))macfx::nativeLog("In-place history failed; original rendering is retained until settings or the source changes");
}
void bypassNativeHistory(id<MTLDrawable> drawable){
    if(![drawable conformsToProtocol:@protocol(CAMetalDrawable)])return;
    const auto metal=(id<CAMetalDrawable>)drawable;if(auto history=nativeHistory(metal.layer,false)){
        const auto state=history->images.prepare(metal.texture,history->request.read(),reinterpret_cast<uintptr_t>(metal.layer.colorspace));
        const bool wasOriginal=macfx::InPlaceHistory::original(state);
        macfx::InPlaceHistory::bypass(state);
        if(!wasOriginal)macfx::nativeLog("In-place processing queue is unavailable; original rendering is retained until settings or the source changes");
    }
}
}

@interface RSMScheduledEffects : NSObject {
@public
    id<MTLCommandQueue> queue;
    std::atomic<unsigned> pending;
}
@end
@implementation RSMScheduledEffects
@end

// One current-frame association per game command buffer. No global texture
// history and no dependency on guessed offscreen render targets.
@interface RSMFrameDepth : NSObject {
@public
    id<MTLTexture> color;
    id<MTLTexture> depth;
    MTLStoreAction colorStore,depthStore;
    bool valid;
}
@end
@implementation RSMFrameDepth
@end

@interface RSMCaptureSequence : NSObject {
@public uint64_t frame;
}
@end
@implementation RSMCaptureSequence
@end

@interface RSMNativeLayer : NSObject {
@public
    RSNativeMetalFrame frame;
    void *context;
    std::mutex lock;
    std::condition_variable idle;
    unsigned active;
    bool removed;
}
@end
@implementation RSMNativeLayer
- (instancetype)init {self=[super init];if(self)nativeLayerRegistrations.fetch_add(1,std::memory_order_relaxed);return self;}
- (void)dealloc {nativeLayerRegistrations.fetch_sub(1,std::memory_order_relaxed);}
@end

namespace {
char nativeLayerKey;
RSMNativeLayer *nativeLayer(id layer) { return objc_getAssociatedObject(layer,&nativeLayerKey); }
// Launch value or rsSetExplicitHost: one load, so a host that declares itself
// after the library loaded is honored by the next hook call.
bool explicitHost() { return macfx::nativeConfig().explicitHost; }
bool acceptsNativeLayer(CALayer *layer) { return nativeLayer(layer)||(explicitHost()?false:macfx::acceptsLayer(layer)); }
bool currentPresentationDemand() {
    if(macfx::imageProcessingRequested()||macfx::virtualWindowEnabled()||macfx::timingEnabled()||macfx::FrameCapture::configured())return true;
    try{return macfx::drawableResolutionRequested();}catch(...){return false;}
}
uint64_t pendingCaptureFrame(CAMetalLayer *layer) {
    if(!macfx::FrameCapture::configured())return 0;
    static char key;
    @synchronized(layer) {
        auto sequence=(RSMCaptureSequence*)objc_getAssociatedObject(layer,&key);
        if(!sequence){sequence=[RSMCaptureSequence new];objc_setAssociatedObject(layer,&key,sequence,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
        const auto frame=++sequence->frame;
        return macfx::FrameCapture::pending(frame)?frame:0;
    }
}
bool layerPresentationDemand(CAMetalLayer *layer) {
    if(nativeLayer(layer)||currentPresentationDemand())return true;
    const auto presentation=macfx::metalPresentation(layer);
    return presentation&&!presentation->snapshot().stopped;
}
// A bypassed frame of the game's own layer adopts a pass-through plan.
void observeBypassedLayer(CALayer *layer) {
    if(macfx::runtimeStatusLeased()&&acceptsNativeLayer(layer))macfx::observeBypassedPlan(reinterpret_cast<uintptr_t>((__bridge void*)layer));
}
thread_local void *retainedNativeSource=nullptr,*retainedNativeCommands=nullptr;
bool consumeNativeFrame(RSMNativeLayer *registration,id<MTLCommandBuffer> buffer,id<CAMetalDrawable> drawable) {
    {std::lock_guard<std::mutex> guard(registration->lock);if(registration->removed)return false;++registration->active;}
    struct Lease {
        RSMNativeLayer *registration;
        ~Lease(){std::lock_guard<std::mutex> guard(registration->lock);if(!--registration->active)registration->idle.notify_all();}
    } lease{registration};
    struct SourceScope {
        void *previous=retainedNativeSource,*commands=retainedNativeCommands;
        SourceScope(id<CAMetalDrawable> value,id<MTLCommandBuffer> buffer){retainedNativeSource=(__bridge void*)value;retainedNativeCommands=(__bridge void*)buffer;}
        ~SourceScope(){retainedNativeSource=previous;retainedNativeCommands=commands;}
    } source{drawable,buffer};
    return registration->frame(registration->context,(__bridge void*)buffer,(__bridge void*)drawable.texture)!=0;
}
void retireNativeLayer(RSMNativeLayer *registration) {
    if(!registration)return;
    std::unique_lock<std::mutex> guard(registration->lock);registration->removed=true;
    registration->idle.wait(guard,[&]{return registration->active==0;});
}
void log(const std::string &message) {macfx::nativeLog(message);}
std::string colorFormatDiagnostic(MTLPixelFormat value) {
    if(const auto &diagnostics=macfx::nativeConfig().diagnostics;!diagnostics.enabled&&!diagnostics.trace)return {};
    const char *name="Unknown";
    switch(value){
        case MTLPixelFormatInvalid:name="Invalid";break;
        case MTLPixelFormatRGBA8Unorm:name="RGBA8Unorm";break;
        case MTLPixelFormatRGBA8Unorm_sRGB:name="RGBA8Unorm_sRGB";break;
        case MTLPixelFormatBGRA8Unorm:name="BGRA8Unorm";break;
        case MTLPixelFormatBGRA8Unorm_sRGB:name="BGRA8Unorm_sRGB";break;
        case MTLPixelFormatRGB10A2Unorm:name="RGB10A2Unorm";break;
        case MTLPixelFormatRGB10A2Uint:name="RGB10A2Uint";break;
        case MTLPixelFormatBGR10A2Unorm:name="BGR10A2Unorm";break;
        case MTLPixelFormatRGBA16Float:name="RGBA16Float";break;
        case MTLPixelFormatRGBA16Unorm:name="RGBA16Unorm";break;
        case MTLPixelFormatRGBA32Float:name="RGBA32Float";break;
        case MTLPixelFormatBGR10_XR:name="BGR10_XR";break;
        case MTLPixelFormatBGR10_XR_sRGB:name="BGR10_XR_sRGB";break;
        case MTLPixelFormatBGRA10_XR:name="BGRA10_XR";break;
        case MTLPixelFormatBGRA10_XR_sRGB:name="BGRA10_XR_sRGB";break;
        default:break;
    }
    return " colorFormat="+std::string(name)+"("+std::to_string(static_cast<unsigned long long>(value))+")";
}
void savePNG(const std::string &file,const void *bytes,unsigned w,unsigned h,bool bgra,bool flip,unsigned stride) {
    NSBitmapImageRep *image=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr pixelsWide:w pixelsHigh:h bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:w*4 bitsPerPixel:32];
    if(!image||!image.bitmapData)throw std::runtime_error("Cannot allocate the frame capture image");
    const auto *src=static_cast<const unsigned char*>(bytes); auto *dst=image.bitmapData;
    for(unsigned y=0;y<h;++y) for(unsigned x=0;x<w;++x) {
        const auto *p=src+(flip?h-1-y:y)*stride+x*4; auto *q=dst+(y*w+x)*4;
        q[0]=p[bgra?2:0]; q[1]=p[1]; q[2]=p[bgra?0:2]; q[3]=255;
    }
    if(![[image representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:@(file.c_str()) atomically:YES])
        throw std::runtime_error("Cannot write frame capture: "+file);
}
MTLPixelFormat format(reshadefx::texture_format value) {
    using F=reshadefx::texture_format;
    switch(value) {
        case F::rgba8: case F::unknown:return MTLPixelFormatRGBA8Unorm;
        case F::rgba16f:return MTLPixelFormatRGBA16Float;
        case F::rgba32f:return MTLPixelFormatRGBA32Float;
        case F::r8:return MTLPixelFormatR8Unorm;
        case F::rg8:return MTLPixelFormatRG8Unorm;
        case F::r16f:return MTLPixelFormatR16Float;
        case F::r32f:return MTLPixelFormatR32Float;
        case F::r16:return MTLPixelFormatR16Unorm;
        case F::r32u:return MTLPixelFormatR32Uint;
        case F::r32i:return MTLPixelFormatR32Sint;
        case F::rg16:return MTLPixelFormatRG16Unorm;
        case F::rg16f:return MTLPixelFormatRG16Float;
        case F::rg32f:return MTLPixelFormatRG32Float;
        case F::rgba16:return MTLPixelFormatRGBA16Unorm;
        case F::rgba32u:return MTLPixelFormatRGBA32Uint;
        case F::rgba32i:return MTLPixelFormatRGBA32Sint;
        case F::rgb10a2:return MTLPixelFormatRGB10A2Unorm;
        case F::rg11b10f:return MTLPixelFormatRG11B10Float;
        default:throw std::runtime_error("Unsupported Metal texture format");
    }
}
id<MTLTexture> texture(id<MTLDevice> device,unsigned w,unsigned h,MTLPixelFormat pixelFormat,unsigned levels=1,bool storage=false) {
    if(!w||!h||w>16384||h>16384||!levels)throw std::runtime_error("Invalid effect texture dimensions or mip count");
    auto *descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:pixelFormat width:w height:h mipmapped:NO];
    descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget|MTLTextureUsagePixelFormatView;
    if(storage)descriptor.usage|=MTLTextureUsageShaderWrite;
    unsigned maximumLevels=1;for(unsigned dimension=std::max(w,h);dimension>1;dimension>>=1)++maximumLevels;
    descriptor.mipmapLevelCount=std::min(levels,maximumLevels);
    descriptor.storageMode=MTLStorageModePrivate;
    return macfx::newAdmittedTexture(device,descriptor);
}
MTLSamplerAddressMode address(reshadefx::texture_address_mode value) {
    using A=reshadefx::texture_address_mode;
    return value==A::wrap?MTLSamplerAddressModeRepeat:value==A::mirror?MTLSamplerAddressModeMirrorRepeat:
        value==A::border?MTLSamplerAddressModeClampToZero:MTLSamplerAddressModeClampToEdge;
}
MTLBlendFactor blendFactor(reshadefx::blend_factor value) {
    using F=reshadefx::blend_factor;
    switch(value) {
        case F::zero:return MTLBlendFactorZero;case F::one:return MTLBlendFactorOne;
        case F::source_color:return MTLBlendFactorSourceColor;case F::one_minus_source_color:return MTLBlendFactorOneMinusSourceColor;
        case F::dest_color:return MTLBlendFactorDestinationColor;case F::one_minus_dest_color:return MTLBlendFactorOneMinusDestinationColor;
        case F::source_alpha:return MTLBlendFactorSourceAlpha;case F::one_minus_source_alpha:return MTLBlendFactorOneMinusSourceAlpha;
        case F::dest_alpha:return MTLBlendFactorDestinationAlpha;case F::one_minus_dest_alpha:return MTLBlendFactorOneMinusDestinationAlpha;
    }
    throw std::runtime_error("Unsupported blend factor");
}
MTLBlendOperation blendOp(reshadefx::blend_op value) {
    using O=reshadefx::blend_op;
    switch(value) {case O::add:return MTLBlendOperationAdd;case O::subtract:return MTLBlendOperationSubtract;
        case O::reverse_subtract:return MTLBlendOperationReverseSubtract;case O::min:return MTLBlendOperationMin;case O::max:return MTLBlendOperationMax;}
    throw std::runtime_error("Unsupported blend operation");
}
MTLPixelFormat srgbFormat(MTLPixelFormat value) {
    if(value==MTLPixelFormatRGBA8Unorm) return MTLPixelFormatRGBA8Unorm_sRGB;
    if(value==MTLPixelFormatBGRA8Unorm) return MTLPixelFormatBGRA8Unorm_sRGB;
    throw std::runtime_error("sRGB conversion requires an RGBA8 or BGRA8 texture");
}
MTLStencilOperation stencilOperation(reshadefx::stencil_op value) {
    using O=reshadefx::stencil_op;
    switch(value){case O::zero:return MTLStencilOperationZero;case O::keep:return MTLStencilOperationKeep;
        case O::replace:return MTLStencilOperationReplace;case O::increment_saturate:return MTLStencilOperationIncrementClamp;
        case O::decrement_saturate:return MTLStencilOperationDecrementClamp;case O::invert:return MTLStencilOperationInvert;
        case O::increment:return MTLStencilOperationIncrementWrap;case O::decrement:return MTLStencilOperationDecrementWrap;}
    throw std::runtime_error("Unsupported stencil operation");
}
MTLCompareFunction stencilCompare(reshadefx::stencil_func value) {
    using F=reshadefx::stencil_func;
    switch(value){case F::never:return MTLCompareFunctionNever;case F::less:return MTLCompareFunctionLess;
        case F::equal:return MTLCompareFunctionEqual;case F::less_equal:return MTLCompareFunctionLessEqual;
        case F::greater:return MTLCompareFunctionGreater;case F::not_equal:return MTLCompareFunctionNotEqual;
        case F::greater_equal:return MTLCompareFunctionGreaterEqual;case F::always:return MTLCompareFunctionAlways;}
    throw std::runtime_error("Unsupported stencil comparison");
}
MTLPrimitiveType primitive(reshadefx::primitive_topology value) {
    using T=reshadefx::primitive_topology;
    switch(value){case T::point_list:return MTLPrimitiveTypePoint;case T::line_list:return MTLPrimitiveTypeLine;
        case T::line_strip:return MTLPrimitiveTypeLineStrip;case T::triangle_list:return MTLPrimitiveTypeTriangle;
        case T::triangle_strip:return MTLPrimitiveTypeTriangleStrip;}
    throw std::runtime_error("Unsupported primitive topology");
}
// prefill: a back-buffer pass that can leave pixels unwritten starts from a
// copy of the current image (see needsPrefill).
struct Pass { reshadefx::pass metadata; id<MTLRenderPipelineState> pipeline; id<MTLDepthStencilState> stencil; id<MTLComputePipelineState> compute; MTLSize threads; bool prefill=true; };
struct SpatialBusy final : std::runtime_error { using std::runtime_error::runtime_error; };
struct PlacementUnavailable final : std::runtime_error { using std::runtime_error::runtime_error; };
struct HeldInputMismatch final : std::runtime_error { using std::runtime_error::runtime_error; };
bool sameSelection(const macfx::EffectSelection&a,const macfx::EffectSelection&b){return a.file==b.file&&a.key==b.key&&a.revision==b.revision&&a.technique==b.technique;}
void prepareLaunchEffect(){
    static std::once_flag prepared;
    std::call_once(prepared,[]{if(const char *file=std::getenv("RESHADE_PREPARED_EFFECT"))macfx::loadPrepared(std::getenv("RESHADE_EFFECT"),file);});
}
void validateDepth(const macfx::DepthFrame &depth,id<MTLTexture> source,uint64_t frameId,macfx::FrameOrigin origin) {
    const auto image=depth.texture;
    if(!image||depth.frameId!=frameId||depth.origin!=origin)
        throw std::runtime_error("Depth must have the same frame ID and origin as color");
    if(image.device!=source.device||image.width!=source.width||image.height!=source.height)
        throw std::runtime_error("Depth must match the color device and source dimensions");
    if(image.textureType!=MTLTextureType2D||image.sampleCount!=1||image.framebufferOnly||
       (image.usage!=MTLTextureUsageUnknown&&!(image.usage&MTLTextureUsageShaderRead))||
       (image.pixelFormat!=MTLPixelFormatR32Float&&image.pixelFormat!=MTLPixelFormatDepth32Float))
        throw std::runtime_error("Depth requires a shader-readable, resolved R32Float or Depth32Float texture");
}
struct Runtime {
    unsigned uniformCapacity=4;
    std::shared_ptr<macfx::borrowed::Owner> borrowedOwner;
    __weak id<MTLCommandQueue> processingQueue=nil;
    id<MTLDevice> workingDevice=nil;
    macfx::Effect effect; unsigned w=0,h=0; MTLPixelFormat colorFormat=MTLPixelFormatInvalid;
    macfx::UniformSources uniformSources;
    macfx::EffectSelection selection;std::string rejectedRevision;
    std::optional<macfx::EffectSelection> fixedSelection;
    macfx::ShaderParameters fixedParameters;
    uint64_t parameterGeneration=0,appliedParameters=~uint64_t(0);
    std::shared_ptr<macfx::RetroarchChain> retroarch;
    std::shared_ptr<macfx::ShaderNode> placebo;
    std::shared_ptr<macfx::ColorIsland>legacyColorIsland;macfx::ImageColorDescription legacyColorDescription;
    uint64_t placeboControls=~uint64_t(0);
    std::shared_ptr<macfx::EffectPlanExecutor> plan;uintptr_t statusContext=0;
    id<MTLTexture> colors[2],colorInput=nil; std::map<std::string,id<MTLTexture>> textures;
    std::vector<id<MTLSamplerState>> samplers; std::vector<Pass> passes; std::set<std::string> initializedTextures;
    std::vector<id<MTLTexture>> storages;
    bool failed=false, captureFlipY=false, needsDepth=false, depthWarning=false, scalingFirst=false, sceneReset=true, sceneAnimation=true; uint64_t frames=0,uniformFrameId=0;
    macfx::MetalFrameFailure automaticFailure;
    unsigned compiledWidth=0,compiledHeight=0;
    id<MTLTexture> depthCopy,frameDepth,stencilTexture;
    id<MTLComputePipelineState> depthPipeline;
    id<MTLTexture> rgbaImage,rgbaCompleted;id<MTLCommandBuffer> rgbaCommands;
    void prepare(unsigned width,unsigned height) {
        if(compiledWidth==width&&compiledHeight==height)return;
        prepareLaunchEffect();
        selection=fixedSelection?*fixedSelection:macfx::effectSelection();const char *fx=selection.file.c_str();
        if(macfx::retroarchFile(selection.file)||macfx::libplaceboFile(selection.file)||std::filesystem::path(selection.file).extension()==".isf") {needsDepth=false;compiledWidth=width;compiledHeight=height;return;}
        effect=macfx::compile(fx,width,height,410,macfx::includePaths());
        uniformSources.configure(effect,fixedSelection?std::string{}:selection.key);
        const char *selected=selection.technique.empty()?nullptr:selection.technique.c_str();needsDepth=false;
        for(const auto &tech:effect.module.techniques) {
            if(selected&&tech.name!=selected)continue;
            for(const auto &pass:tech.passes)for(const auto &binding:pass.texture_bindings) {
                const auto &sampler=effect.module.samplers.at(binding.index);
                for(const auto &t:effect.module.textures)if(t.unique_name==sampler.texture_name&&t.semantic=="DEPTH")needsDepth=true;
            }
            break;
        }
        compiledWidth=width;compiledHeight=height;
    }
    struct SpatialPreparation {
        struct Request {std::string key;id<MTLCommandQueue>queue=nil;macfx::SpatialFrame frame;macfx::SpatialMethod method=macfx::SpatialMethod::Bilinear;macfx::SpatialConfig config;};
        std::mutex mutex;Request wanted;std::string errorKey,error;bool working=false,busy=false;std::chrono::steady_clock::time_point retry{};
        // One frame can need an input transfer and an output fit. Keep a few
        // prepared requests so they do not displace each other every frame.
        std::vector<std::pair<std::string,std::shared_ptr<macfx::SpatialEncoder>>>ready;
    };
    std::shared_ptr<SpatialPreparation>spatial;
    static dispatch_queue_t spatialPreparationQueue(){static dispatch_queue_t value=dispatch_queue_create("org.maclauncher.graphics.spatial.prepare",dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL,QOS_CLASS_USER_INITIATED,0));return value;}
    macfx::SpatialStatus lastScaling;
    macfx::SpatialStatus preparedSpatial(id<MTLCommandBuffer>commands,const macfx::SpatialFrame&frame,macfx::SpatialMethod method,const macfx::SpatialConfig&config){
        macfx::SpatialStatus result;result.requested=result.active=method;result.frameId=frame.frameId;result.inputWidth=frame.source.width;result.inputHeight=frame.source.height;result.outputWidth=frame.output.width;result.outputHeight=frame.output.height;
        if(!commands||!frame.source||!frame.output){result.reason="Spatial scaling requires commands and images";return result;}
        std::string key;const auto append=[&](uint64_t value){key.append(reinterpret_cast<const char*>(&value),sizeof(value));};
        append(reinterpret_cast<uintptr_t>((__bridge void*)commands.device));append(reinterpret_cast<uintptr_t>((__bridge void*)commands.commandQueue));append(unsigned(method));append(unsigned(frame.color));append(unsigned(frame.origin));append(config.ls1Performance);key.append(reinterpret_cast<const char*>(&config.sharpness),sizeof(config.sharpness));key+=config.modelPath;
        for(id<MTLTexture>image:{frame.source,frame.output}){append(image.width);append(image.height);append(image.pixelFormat);append(image.textureType);append(image.sampleCount);append(image.usage);append(image.framebufferOnly);}
        if(!spatial)spatial={new SpatialPreparation,[](SpatialPreparation*retired){dispatch_async(spatialPreparationQueue(),^{@autoreleasepool{delete retired;}});}};
        const auto state=spatial;std::unique_lock lock(state->mutex,std::try_to_lock);if(!lock.owns_lock()){result.busy=true;result.reason="Spatial preparation metadata is occupied";return result;}
        for(const auto&prepared:state->ready)if(prepared.first==key){auto encoder=prepared.second;lock.unlock();return encoder->encode(commands,frame,method,config);}
        if(state->errorKey==key&&!state->error.empty()&&(!state->busy||std::chrono::steady_clock::now()<state->retry)){result.reason=state->error;result.busy=state->busy;return result;}
        state->wanted={key,commands.commandQueue,frame,method,config};result.busy=true;result.reason="Preparing spatial output";
        if(state->working)return result;state->working=true;lock.unlock();const std::weak_ptr<SpatialPreparation>weak=state;
        dispatch_async(spatialPreparationQueue(),^{auto state=weak.lock();if(!state)return;@autoreleasepool{
            for(;;){SpatialPreparation::Request request;{std::lock_guard guard(state->mutex);request=state->wanted;}
                std::shared_ptr<macfx::SpatialEncoder>encoder;macfx::SpatialStatus prepared;
                @try{try{encoder=std::make_shared<macfx::SpatialEncoder>(request.queue.device);auto commands=[request.queue commandBuffer];if(!commands)throw std::runtime_error("Spatial validation commands are unavailable");prepared=encoder->encode(commands,request.frame,request.method,request.config);}
                    catch(const macfx::ImageBudgetExceeded&error){prepared.reason=error.what();prepared.busy=true;}
                    catch(const std::exception&error){prepared.reason=error.what();}}
                @catch(NSException*error){prepared.reason=error.reason.UTF8String?:"Spatial output preparation failed";}
                std::lock_guard guard(state->mutex);if(state->wanted.key!=request.key)continue;
                if(prepared.encoded){state->ready.emplace_back(request.key,std::move(encoder));if(state->ready.size()>4)state->ready.erase(state->ready.begin());state->errorKey.clear();state->error.clear();}else{state->errorKey=request.key;state->error=prepared.reason;state->busy=prepared.busy;state->retry=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);}
                state->wanted.frame.source=nil;state->wanted.frame.output=nil;state->wanted.queue=nil;state->working=false;return;
            }
        }});
        return result;
    }
    macfx::SpatialStatus scale(id<MTLCommandBuffer>commands,const macfx::SpatialFrame&frame,macfx::SpatialMethod method){const auto&config=macfx::presentationGraphicsEnvironment();return lastScaling=preparedSpatial(commands,frame,method,{config.sharpness,config.ls1Performance,config.modelPath});}
    macfx::SpatialStatus transfer(id<MTLCommandBuffer>commands,id<MTLTexture>source,id<MTLTexture>target,uint64_t frameId,macfx::SpatialColor color){return preparedSpatial(commands,{source,target,frameId,color,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Nearest,{});}
    std::chrono::steady_clock::time_point started=std::chrono::steady_clock::now(),lastFrame=started;double hostOrigin=0,lastHostTime=0;
    void init(id<MTLDevice> device,id<MTLTexture> target,bool scaleFirst=false,id<MTLCommandQueue> queue=nil) {
        w=target.width; h=target.height; colorFormat=target.pixelFormat;
        processingQueue=queue;workingDevice=device;
        scalingFirst=scaleFirst;
        const auto formatDiagnostic=colorFormatDiagnostic(colorFormat);
        prepare(w,h);
        const bool externalImageProvider=macfx::retroarchFile(selection.file)||macfx::libplaceboFile(selection.file)||std::filesystem::path(selection.file).extension()==".isf";
        if(!externalImageProvider&&!macfx::nativeFxColorFormatSupported(colorFormat))
            throw std::runtime_error("Metal drawable format is not supported yet"+formatDiagnostic);
        const char *fx=selection.file.c_str();
        textures.clear(); samplers.clear(); passes.clear(); storages.clear(); initializedTextures.clear();stencilTexture=nil;
        // The stock Slang Metal provider normalizes its 8-bit allocations and
        // render pipelines to BGRA. Give both sides that actual format rather
        // than raw-blit RGBA bytes into its history or a mismatched attachment.
        const bool normalizeSlang=macfx::retroarchFile(selection.file)&&colorFormat==MTLPixelFormatRGBA8Unorm;
        const auto workingFormat=normalizeSlang?MTLPixelFormatBGRA8Unorm:colorFormat;
        colors[0]=texture(device,w,h,workingFormat,1,scalingFirst||normalizeSlang);colors[1]=texture(device,w,h,workingFormat,1,normalizeSlang);
        if(macfx::libplaceboFile(selection.file)||std::filesystem::path(selection.file).extension()==".isf") {
            if(!queue)throw std::runtime_error("Shader initialization requires its Metal queue");
            const bool isf=std::filesystem::path(selection.file).extension()==".isf";placebo=isf?macfx::makeISFShaderNode({selection,fixedParameters}):macfx::makeLibplaceboShaderNode({selection,fixedParameters});
            const auto ready=placebo->prepare({[queue commandBuffer],colors[0],colors[1]});
            if(!ready.encoded)throw std::runtime_error(ready.reason);
            log("Metal image shader selected: "+selection.file+" "+std::to_string(w)+"x"+std::to_string(h)+formatDiagnostic);return;
        }
        if(macfx::retroarchFile(selection.file)) {
            if(!queue)throw std::runtime_error("RetroArch preset initialization requires its Metal queue");
            retroarch=std::make_shared<macfx::RetroarchChain>(selection.file,selection.key,queue,sceneDeclarations,uniformCapacity);
            log("Metal RetroArch preset selected: "+selection.file+" "+std::to_string(w)+"x"+std::to_string(h)+formatDiagnostic);return;
        }
        size_t imageBytes=0;
        for(const auto &t:effect.module.textures) if(t.semantic.empty()&&!external(t.unique_name)) {
            if(t.type!=reshadefx::texture_type::texture_2d&&t.type!=reshadefx::texture_type::texture_1d)
                throw std::runtime_error("Only 1D and 2D effect textures are supported");
            // SPIRV-Cross represents 1D Metal samples/stores with 2D height-one
            // images, preserving coordinates while permitting render clears.
            if(!macfx::textureSource(t).empty()) {
                const auto image=macfx::loadSourceTexture(t,fx,imageBytes);
                auto *descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format(t.format) width:image.width height:image.height mipmapped:NO];
                descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget|MTLTextureUsagePixelFormatView;
                if(t.storage_access)descriptor.usage|=MTLTextureUsageShaderWrite;
                descriptor.storageMode=device.hasUnifiedMemory?MTLStorageModeShared:MTLStorageModeManaged;
                id<MTLTexture> loaded=[device newTextureWithDescriptor:descriptor];
                if(!loaded)throw std::runtime_error("Cannot allocate an image texture");
                [loaded replaceRegion:MTLRegionMake2D(0,0,image.width,image.height) mipmapLevel:0 withBytes:image.pixels.data() bytesPerRow:image.width*image.channels];
                textures[t.unique_name]=loaded;initializedTextures.insert(t.unique_name);
            } else textures[t.unique_name]=texture(device,t.width,t.type==reshadefx::texture_type::texture_1d?1:t.height,format(t.format),t.levels,t.storage_access);
        }
        for(const auto &s:effect.module.storages) {
            const auto found=textures.find(s.texture_name);
            if(found==textures.end())throw std::runtime_error("Storage requires an effect-owned texture");
            const auto image=found->second;
            if(!(image.usage&MTLTextureUsageShaderWrite)||s.level>=image.mipmapLevelCount)throw std::runtime_error("Invalid effect storage level or access");
            auto view=[image newTextureViewWithPixelFormat:image.pixelFormat textureType:MTLTextureType2D levels:NSMakeRange(s.level,1) slices:NSMakeRange(0,1)];
            if(!view)throw std::runtime_error("Cannot create effect storage view");
            storages.push_back(view);
        }
        for(const auto &s:effect.module.samplers) {
            for(const auto &t:effect.module.textures)if(t.unique_name==s.texture_name&&!external(t.unique_name)&&!t.semantic.empty()&&t.semantic!="COLOR"&&t.semantic!="DEPTH")
                throw std::runtime_error("Unsupported texture semantic: "+t.semantic);
            auto *d=[MTLSamplerDescriptor new]; unsigned filter=static_cast<unsigned>(s.filter);
            d.minFilter=(filter&0x10)?MTLSamplerMinMagFilterLinear:MTLSamplerMinMagFilterNearest;
            d.magFilter=(filter&4)?MTLSamplerMinMagFilterLinear:MTLSamplerMinMagFilterNearest;
            d.mipFilter=(filter&1)?MTLSamplerMipFilterLinear:MTLSamplerMipFilterNearest;
            d.sAddressMode=address(s.address_u); d.tAddressMode=address(s.address_v);
            samplers.push_back([device newSamplerStateWithDescriptor:d]);
        }
        std::map<std::string,id<MTLFunction>> functions;
        const char *selected=selection.technique.empty()?nullptr:selection.technique.c_str();
        for(const auto &tech:effect.module.techniques) {
            if(selected && tech.name!=selected) continue;
            if(!selected && !passes.empty()) break;
            for(const auto &p:tech.passes) {
                // Validate hardware sRGB views before any frame encoder opens;
                // high-precision COLOR has no compatible sRGB view format.
                for(const auto &binding:p.texture_bindings)if(binding.srgb)
                    for(const auto &image:effect.module.textures)
                        if(image.unique_name==effect.module.samplers.at(binding.index).texture_name&&image.semantic=="COLOR")
                            srgbFormat(colorFormat);
                if(p.cs_entry_point.empty())primitive(p.topology);
                for(const auto &entry:{p.vs_entry_point,p.ps_entry_point,p.cs_entry_point}) if(!entry.empty()&&!functions.count(entry)) {
                    const auto &shader=effect.shaders.at(entry); NSError *error=nil;
                    id<MTLLibrary> library=macfx::cachedMetalLibrary(device,shader.msl,&error);
                    if(!library) throw std::runtime_error(error.localizedDescription.UTF8String);
                    id<MTLFunction> function=[library newFunctionWithName:@(shader.mslEntry.c_str())];
                    if(!function) throw std::runtime_error("Metal entry point is missing");
                    functions[entry]=function;
                }
                if(!p.cs_entry_point.empty()) {
                    NSError *error=nil;
                    auto compute=[device newComputePipelineStateWithFunction:functions.at(p.cs_entry_point) error:&error];
                    if(!compute)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot create effect compute pipeline");
                    const auto &s=effect.shaders.at(p.cs_entry_point);
                    const auto threads=MTLSizeMake(s.mslThreads[0],s.mslThreads[1],s.mslThreads[2]);
                    const auto limit=device.maxThreadsPerThreadgroup;
                    if(!threads.width||!threads.height||!threads.depth||threads.width>limit.width||threads.height>limit.height||threads.depth>limit.depth||
                       uint64_t(threads.width)*threads.height*threads.depth>compute.maxTotalThreadsPerThreadgroup)
                        throw std::runtime_error("Effect compute group exceeds device limits");
                    if(!p.viewport_width||!p.viewport_height||!p.viewport_dispatch_z)throw std::runtime_error("Effect compute dispatch must be nonempty");
                    passes.push_back({p,nil,nil,compute,threads});continue;
                }
                auto *d=[MTLRenderPipelineDescriptor new]; d.vertexFunction=functions.at(p.vs_entry_point); d.fragmentFunction=functions.at(p.ps_entry_point);
                id<MTLDepthStencilState> stencil=nil;
                const auto first=p.render_target_names[0].empty()?colors[0]:textures.at(p.render_target_names[0]);
                // ReShade uses one effect-owned stencil surface, attached only
                // to passes whose viewport matches the complete effect extent.
                if(p.stencil_enable&&(p.viewport_width?:first.width)==w&&(p.viewport_height?:first.height)==h) {
                    if(!stencilTexture) {
                        auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatStencil8 width:w height:h mipmapped:NO];
                        descriptor.usage=MTLTextureUsageRenderTarget;descriptor.storageMode=MTLStorageModePrivate;
                        stencilTexture=[device newTextureWithDescriptor:descriptor];
                        if(!stencilTexture)throw std::runtime_error("Cannot allocate effect stencil texture");
                    }
                    auto state=[MTLDepthStencilDescriptor new];state.depthCompareFunction=MTLCompareFunctionAlways;state.depthWriteEnabled=NO;
                    auto face=[MTLStencilDescriptor new];face.stencilCompareFunction=stencilCompare(p.stencil_comparison_func);
                    face.stencilFailureOperation=stencilOperation(p.stencil_fail_op);face.depthFailureOperation=stencilOperation(p.stencil_depth_fail_op);
                    face.depthStencilPassOperation=stencilOperation(p.stencil_pass_op);face.readMask=p.stencil_read_mask;face.writeMask=p.stencil_write_mask;
                    state.frontFaceStencil=face;state.backFaceStencil=face;
                    stencil=[device newDepthStencilStateWithDescriptor:state];
                    if(!stencil)throw std::runtime_error("Cannot create effect stencil state");
                    d.stencilAttachmentPixelFormat=MTLPixelFormatStencil8;
                }
                for(unsigned index=0;index<8;++index) {
                if(index&&p.render_target_names[index].empty())break;
                if(index) {
                    const auto first=p.render_target_names[0].empty()?colors[0]:textures.at(p.render_target_names[0]);
                    const auto other=textures.at(p.render_target_names[index]);
                    if(first.width!=other.width||first.height!=other.height)throw std::runtime_error("Pass render targets must have matching dimensions");
                }
                auto *attachment=d.colorAttachments[index];
                attachment.pixelFormat=p.render_target_names[index].empty()?colorFormat:textures.at(p.render_target_names[index]).pixelFormat;
                if(p.srgb_write_enable) attachment.pixelFormat=srgbFormat(attachment.pixelFormat);
                const unsigned mask=p.render_target_write_mask[index];
                attachment.writeMask=static_cast<MTLColorWriteMask>((mask&1?MTLColorWriteMaskRed:0) | (mask&2?MTLColorWriteMaskGreen:0) |
                    (mask&4?MTLColorWriteMaskBlue:0) | (mask&8?MTLColorWriteMaskAlpha:0));
                if(p.blend_enable[index]) {
                    attachment.blendingEnabled=YES;
                    attachment.sourceRGBBlendFactor=blendFactor(p.source_color_blend_factor[index]);
                    attachment.destinationRGBBlendFactor=blendFactor(p.dest_color_blend_factor[index]);
                    attachment.rgbBlendOperation=blendOp(p.color_blend_op[index]);
                    attachment.sourceAlphaBlendFactor=blendFactor(p.source_alpha_blend_factor[index]);
                    attachment.destinationAlphaBlendFactor=blendFactor(p.dest_alpha_blend_factor[index]);
                    attachment.alphaBlendOperation=blendOp(p.alpha_blend_op[index]);
                }
                const unsigned components=index?4:effect.shaders.at(p.ps_entry_point).colorComponents;
                attachment.writeMask=static_cast<MTLColorWriteMask>(attachment.writeMask & (MTLColorWriteMaskRed |
                    (components>1?MTLColorWriteMaskGreen:0) | (components>2?MTLColorWriteMaskBlue:0) | (components>3?MTLColorWriteMaskAlpha:0)));
                }
                NSError *error=nil; auto pipeline=[device newRenderPipelineStateWithDescriptor:d error:&error];
                if(!pipeline) throw std::runtime_error(error.localizedDescription.UTF8String);
                passes.push_back({p,pipeline,stencil,nil,{0,0,0}});passes.back().prefill=needsPrefill(p);
            }
        }
        if(passes.empty()) throw std::runtime_error("No matching graphics technique");
        log("Metal effect ready: "+std::string(fx)+" "+std::to_string(w)+"x"+std::to_string(h)+" passes="+std::to_string(passes.size())+formatDiagnostic);
    }
    std::map<std::string,uint32_t>externalRoles,sceneDeclarations;
    std::map<std::string,id<MTLTexture>>externalTextures;
    static std::string resourceName(const char*name){std::string value="V::";value+=name;std::replace(value.begin(),value.end(),':','_');return value;}
    bool external(const std::string&name)const{return externalRoles.count(name);}
    void declareSceneInputs(const RSShaderSceneInputsV1*inputs){externalRoles.clear();sceneDeclarations.clear();if(inputs)for(unsigned i=0;i<inputs->bindingCount;++i){externalRoles.emplace(resourceName(inputs->bindings[i].name),inputs->bindings[i].role);sceneDeclarations.emplace(inputs->bindings[i].name,inputs->bindings[i].role);}}
    void validateSceneInputs(const RSShaderSceneInputsV1*inputs){
        if(macfx::retroarchFile(selection.file)){if(retroarch)retroarch->validateSceneInputs(inputs);else if(inputs)throw std::runtime_error("Prepare the Slang scene inputs before rendering");return;}
        if(!inputs){if(!externalRoles.empty())throw std::runtime_error("The shader's declared scene inputs are missing from this frame");return;}
        for(unsigned i=0;i<inputs->bindingCount;++i){const auto&b=inputs->bindings[i];const auto unique=resourceName(b.name);const auto*v=rsShaderSceneValue(inputs,b.name);bool found=false;
            if(b.role>=RS_SHADER_SCENE_VIEW_MATRIX){for(const auto&u:effect.module.uniforms)if(u.unique_name==unique){found=true;if(!v||!v->matrix||!u.type.is_floating_point()||u.type.rows!=4||u.type.cols!=4||u.type.array_length||u.size<64||u.offset+64>effect.uniforms.size())throw std::runtime_error("The declared matrix scene input requires a float4x4 uniform: "+std::string(b.name));}}
            else for(const auto&t:effect.module.textures)if(t.unique_name==unique){found=true;if(!v||!v->texture||t.type!=reshadefx::texture_type::texture_2d||t.storage_access||t.render_target||t.semantic=="COLOR")throw std::runtime_error("The declared scene image requires a read-only Texture2D: "+std::string(b.name));}
            if(!found)throw std::runtime_error("The declared scene input resource does not exist in this shader: "+std::string(b.name));
        }
    }
    void bindSceneInputs(const RSShaderSceneInputsV1*inputs){
        validateSceneInputs(inputs);externalTextures.clear();if(!inputs||macfx::retroarchFile(selection.file))return;
        for(unsigned i=0;i<inputs->bindingCount;++i){const auto&b=inputs->bindings[i];const auto key=resourceName(b.name);const auto*v=rsShaderSceneValue(inputs,b.name);
            if(v->texture)externalTextures[key]=(__bridge id<MTLTexture>)v->texture;
            else for(const auto&u:effect.module.uniforms)if(u.unique_name==key)std::memcpy(effect.uniforms.data()+u.offset,v->matrix,64);
        }
    }
    // Without blending, a write mask, stencil, a partial viewport or discard,
    // ReShade's global full-screen PostProcessVS triangle (entry point
    // E__PostProcessVS) writes every pixel, so the target needs no copy of the
    // previous image. A cleared target needs none.
    bool needsPrefill(const reshadefx::pass &p)const{
        if(!p.render_target_names[0].empty()||p.clear_render_targets)return false;
        if(p.blend_enable[0]||p.render_target_write_mask[0]!=0xF||p.stencil_enable||(p.viewport_width&&p.viewport_width!=w)||(p.viewport_height&&p.viewport_height!=h))return true;
        if(p.vs_entry_point!="E__PostProcessVS"||p.topology!=reshadefx::primitive_topology::triangle_list||p.num_vertices!=3)return true;
        const auto shader=effect.shaders.find(p.ps_entry_point);return shader==effect.shaders.end()||shader->second.msl.find("discard_fragment")!=std::string::npos;
    }
    // colors[0] or, until a pass writes that image, the frame's own source.
    id<MTLTexture> color(unsigned index)const{return index==0&&colorInput?colorInput:colors[index];}
    id<MTLTexture> resolve(const std::string &name,unsigned current) {
        if(const auto named=externalTextures.find(name);named!=externalTextures.end())return named->second;
        auto t=textures.find(name); if(t!=textures.end()) return t->second;
        for(const auto &meta:effect.module.textures) if(meta.unique_name==name) {
            if(meta.semantic=="COLOR")return color(current);
            if(meta.semantic=="DEPTH"&&frameDepth)return frameDepth;
        }
        throw std::runtime_error("Unsupported texture semantic: "+name);
    }
    void observePlanFrame(const macfx::ShaderFrame&frame,const std::string&revision,const std::string&reason={}) {
        const auto controls=macfx::presentationControlsDigest();const auto owner=statusContext;
        const std::string planIdentity=revision,pendingReason=reason;
        const auto sequence=frame.frameId;const unsigned iw=frame.source.width,ih=frame.source.height,ow=frame.target.width,oh=frame.target.height;
        macfx::RuntimeStatusEvent event;event.context=owner;event.processing=true;event.resourceAccepted=true;event.phase=macfx::RuntimeStatusPhase::Encoded;
        event.frameId=sequence;event.planRevision=revision;event.controlsDigest=controls;event.reason=reason;event.inputWidth=iw;event.inputHeight=ih;event.outputWidth=ow;event.outputHeight=oh;macfx::observeRuntimeStatus(event);
        // Direct Metal drawable hooks use this same executor without entering
        // processFrameWithDepth. Observe the borrowed buffer's actual completion;
        // no wait or additional submission is needed for either route.
        [frame.commands addCompletedHandler:^(id<MTLCommandBuffer> completed){
            macfx::RuntimeStatusEvent done;done.context=owner;done.processing=true;done.asynchronous=true;done.frameId=sequence;done.planRevision=planIdentity;done.controlsDigest=controls;
            done.phase=completed.status==MTLCommandBufferStatusCompleted?macfx::RuntimeStatusPhase::Completed:macfx::RuntimeStatusPhase::Failed;
            if(completed.status==MTLCommandBufferStatusCompleted)done.reason=pendingReason;else done.reason="The graphics command buffer did not complete";
            done.inputWidth=iw;done.inputHeight=ih;done.outputWidth=ow;done.outputHeight=oh;macfx::observeRuntimeStatus(done);
        }];
    }
    void render(id<MTLCommandBuffer> buffer,id<MTLTexture> target) {render(buffer,target,target,macfx::SpatialMethod::Bilinear);}
    void render(id<MTLCommandBuffer> buffer,id<MTLTexture> source,id<MTLTexture> target,macfx::SpatialMethod method=macfx::SpatialMethod::Bilinear,uint64_t frameId=0,macfx::SpatialColor color=macfx::SpatialColor::Perceptual,macfx::FrameOrigin origin=macfx::FrameOrigin::TopLeft,const macfx::DepthFrame *depth=nullptr,const macfx::ShaderFrame *stage=nullptr,bool opaqueDisplay=true,const macfx::FrameEncodingInputs*strict=nullptr,macfx::FrameEncodingReceipt*receipt=nullptr,macfx::ImageColorSpace colorSpace=macfx::ImageColorSpace::LegacySDR,const macfx::ImageColorDescription*colorDescription=nullptr,double captureTime=0) {
        if(strict&&receipt)receipt->planRevision=strict->plan->revision;
        if(!stage&&macfx::effectPlanRequested()&&!strict) {
            if(!plan)plan=std::make_shared<macfx::EffectPlanExecutor>();
            plan->setStatusContext(statusContext);
            const auto now=std::chrono::steady_clock::now();if(captureTime>0&&!hostOrigin)hostOrigin=captureTime;
            macfx::ShaderFrame context{buffer,source,target,frameId?frameId:frames+1,captureTime>0?(captureTime-hostOrigin)*1000:std::chrono::duration<double,std::milli>(now-started).count(),captureTime>0?(lastHostTime>0?float((captureTime-lastHostTime)*1000):16.666667f):frames?float(std::chrono::duration<double,std::milli>(now-lastFrame).count()):16.666667f,origin,color,depth};
            context.opaqueDisplay=opaqueDisplay;
            auto scene=macfx::takeTemporalOutput(buffer,source);if(scene.preparing)throw SpatialBusy(scene.reason);
            if(scene.execution&&scene.deferred){
                if(scene.completion){const auto ready=scene.completion();if(!ready.encoded)throw SpatialBusy(ready.reason.empty()?"The exact MetalFX source publication is unavailable":ready.reason);}
                if(scene.sourceFrame){context=*scene.sourceFrame;context.commands=buffer;context.source=source;context.target=target;context.depth=scene.depth.texture?&scene.depth:depth;context.origin=origin;context.color=color;context.opaqueDisplay=opaqueDisplay;}
                auto prefix=scene.execution;context.frameId=scene.frameId;std::optional<RSTemporalFrame>inputs;std::shared_ptr<const macfx::EffectSceneLease>aligned;
                if(scene.scene){const auto bound=prefix->bindSceneImage(buffer,source,target,scene.scene,aligned);if(!bound.encoded){if(bound.busy)throw SpatialBusy(bound.reason);throw std::runtime_error(bound.reason);}inputs=macfx::retainedSceneFrame(aligned);}
                const auto description=colorDescription?*colorDescription:prefix->imageColor();
                const auto selected=plan->prepareSceneContinuation(context,inputs?&*inputs:nullptr,macfx::imageColorLabel(description),description,prefix->sceneSuffixSnapshot(),prefix->sceneOutputIdentity());
                if(selected.holdPrevious||selected.preparing&&!selected.execution)throw SpatialBusy(selected.error);
                auto capture=macfx::FrameCapture::begin(buffer,source,frames+1,captureFlipY);
                if(selected.execution){selected.execution->setStatusContext(statusContext);macfx::ImageContentStamp stamp{scene.frameId,1,context.frameId,0,scene.synthetic,scene.displayMapped,aligned};const auto result=selected.execution->encodeContentImage(context,stamp,false,false);if(!result.encoded){if(result.busy)throw SpatialBusy(result.reason);throw std::runtime_error(result.reason);}}
                else if(source!=target){if(source.width!=target.width||source.height!=target.height||source.pixelFormat!=target.pixelFormat)throw SpatialBusy("Preparing the final MetalFX image fit");auto copy=[buffer blitCommandEncoder];if(!copy)throw std::runtime_error("Cannot retain the complete MetalFX image");[copy copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0)sourceSize:MTLSizeMake(source.width,source.height,1)toTexture:target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];}
                if(capture)capture->finish(buffer,target,captureFlipY);if(receipt){receipt->advanced=true;receipt->planRevision=prefix->revision();}observePlanFrame(context,prefix->revision());lastFrame=now;if(captureTime>0)lastHostTime=captureTime;++frames;return;
            }
            if(scene.execution) {
                scene.execution->setStatusContext(statusContext);
                context.frameId=scene.frameId;context.depth=scene.depth.texture?&scene.depth:nullptr;
                auto capture=scene.capture?scene.capture:macfx::FrameCapture::begin(buffer,source,frames+1,captureFlipY);
                const auto result=scene.execution->encodeAfterScene(context,false,false,scene.displayMapped);
                if(!result.encoded){if(result.busy)throw SpatialBusy(result.reason);throw std::runtime_error(result.reason);}
                if(capture)capture->finish(buffer,target,captureFlipY);
                if(receipt){receipt->advanced=true;receipt->planRevision=scene.execution->revision();}
                observePlanFrame(context,scene.execution->revision());
                lastFrame=now;if(captureTime>0)lastHostTime=captureTime;++frames;return;
            }
            const auto selected=colorDescription?plan->prepareWithColorDescription(context,false,nullptr,colorSpace,*colorDescription):plan->prepare(context);
            if(selected.holdPrevious||(selected.preparing&&!selected.execution))throw SpatialBusy(selected.error);
            if(selected.active) {
                if(!selected.execution)throw std::runtime_error(selected.error.empty()?"The ordered effect plan is unavailable":selected.error);
                auto capture=macfx::FrameCapture::begin(buffer,source,frames+1,captureFlipY);
                const auto result=selected.execution->encode(context);
                if(!result.encoded){if(result.busy)throw SpatialBusy(result.reason);throw std::runtime_error(result.reason);}
                if(capture)capture->finish(buffer,target,captureFlipY);
                if(receipt){receipt->advanced=true;receipt->planRevision=selected.execution->revision();}
                observePlanFrame(context,selected.execution->revision(),selected.error);
                lastFrame=now;if(captureTime>0)lastHostTime=captureTime;++frames;return;
            }
            if(receipt){const auto actual=plan->snapshot();if(actual&&actual->mode=="simple")receipt->planRevision=actual->revision;}
            if(!macfx::legacyEffectRequested()) {
                if(source!=target){const auto scaled=scale(buffer,{source,target,frameId,color,origin},method);if(!scaled.encoded)throw std::runtime_error(scaled.reason);}
                return;
            }
        }
        const auto &desired=fixedSelection?*fixedSelection:macfx::effectSelection();
        const bool needsScaling=source.width!=target.width||source.height!=target.height||source.pixelFormat!=target.pixelFormat;
        const bool scaleFirst=needsScaling&&!stage&&macfx::effectAfterScaling();
        const auto effectTarget=scaleFirst?target:source;
        const bool resized=w!=effectTarget.width||h!=effectTarget.height||colorFormat!=effectTarget.pixelFormat||scalingFirst!=scaleFirst;
        // Queues do not order each other's writes to these working images.
        // Replace the complete generation before the first input copy; a late
        // provider-only replacement would still share the previous images.
        const bool moved=workingDevice!=buffer.device||processingQueue!=buffer.commandQueue;
        if(resized||moved||(selection.revision!=desired.revision&&rejectedRevision!=desired.revision)){
            if(workingDevice!=buffer.device)noteMetalDecision(statusContext,"runtime-device-changed",effectTarget.width,effectTarget.height);
            if(processingQueue!=buffer.commandQueue)noteMetalDecision(statusContext,"runtime-queue-changed",effectTarget.width,effectTarget.height);
            if(w!=effectTarget.width||h!=effectTarget.height)noteMetalDecision(statusContext,"runtime-size-changed",effectTarget.width,effectTarget.height);
            if(colorFormat!=effectTarget.pixelFormat)noteMetalDecision(statusContext,"runtime-format-changed",effectTarget.width,effectTarget.height);
            if(scalingFirst!=scaleFirst)noteMetalDecision(statusContext,"runtime-placement-changed",effectTarget.width,effectTarget.height);
            if(selection.revision!=desired.revision)noteMetalDecision(statusContext,"runtime-selection-changed",effectTarget.width,effectTarget.height);
            try{Runtime next;next.fixedSelection=fixedSelection;next.fixedParameters=fixedParameters;next.parameterGeneration=parameterGeneration;next.externalRoles=externalRoles;next.sceneDeclarations=sceneDeclarations;next.uniformCapacity=uniformCapacity;next.captureFlipY=captureFlipY;next.borrowedOwner=borrowedOwner;next.statusContext=statusContext;next.init(buffer.device,effectTarget,scaleFirst,buffer.commandQueue);if(!moved){next.spatial=std::move(spatial);}*this=std::move(next);}
            catch(const std::exception&e){rejectedRevision=desired.revision;if(resized||moved)throw;log("Selected effect unavailable; previous effect retained: "+std::string(e.what()));}
        }
        // Normal fallback keeps A when B cannot initialize. A held transaction
        // must not label those A pixels as B, even when dimensions match.
        if(strict&&!sameSelection(selection,desired))throw HeldInputMismatch("The selected shader did not replace the previous shader");
        if(scaleFirst&&needsDepth)throw PlacementUnavailable("Depth effects require Before scaling placement.");
        auto lease=macfx::borrowed::acquire(buffer,borrowedOwner);
        macfx::borrowed::EmptyEncoding pending{lease};
        if(lease){lease->hold(source);lease->hold(target);}

        if(depth)validateDepth(*depth,source,frameId,origin);
        frameDepth=nil;
        if(needsDepth) {
            if(!depth)throw std::runtime_error("The selected effect requires depth from this frame");
            frameDepth=depth->texture;
            if(frameDepth.pixelFormat==MTLPixelFormatDepth32Float) {
                if(!depthPipeline) {
                    NSError *error=nil;
                    auto library=[buffer.device newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal; kernel void copyDepth(depth2d<float,access::read> source [[texture(0)]],texture2d<float,access::write> target [[texture(1)]],uint2 p [[thread_position_in_grid]]){if(p.x<target.get_width()&&p.y<target.get_height())target.write(float4(source.read(p)),p);}" options:nil error:&error];
                    if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot compile depth access");
                    depthPipeline=[buffer.device newComputePipelineStateWithFunction:[library newFunctionWithName:@"copyDepth"] error:&error];
                    if(!depthPipeline)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot create depth access pipeline");
                }
                if(!depthCopy||depthCopy.width!=w||depthCopy.height!=h) {
                    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR32Float width:w height:h mipmapped:NO];
                    descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;descriptor.storageMode=MTLStorageModePrivate;
                    depthCopy=[buffer.device newTextureWithDescriptor:descriptor];
                    if(!depthCopy)throw std::runtime_error("Cannot allocate depth sampling texture");
                }
                pending.started=true;
                auto copy=[buffer computeCommandEncoder];[copy setComputePipelineState:depthPipeline];
                [copy setTexture:frameDepth atIndex:0];[copy setTexture:depthCopy atIndex:1];
                [copy dispatchThreads:MTLSizeMake(w,h,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[copy endEncoding];
                frameDepth=depthCopy;
            }
            if(lease){lease->hold(depth->texture);lease->hold(frameDepth);lease->hold(depthPipeline);}
        }
        if(lease)lease->hold(colors[0]);
        const bool slang=macfx::retroarchFile(selection.file),isf=std::filesystem::path(selection.file).extension()==".isf",hook=macfx::libplaceboFile(selection.file)||isf;
        // A ReShade FX chain reads a usable source in place of copying it into
        // its first working image; scaling or conversion still writes that image.
        constexpr auto workingUsage=MTLTextureUsageShaderRead|MTLTextureUsagePixelFormatView;
        colorInput=nil;
        if(scaleFirst||source.pixelFormat!=colors[0].pixelFormat) {
            const auto status=scaleFirst?scale(buffer,{source,colors[0],frameId,color,origin},method):transfer(buffer,source,colors[0],frameId,color);
            if(!status.encoded){if(status.busy)throw SpatialBusy(status.reason);throw std::runtime_error(status.reason);}
            pending.started=true;
        } else if(!slang&&!hook&&source!=target&&source.width==w&&source.height==h&&(source.usage&workingUsage)==workingUsage&&
                  source.textureType==MTLTextureType2D&&source.sampleCount==1) {
            pending.started=true;colorInput=source;
        } else {
            pending.started=true;
            auto input=[buffer blitCommandEncoder];
            [input copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toTexture:colors[0] destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
            [input endEncoding];
        }
        unsigned current=0;
        const auto now=std::chrono::steady_clock::now();if(captureTime>0&&!hostOrigin)hostOrigin=captureTime;
        const float frameTime=stage?stage->frameTimeMs:captureTime>0?(lastHostTime>0?float((captureTime-lastHostTime)*1000):16.666667f):frames?std::chrono::duration<float,std::milli>(now-lastFrame).count():16.666667f;lastFrame=now;
        const uint64_t sourceFrameId=uniformFrameId?uniformFrameId:stage?stage->frameId:frameId?frameId:frames;
        if(!slang&&!hook)uniformSources.update(effect,stage?stage->timeMs:captureTime>0?(captureTime-hostOrigin)*1000:std::chrono::duration<double,std::milli>(now-started).count(),frameTime,sourceFrameId,depth!=nullptr,sceneReset,sceneAnimation);
        if(!slang&&!hook&&fixedSelection&&appliedParameters!=parameterGeneration) {
            uniformSources.setParameters(effect,fixedParameters);appliedParameters=parameterGeneration;
        }
        if(stage)bindSceneInputs(macfx::shaderSceneInputs(*stage));
        const auto &values=effect.uniforms;
        auto capture=stage?std::shared_ptr<macfx::FrameCapture>{}:macfx::FrameCapture::begin(buffer,this->color(0),frames+1,captureFlipY);
        bool stencilCleared=false;
        if(hook) {
            macfx::ShaderParameters parameters;
            if(fixedSelection)parameters=fixedParameters;
            else {
                const auto &state=macfx::liveState();const auto packet=state.controls.get();
                if(placeboControls!=state.generation){
                    if(packet&&selection.key.size()==64&&!std::memcmp(packet->effectKey,selection.key.data(),64))
                        for(unsigned i=0;i<packet->count;++i)parameters.emplace(packet->uniforms[i].name,std::vector<float>(packet->uniforms[i].values,packet->uniforms[i].values+packet->uniforms[i].count));
                    placebo->setParameters(parameters);placeboControls=state.generation;
                }
            }
            if(fixedSelection&&appliedParameters!=parameterGeneration){placebo->setParameters(parameters);appliedParameters=parameterGeneration;}
            auto retained=placebo;[buffer addCompletedHandler:^(id<MTLCommandBuffer>){(void)retained;}];
            macfx::ShaderFrame context{buffer,colors[0],colors[1],sourceFrameId,stage?stage->timeMs:std::chrono::duration<double,std::milli>(now-started).count(),frameTime,origin,color,depth,stage?stage->opaqueDisplay:opaqueDisplay};
            const auto description=colorDescription?*colorDescription:macfx::describeImageColor(macfx::ImageColorSpace::LegacySDR);std::optional<macfx::ColorIsland::Images>converted;
            if(isf&&(macfx::imageColorNeedsSDRIsland(description)||colors[0].pixelFormat==MTLPixelFormatRGBA16Float)){
                if(!legacyColorIsland||!macfx::sameImageColorDescription(legacyColorDescription,description)){legacyColorIsland=std::make_shared<macfx::ColorIsland>(buffer.device,description);legacyColorDescription=description;}
                converted=legacyColorIsland->acquire(buffer,w,h,w,h);const auto entered=legacyColorIsland->enter(buffer,colors[0],*converted,sourceFrameId);if(!entered.encoded)throw std::runtime_error(entered.reason);context.source=converted->input;context.target=converted->outputs.front();context.color=macfx::SpatialColor::Perceptual;
            }
            const auto result=placebo->encode(context);
            if(result.encoded&&converted){const auto restored=legacyColorIsland->leave(buffer,context.target,colors[1],sourceFrameId,colors[0]);if(!restored.encoded)throw std::runtime_error(restored.reason);}
            if(!result.encoded){if(result.busy)throw SpatialBusy(result.reason);throw std::runtime_error(result.reason);}current=1;
            if(lease)lease->hold(colors[1]);
        }
        if(slang) {
            if(!retroarch)throw SpatialBusy("Prepare the Slang shader before rendering");
            // The original chain owns its LUT/history/feedback resources until
            // every encoding using it has completed, including live replacement.
            auto retained=retroarch;
            [buffer addCompletedHandler:^(id<MTLCommandBuffer>){(void)retained;}];
            if(lease)lease->hold(colors[1]);
            try {retroarch->encode(buffer,colors[0],colors[1],sourceFrameId,frameTime,fixedSelection?&fixedParameters:nullptr,parameterGeneration,stage?stage->totalSubframes:1,stage?stage->currentSubframe:1,stage?macfx::shaderSceneInputs(*stage):nullptr);}
            catch(const macfx::RetroarchBusy &error){throw SpatialBusy(error.what());}
            current=1;
        }
        // The last full-screen pass of an unscaled FX chain renders into the
        // target itself, so no output copy follows it.
        const bool directOutput=!slang&&!hook&&!passes.empty()&&!needsScaling&&!capture&&target!=source&&colorFormat==target.pixelFormat&&
            target.width==w&&target.height==h&&target.textureType==MTLTextureType2D&&target.sampleCount==1&&(target.usage&MTLTextureUsageRenderTarget)&&
            !passes.back().compute&&passes.back().metadata.render_target_names[0].empty()&&(!passes.back().prefill||!target.framebufferOnly)&&
            (!passes.back().metadata.srgb_write_enable||(target.usage&MTLTextureUsagePixelFormatView))&&target.mipmapLevelCount==1;
        bool wroteTarget=false;
        for(const auto &pass:passes) {
            const auto &p=pass.metadata;
            // Clear new storage before its first read/write. Subsequent frames
            // preserve its contents, including temporal effects and mip views.
            for(const auto &binding:p.storage_bindings) {
                const auto &meta=effect.module.storages.at(binding.index);
                auto image=textures.at(meta.texture_name);
                if(initializedTextures.insert(meta.texture_name).second)for(unsigned level=0;level<image.mipmapLevelCount;++level) {
                    auto clear=[MTLRenderPassDescriptor renderPassDescriptor];
                    clear.colorAttachments[0].texture=image;clear.colorAttachments[0].level=level;
                    clear.colorAttachments[0].loadAction=MTLLoadActionClear;clear.colorAttachments[0].storeAction=MTLStoreActionStore;
                    clear.colorAttachments[0].clearColor=MTLClearColorMake(0,0,0,0);
                    auto initialize=[buffer renderCommandEncoderWithDescriptor:clear];[initialize endEncoding];
                }
                if(lease)lease->hold(image);
            }
            if(pass.compute) {
                const auto &s=effect.shaders.at(p.cs_entry_point);
                auto encoder=[buffer computeCommandEncoder];
                if(!encoder)throw std::runtime_error("Cannot create effect compute encoder");
                [encoder setComputePipelineState:pass.compute];if(lease)lease->hold(pass.compute);
                if(s.mslUniformBuffer!=~0u)[encoder setBytes:values.data() length:values.size() atIndex:s.mslUniformBuffer];
                for(const auto &binding:p.texture_bindings) {
                    auto location=s.mslTextures.find(binding.entry_point_binding);if(location==s.mslTextures.end())continue;
                    auto image=resolve(effect.module.samplers.at(binding.index).texture_name,current);
                    if(binding.srgb)image=[image newTextureViewWithPixelFormat:srgbFormat(image.pixelFormat)];
                    if(!image)throw std::runtime_error("Cannot create compute texture view");
                    if(lease)lease->hold(image);[encoder setTexture:image atIndex:location->second];
                }
                for(const auto &binding:p.sampler_bindings) {
                    auto location=s.mslSamplers.find(binding.entry_point_binding);if(location==s.mslSamplers.end())continue;
                    auto sampler=samplers.at(binding.index);if(lease)lease->hold(sampler);[encoder setSamplerState:sampler atIndex:location->second];
                }
                for(const auto &binding:p.storage_bindings) {
                    auto location=s.mslStorageTextures.find(binding.entry_point_binding);if(location==s.mslStorageTextures.end())continue;
                    auto image=storages.at(binding.index);if(lease)lease->hold(image);[encoder setTexture:image atIndex:location->second];
                }
                [encoder dispatchThreadgroups:MTLSizeMake(p.viewport_width,p.viewport_height,p.viewport_dispatch_z) threadsPerThreadgroup:pass.threads];
                [encoder endEncoding];
                if(p.generate_mipmaps) {
                    id<MTLBlitCommandEncoder> mipmaps=nil;
                    for(const auto &binding:p.storage_bindings) {
                        auto image=textures.at(effect.module.storages.at(binding.index).texture_name);
                        if(image.mipmapLevelCount>1){if(!mipmaps)mipmaps=[buffer blitCommandEncoder];[mipmaps generateMipmapsForTexture:image];}
                    }
                    [mipmaps endEncoding];
                }
                continue;
            }
            bool back=p.render_target_names[0].empty();
            const bool direct=back&&directOutput&&&pass==&passes.back();
            // Writing colors[0] replaces the source it stood for.
            if(back&&current==1)colorInput=nil;
            id<MTLTexture> output=direct?target:back?colors[1-current]:textures.at(p.render_target_names[0]);
            if(lease){lease->hold(output);lease->hold(pass.pipeline);}
            wroteTarget|=direct;
            if(back&&pass.prefill) {
                auto copy=[buffer blitCommandEncoder];
                [copy copyFromTexture:this->color(current) sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toTexture:output destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
                [copy endEncoding];
            }
            auto *d=[MTLRenderPassDescriptor renderPassDescriptor];
            for(unsigned index=0;index<8;++index) {
                if(index&&p.render_target_names[index].empty())break;
                const auto image=index?textures.at(p.render_target_names[index]):output;
                auto attachment=d.colorAttachments[index];
                attachment.texture=p.srgb_write_enable?[image newTextureViewWithPixelFormat:srgbFormat(image.pixelFormat)]:image;
                if(lease)lease->hold(attachment.texture);
                attachment.loadAction=p.clear_render_targets?MTLLoadActionClear:MTLLoadActionLoad;
                if(!(back&&!index)&&initializedTextures.insert(p.render_target_names[index]).second) {
                    attachment.loadAction=MTLLoadActionClear;attachment.clearColor=MTLClearColorMake(0,0,0,1);
                }
                attachment.storeAction=MTLStoreActionStore;
            }
            if(pass.stencil) {
                d.stencilAttachment.texture=stencilTexture;d.stencilAttachment.clearStencil=0;
                d.stencilAttachment.loadAction=stencilCleared?MTLLoadActionLoad:MTLLoadActionClear;d.stencilAttachment.storeAction=MTLStoreActionStore;
                stencilCleared=true;if(lease){lease->hold(stencilTexture);lease->hold(pass.stencil);}
            }
            auto encoder=[buffer renderCommandEncoderWithDescriptor:d]; [encoder setRenderPipelineState:pass.pipeline];
            if(pass.stencil){[encoder setDepthStencilState:pass.stencil];[encoder setStencilReferenceValue:p.stencil_reference_value];}
            const double viewportHeight=p.viewport_height?p.viewport_height:output.height;
            const double viewportY=origin==macfx::FrameOrigin::BottomLeft?double(output.height)-viewportHeight:0;
            [encoder setViewport:MTLViewport{0,viewportY,double(p.viewport_width?p.viewport_width:output.width),viewportHeight,0,1}];
            for(const auto &entry:{p.vs_entry_point,p.ps_entry_point}) {
                const auto &s=effect.shaders.at(entry); bool vertex=s.type==reshadefx::shader_type::vertex;
                if(s.mslUniformBuffer!=~0u) {
                    if(vertex) [encoder setVertexBytes:values.data() length:values.size() atIndex:s.mslUniformBuffer];
                    else [encoder setFragmentBytes:values.data() length:values.size() atIndex:s.mslUniformBuffer];
                }
                for(const auto &binding:p.texture_bindings) {
                    auto location=s.mslTextures.find(binding.entry_point_binding); if(location==s.mslTextures.end()) continue;
                    auto tex=resolve(effect.module.samplers.at(binding.index).texture_name,current);
                    if(binding.srgb) tex=[tex newTextureViewWithPixelFormat:srgbFormat(tex.pixelFormat)];
                    if(!tex) throw std::runtime_error("Cannot create an effect texture view");
                    if(lease)lease->hold(tex);
                    if(vertex) [encoder setVertexTexture:tex atIndex:location->second]; else [encoder setFragmentTexture:tex atIndex:location->second];
                }
                for(const auto &binding:p.sampler_bindings) {
                    auto location=s.mslSamplers.find(binding.entry_point_binding); if(location==s.mslSamplers.end()) continue;
                    auto sampler=samplers.at(binding.index);if(lease)lease->hold(sampler);
                    if(vertex) [encoder setVertexSamplerState:sampler atIndex:location->second]; else [encoder setFragmentSamplerState:sampler atIndex:location->second];
                }
                for(const auto &binding:p.storage_bindings) {
                    auto location=s.mslStorageTextures.find(binding.entry_point_binding);if(location==s.mslStorageTextures.end())continue;
                    auto image=storages.at(binding.index);if(lease)lease->hold(image);
                    if(vertex)[encoder setVertexTexture:image atIndex:location->second];else[encoder setFragmentTexture:image atIndex:location->second];
                }
            }
            [encoder drawPrimitives:primitive(p.topology) vertexStart:0 vertexCount:p.num_vertices]; [encoder endEncoding];
            if(p.generate_mipmaps) {
                id<MTLBlitCommandEncoder> mipmaps=nil;
                for(unsigned index=0;index<8;++index) {
                    if(index&&p.render_target_names[index].empty())break;
                    const auto image=index?textures.at(p.render_target_names[index]):output;
                    if(image.mipmapLevelCount>1){if(!mipmaps)mipmaps=[buffer blitCommandEncoder];[mipmaps generateMipmapsForTexture:image];}
                }
                for(const auto &binding:p.storage_bindings) {
                    auto image=textures.at(effect.module.storages.at(binding.index).texture_name);
                    if(image.mipmapLevelCount>1){if(!mipmaps)mipmaps=[buffer blitCommandEncoder];[mipmaps generateMipmapsForTexture:image];}
                }
                [mipmaps endEncoding];
            }
            if(back) current=1-current;
        }
        const bool scaling=!wroteTarget&&needsScaling&&!scaleFirst&&(!slang||colors[current].width!=target.width||colors[current].height!=target.height);
        const bool conversion=!wroteTarget&&!scaling&&colors[current].pixelFormat!=target.pixelFormat;
        if(scaling||conversion) {
            auto status=scaling?scale(buffer,{this->color(current),target,frameId,color,origin},method):transfer(buffer,this->color(current),target,frameId,color);
            if(!status.encoded) {if(status.busy)throw SpatialBusy(status.reason);throw std::runtime_error(status.reason);}
        }
        const bool copyOutput=!wroteTarget&&!(scaling||conversion);
        auto output=copyOutput?[buffer blitCommandEncoder]:nil;
        if(copyOutput) [output copyFromTexture:this->color(current) sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toTexture:target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
        [output endEncoding];
        if(capture)capture->finish(buffer,target,captureFlipY);
        colorInput=nil;
        if(receipt){receipt->selection=selection;receipt->afterScaling=scaleFirst;
            if(!sameSelection(selection,desired))receipt->planRevision.clear();}
        if(captureTime>0)lastHostTime=captureTime;++frames; if(frames==1 || frames==120) log("Metal effect frame="+std::to_string(frames));
    }
};
std::mutex &mutex() { static auto *m=new std::mutex; return *m; }
std::map<void*,Runtime> &runtimes() { static auto *m=new std::map<void*,Runtime>; return *m; }
std::mutex &bridgeMutex() { static auto *m=new std::mutex;return *m; }
std::map<void*,Runtime> &bridgeRuntimes() {static auto *m=new std::map<void*,Runtime>;return *m;}
struct SurfacePool {
    unsigned w=0,h=0,cursor=0;OSType format=0;std::vector<IOSurfaceRef> surfaces;
    std::vector<std::shared_ptr<macfx::ImageReservation>> reservations;
    id<MTLCommandBuffer>pending;IOSurfaceRef completed=nullptr;
    void clear(){pending=nil;completed=nullptr;for(size_t i=0;i<surfaces.size();++i)macfx::retireOwnedSurface(surfaces[i],std::move(reservations[i]));surfaces.clear();reservations.clear();cursor=0;}
    ~SurfacePool(){clear();}
};
std::map<void*,SurfacePool> &surfacePools(){static auto *m=new std::map<void*,SurfacePool>;return *m;}

macfx::HookOriginals &hooks() { static auto *value=new macfx::HookOriginals; return *value; }
IMP original(id object,SEL selector) { return hooks().original(object,selector); }
char frameDepthKey;
std::atomic<bool> captureDepth{false};
void replace(Class,SEL,IMP);
void depthStoreAction(id object,SEL selector,MTLStoreAction action) {
    reinterpret_cast<void(*)(id,SEL,MTLStoreAction)>(original(object,selector))(object,selector,action);
    RSMFrameDepth *frame=objc_getAssociatedObject(object,&frameDepthKey);
    if(frame&&action!=frame->depthStore)frame->valid=false;
}
void colorStoreAction(id object,SEL selector,MTLStoreAction action,NSUInteger index) {
    reinterpret_cast<void(*)(id,SEL,MTLStoreAction,NSUInteger)>(original(object,selector))(object,selector,action,index);
    RSMFrameDepth *frame=objc_getAssociatedObject(object,&frameDepthKey);
    if(frame&&!index&&action!=frame->colorStore)frame->valid=false;
}
id<MTLRenderCommandEncoder> captureRenderPass(id object,SEL selector,MTLRenderPassDescriptor *descriptor) {
    auto encoder=reinterpret_cast<id<MTLRenderCommandEncoder>(*)(id,SEL,MTLRenderPassDescriptor*)>(original(object,selector))(object,selector,descriptor);
    if(!encoder||!captureDepth.load(std::memory_order_relaxed))return encoder;
    const auto attachment=descriptor.depthAttachment;
    const auto colorAttachment=descriptor.colorAttachments[0];
    const auto stored=[](MTLRenderPassAttachmentDescriptor *a)->id<MTLTexture>{
        if(a.storeAction==MTLStoreActionStore)return a.texture;
        if(a.storeAction==MTLStoreActionMultisampleResolve||a.storeAction==MTLStoreActionStoreAndMultisampleResolve)return a.resolveTexture;
        return nil;
    };
    const auto color=stored(colorAttachment);
    // Match the actual acquired presentation color. A previous depth shader
    // cannot keep retaining attachments for a later color-only selection, and
    // one layer's color-only frame cannot clear another layer's requirement.
    // Other passes return before the environment-backed request check.
    if(!color||!macfx::colorRequiresDepth(color)||!macfx::effectRequested())return encoder;
    const auto depth=stored(attachment);
    if(!depth||!color||depth.pixelFormat!=MTLPixelFormatDepth32Float||depth.sampleCount!=1||depth.textureType!=MTLTextureType2D||
       depth.width!=color.width||depth.height!=color.height||depth.framebufferOnly||
       (depth.usage!=MTLTextureUsageUnknown&&!(depth.usage&MTLTextureUsageShaderRead)))return encoder;
    auto frame=[RSMFrameDepth new];frame->color=color;frame->depth=depth;frame->valid=true;
    frame->colorStore=colorAttachment.storeAction;frame->depthStore=attachment.storeAction;
    objc_setAssociatedObject(object,&frameDepthKey,frame,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(encoder,&frameDepthKey,frame,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    replace(object_getClass(encoder),@selector(setDepthStoreAction:),reinterpret_cast<IMP>(depthStoreAction));
    replace(object_getClass(encoder),@selector(setColorStoreAction:atIndex:),reinterpret_cast<IMP>(colorStoreAction));
    return encoder;
}
RSMFrameDepth *capturedDepth(id<MTLCommandBuffer> commands,id<MTLTexture> color) {
    RSMFrameDepth *frame=objc_getAssociatedObject(commands,&frameDepthKey);
    return frame&&frame->valid&&frame->color==color?frame:nil;
}
void process(id<MTLCommandBuffer> buffer,id<MTLDrawable> drawable,const char *timingScope="game-and-effects",uint64_t captureFrame=UINT64_MAX,double sourceTime=0) {
    if(![drawable conformsToProtocol:@protocol(CAMetalDrawable)]) return;
    id<CAMetalDrawable> metal=(id<CAMetalDrawable>)drawable;
    if(auto registration=nativeLayer(metal.layer)) {
        if(consumeNativeFrame(registration,buffer,metal))return;
    }
    if(explicitHost())return;
    if(macfx::ownsPresentation(metal.layer)) return;
    macfx::DiagnosticScope frame(macfx::DiagnosticStage::MetalFrame,reinterpret_cast<uintptr_t>((__bridge void *)metal.layer));
    bool accepted;{macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalOwnership);accepted=macfx::acceptsLayer(metal.layer);}
    if(!accepted){noteMetalDecision(reinterpret_cast<uintptr_t>((__bridge void*)metal.layer),"frame-owner-missing",metal.texture.width,metal.texture.height);return;}
    if(captureFrame==UINT64_MAX)captureFrame=pendingCaptureFrame(metal.layer);
    noteMetalDecision(reinterpret_cast<uintptr_t>((__bridge void*)metal.layer),"frame-owner-accepted",metal.texture.width,metal.texture.height,
        reinterpret_cast<uintptr_t>((__bridge void*)buffer.commandQueue),uint32_t(metal.texture.pixelFormat));
    if(macfx::effectRequested()){
        // Do not create runtime state for dormant publishers. A changed actual
        // image contract admits one retry before depth/compiler preparation.
        std::lock_guard<std::mutex>guard(mutex());auto found=runtimes().find((__bridge void*)metal.layer);
        if(found!=runtimes().end()&&found->second.automaticFailure.blocks(metal.texture))return;
    }
    static const bool captureInput=std::getenv("RESHADE_NEURAL_CAPTURE_INPUT")!=nullptr;
    if(captureInput){
        static const char sourceInfoKey=0;
        if(!objc_getAssociatedObject(metal.layer,&sourceInfoKey)){
            objc_setAssociatedObject(metal.layer,&sourceInfoKey,@YES,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            log("Metal publisher source "+std::to_string(metal.texture.width)+"x"+std::to_string(metal.texture.height)+" format="+std::to_string(metal.texture.pixelFormat)+" opaque="+(metal.layer.opaque?"true":"false"));
        }
    }
    RSMFrameDepth *captured=capturedDepth(buffer,metal.texture);
    const bool temporalReceipt=macfx::hasTemporalOutput(buffer,metal.texture);
    // An ordered row without matched scene inputs is bypassed by its executor;
    // independent display effects still run. Real scene receipts retain their
    // existing prefix/suffix handoff and are never replaced with guessed inputs.
    // Depth can be absent on menus, or in a different offscreen pass. Keep the
    // original game frame visible and retry only on a later actual association.
    // Explicit frame APIs still return a precise missing-depth error.
    bool requiresDepth=false;
    try {requiresDepth=!temporalReceipt&&macfx::frameRequiresDepth((__bridge void*)metal.layer,buffer.device,metal.texture.width,metal.texture.height);}
    catch(const std::exception &error){
        std::lock_guard<std::mutex> guard(mutex());auto &runtime=runtimes()[(__bridge void*)metal.layer];
        if(runtime.automaticFailure.reject(metal.texture))log("Metal effect disabled: "+std::string(error.what()));return;
    }
    if(requiresDepth&&!captured&&macfx::effectPlanMode()!=1) {
        std::lock_guard<std::mutex> guard(mutex());auto &runtime=runtimes()[(__bridge void*)metal.layer];
        if(!runtime.depthWarning){runtime.depthWarning=true;log("Effect waiting for a shader-readable depth attachment from the presented color frame");}
        return;
    }
    const macfx::DepthFrame depth{captured?captured->depth:nil,0,macfx::FrameOrigin::TopLeft};
    std::shared_ptr<macfx::framebuffer::Lease> framebuffer;
    const auto activePresentation=macfx::metalPresentation(metal.layer);
    const bool readsSource=activePresentation&&!activePresentation->snapshot().stopped;
    macfx::InPlaceHistory::Session history;
    if(!readsSource&&macfx::effectRequested()){
        auto owner=nativeHistory(metal.layer,true);history=owner->images.prepare(metal.texture,owner->request.read(),reinterpret_cast<uintptr_t>(metal.layer.colorspace));
        if(macfx::InPlaceHistory::original(history))return;
    }else if(auto owner=nativeHistory(metal.layer,false))owner->images.reset();
    if(metal.texture.framebufferOnly&&(macfx::imageProcessingRequested(readsSource)||captureFrame)) {
        {std::lock_guard<std::mutex>guard(mutex());if(runtimes()[(__bridge void*)metal.layer].automaticFailure.blocks(metal.texture))return;}
        @try {try {framebuffer=macfx::framebuffer::capture(metal.layer,buffer,metal.texture);}
        catch(const macfx::borrowed::Busy&){noteMetalDecision(reinterpret_cast<uintptr_t>((__bridge void*)metal.layer),"framebuffer-resource-busy");replayNativeHistory(history,buffer,metal.texture,reinterpret_cast<uintptr_t>((__bridge void*)metal.layer));return;}
        catch(const macfx::ImageBudgetExceeded&){noteMetalDecision(reinterpret_cast<uintptr_t>((__bridge void*)metal.layer),"framebuffer-image-budget");replayNativeHistory(history,buffer,metal.texture,reinterpret_cast<uintptr_t>((__bridge void*)metal.layer));return;}
        catch(const std::exception&e){std::lock_guard<std::mutex>guard(mutex());auto &runtime=runtimes()[(__bridge void*)metal.layer];if(runtime.automaticFailure.reject(metal.texture))log("Framebuffer processing disabled: "+std::string(e.what()));return;}}
        @catch(NSException*e){std::lock_guard<std::mutex>guard(mutex());auto &runtime=runtimes()[(__bridge void*)metal.layer];if(runtime.automaticFailure.reject(metal.texture))log("Framebuffer processing disabled: "+std::string(e.reason.UTF8String?:"Capture failed"));return;}
    }
    if(auto presentation=macfx::metalPresentation(metal.layer);presentation&&!presentation->snapshot().stopped) {
        @try {try {
            id<MTLTexture> source=framebuffer?framebuffer->raw:metal.texture;
            if(source.pixelFormat==MTLPixelFormatBGRA8Unorm_sRGB||source.pixelFormat==MTLPixelFormatRGBA8Unorm_sRGB)
                source=[source newTextureViewWithPixelFormat:source.pixelFormat==MTLPixelFormatBGRA8Unorm_sRGB?MTLPixelFormatBGRA8Unorm:MTLPixelFormatRGBA8Unorm];
            if(!source)throw std::runtime_error("Cannot read the game presentation texture");
            auto result=presentation->submitDisplayFrame(buffer,source,0,sourceTime>0?sourceTime:CACurrentMediaTime(),metal.layer.opaque,captured?&depth:nullptr);
            if(result.encoded){macfx::observeTiming(buffer,timingScope,source.width,source.height);return;}
            if(result.busy)return;
            if(!presentation->terminalGpuFailure())presentation->stop();log("Graphics presentation disabled: "+result.reason);
        }catch(const std::exception&error){presentation->stop();log("Graphics presentation disabled: "+std::string(error.what()));}}
        @catch(NSException*error){presentation->stop();log("Graphics presentation disabled: "+std::string(error.reason.UTF8String?:"Presentation failed"));}
    }
    if(!macfx::effectRequested()) {
        macfx::observeBypassedPlan(reinterpret_cast<uintptr_t>((__bridge void*)metal.layer));
        if(captureFrame) {
            id<MTLTexture> source=framebuffer?framebuffer->raw:metal.texture;
            @try {try {
                if(auto capture=macfx::FrameCapture::begin(buffer,source,captureFrame))capture->finish(buffer,source);
            }catch(const std::exception &error){log("Metal frame capture failed: "+std::string(error.what()));}}
            @catch(NSException *error){log("Metal frame capture failed: "+std::string(error.reason.UTF8String?:"Capture failed"));}
        }
        macfx::observeTiming(buffer,std::strcmp(timingScope,"game-and-effects")==0?"game":timingScope,metal.texture.width,metal.texture.height);
        return;
    }
    // A normal Simple Slang selection requires the existing coherent owner:
    // its shared history/uniform resources can be busy between game frames.
    // If that owner is unavailable, keep the publisher consistently visible
    // rather than alternate in-place processing with unprocessed frames.
    // Advanced rows retain their own independent stage fallback below.
    if(macfx::effectPlanRequested()&&macfx::effectPlanMode()==0&&macfx::legacyEffectRequested()&&
       macfx::retroarchFile(macfx::effectSelection().file))return;
    std::unique_lock<std::mutex> guard(mutex(),std::defer_lock);
    {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalRuntimeLock);guard.lock();}
    auto &runtime=runtimes()[(__bridge void*)metal.layer];runtime.statusContext=reinterpret_cast<uintptr_t>((__bridge void*)metal.layer);
    if(runtime.automaticFailure.blocks(metal.texture)) return;
    @try { try {
        id<MTLTexture> target=framebuffer?framebuffer->raw:metal.texture;
        if(target.framebufferOnly) throw std::runtime_error("Drawable is framebuffer-only");
        if(target.pixelFormat==MTLPixelFormatBGRA8Unorm_sRGB || target.pixelFormat==MTLPixelFormatRGBA8Unorm_sRGB) {
            target=[target newTextureViewWithPixelFormat:target.pixelFormat==MTLPixelFormatBGRA8Unorm_sRGB?MTLPixelFormatBGRA8Unorm:MTLPixelFormatRGBA8Unorm];
            if(!target) throw std::runtime_error("Cannot create an sRGB drawable view");
        }
        const auto colorSpace=macfx::imageColorSpace(metal.layer.colorspace,metal.layer.wantsExtendedDynamicRangeContent);auto colorDescription=macfx::describeImageColor(colorSpace);colorDescription.alpha=metal.layer.opaque?macfx::ColorAlpha::Opaque:macfx::ColorAlpha::Straight;
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalEncode,0,target.width,target.height);runtime.render(buffer,target,target,macfx::SpatialMethod::Bilinear,0,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft,captured?&depth:nullptr,nullptr,metal.layer.opaque,nullptr,nullptr,colorSpace,&colorDescription,sourceTime);}
        macfx::observeRuntimeFrameSource(runtime.statusContext,macfx::RuntimeFrameSource::MetalDrawable,captured?macfx::RuntimeInputDepth:0);
        if(history){try{macfx::InPlaceHistory::capture(history,buffer,framebuffer?framebuffer->image:metal.texture,framebuffer?framebuffer->paste:nil);}
            catch(const std::exception &error){macfx::InPlaceHistory::bypass(history);log("In-place effects use original rendering after history failure: "+std::string(error.what()));}}
        if(framebuffer)framebuffer->writeBack(buffer);
        macfx::observeTiming(buffer,timingScope,target.width,target.height);
    }
        catch(const macfx::borrowed::Busy &) { noteMetalDecision(runtime.statusContext,"frame-resource-busy");replayNativeHistory(history,buffer,metal.texture,reinterpret_cast<uintptr_t>((__bridge void*)metal.layer));return; }
        catch(const SpatialBusy &) { noteMetalDecision(runtime.statusContext,"frame-processor-busy");replayNativeHistory(history,buffer,metal.texture,reinterpret_cast<uintptr_t>((__bridge void*)metal.layer));return; }
        catch(const macfx::ImageBudgetExceeded &) { noteMetalDecision(runtime.statusContext,"frame-image-budget");replayNativeHistory(history,buffer,metal.texture,reinterpret_cast<uintptr_t>((__bridge void*)metal.layer));return; }
        catch(const std::exception &error) {if(runtime.automaticFailure.reject(metal.texture))log("Metal effect disabled: "+std::string(error.what()));} }
    @catch(NSException *error) {if(runtime.automaticFailure.reject(metal.texture))log("Metal effect disabled: "+std::string(error.reason.UTF8String));}
}
thread_local bool encodingEffects=false;
std::mutex &queueMutex() { static auto *m=new std::mutex; return *m; }
id<MTLCommandBuffer> __weak &lastGameBuffer() { static __weak id<MTLCommandBuffer> buffer=nil; return buffer; }
void encodePendingPresentations(id<MTLCommandBuffer>);
void commit(id object,SEL selector) {
    static std::atomic<unsigned> calls{0};
    // Launch switches, read once like the logger and window hooks; every
    // command buffer commit passes through here.
    static const bool trace=std::getenv("RESHADE_TRACE")!=nullptr,layerSurface=std::getenv("RESHADE_LAYER_SURFACE")!=nullptr;
    if(trace && calls.fetch_add(1)==0) log("Metal commit: "+std::string(object_getClassName(object)));
    encodePendingPresentations(object);
    reinterpret_cast<void(*)(id,SEL)>(original(object,selector))(object,selector);
    if(!encodingEffects && layerSurface && !macfx::ownsPresentationBuffer(object)) {
        std::lock_guard<std::mutex> guard(queueMutex()); lastGameBuffer()=object;
    }
}
// A native command-buffer present may internally register a scheduled handler
// which calls drawable.present. Its effect is already in the game buffer; do
// not intercept that driver's final presentation as another direct-present game.
// Associated metadata owns no buffer/drawable reference and is cleared when the
// drawable is acquired again, so reuse is processed once on every new frame.
char nativePresentationKey;
bool claimNativePresentation(id<MTLDrawable> drawable) {
    if(![drawable conformsToProtocol:@protocol(CAMetalDrawable)]) return false;
    if(objc_getAssociatedObject(drawable,&nativePresentationKey)) return false;
    objc_setAssociatedObject(drawable,&nativePresentationKey,@YES,OBJC_ASSOCIATION_RETAIN);
    return true;
}
char pendingPresentationKey;
void registerPresentation(id<MTLCommandBuffer> commands,id<MTLDrawable> drawable) {
    if(![drawable conformsToProtocol:@protocol(CAMetalDrawable)]||encodingEffects||macfx::ownsPresentationBuffer(commands))return;
    CAMetalLayer *layer=((id<CAMetalDrawable>)drawable).layer;
    if(macfx::ownsPresentation(layer))return;
    if(!layerPresentationDemand(layer)){observeBypassedLayer(layer);return;}
    if(!acceptsNativeLayer(layer)){noteMetalDecision(reinterpret_cast<uintptr_t>((__bridge void*)layer),"present-owner-missing");return;}
    if(!claimNativePresentation(drawable)){noteMetalDecision(reinterpret_cast<uintptr_t>((__bridge void*)layer),"present-already-claimed");return;}
    noteMetalDecision(reinterpret_cast<uintptr_t>((__bridge void*)layer),"present-registered");
    // Metal permits presentDrawable before endEncoding. Only commit guarantees
    // that the application's encoders have ended and its final writes exist.
    // The buffer owns this bounded list; discarding it releases every drawable.
    @synchronized(commands) {
        NSMutableArray *pending=objc_getAssociatedObject(commands,&pendingPresentationKey);
        if(!pending){pending=[NSMutableArray arrayWithCapacity:1];objc_setAssociatedObject(commands,&pendingPresentationKey,pending,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
        if(pending.count<64)[pending addObject:drawable];
    }
}
void encodePendingPresentations(id<MTLCommandBuffer> commands) {
    NSArray *pending;
    @synchronized(commands) {
        pending=objc_getAssociatedObject(commands,&pendingPresentationKey);
        objc_setAssociatedObject(commands,&pendingPresentationKey,nil,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    for(id<MTLDrawable> drawable in pending){noteMetalDecision(reinterpret_cast<uintptr_t>((__bridge void*)((id<CAMetalDrawable>)drawable).layer),"present-commit");process(commands,drawable);}
}
void present(id object,SEL selector,id<MTLDrawable> drawable) {
    registerPresentation(object,drawable); reinterpret_cast<void(*)(id,SEL,id<MTLDrawable>)>(original(object,selector))(object,selector,drawable);
}
void presentTime(id object,SEL selector,id<MTLDrawable> drawable,CFTimeInterval time) {
    registerPresentation(object,drawable); reinterpret_cast<void(*)(id,SEL,id<MTLDrawable>,CFTimeInterval)>(original(object,selector))(object,selector,drawable,time);
}
// MoltenVK presents its drawable inside a scheduled callback instead of using
// presentDrawable:. Keep the callback's actual queue and drawable associated;
// encode effects after game completion, then present without blocking a driver
// callback or reading the frame through the CPU.
struct PendingPresent { id<MTLDrawable> drawable; SEL selector; CFTimeInterval time; uint64_t captureFrame=0; };
struct ScheduledContext { std::vector<PendingPresent> pending; };
thread_local ScheduledContext *scheduledContext=nullptr;
void finishPresent(const PendingPresent &pending) {
    IMP implementation=original(pending.drawable,pending.selector);
    if(pending.selector==@selector(present))
        reinterpret_cast<void(*)(id,SEL)>(implementation)(pending.drawable,pending.selector);
    else reinterpret_cast<void(*)(id,SEL,CFTimeInterval)>(implementation)(pending.drawable,pending.selector,pending.time);
}
bool deferPresent(id<MTLDrawable> drawable,SEL selector,CFTimeInterval time=0) {
    if(!scheduledContext || ![drawable conformsToProtocol:@protocol(CAMetalDrawable)] ||
        objc_getAssociatedObject(drawable,&nativePresentationKey) || macfx::ownsPresentation(((id<CAMetalDrawable>)drawable).layer)) return false;
    if(!layerPresentationDemand(((id<CAMetalDrawable>)drawable).layer)){observeBypassedLayer(((id<CAMetalDrawable>)drawable).layer);return false;}
    if(!acceptsNativeLayer(((id<CAMetalDrawable>)drawable).layer)) return false;
    const bool explicitFrame=nativeLayer(((id<CAMetalDrawable>)drawable).layer)!=nil;
    const auto captureFrame=pendingCaptureFrame(((id<CAMetalDrawable>)drawable).layer);
    if(!explicitFrame&&macfx::graphicsRequested()&&!macfx::effectRequested()&&!captureFrame) {
        const auto presentation=macfx::metalPresentation(((id<CAMetalDrawable>)drawable).layer);
        if(!presentation||presentation->snapshot().stopped){observeBypassedLayer(((id<CAMetalDrawable>)drawable).layer);return false;}
    }
    if(!explicitFrame&&!macfx::effectRequested()&&!macfx::graphicsRequested()&&!macfx::timingEnabled()&&!captureFrame)return false;
    scheduledContext->pending.push_back({drawable,selector,time,captureFrame});
    return true;
}
void drawablePresent(id object,SEL selector) {
    if(!deferPresent(object,selector)) finishPresent({object,selector,0});
}
void drawablePresentTime(id object,SEL selector,CFTimeInterval time) {
    if(!deferPresent(object,selector,time)) finishPresent({object,selector,time});
}
char scheduledEffectsKey;
RSMScheduledEffects *scheduledEffects(id<MTLCommandQueue> producer) {
    @synchronized(producer) {
        auto state=(RSMScheduledEffects *)objc_getAssociatedObject(producer,&scheduledEffectsKey);
        if(!state) {
            state=[RSMScheduledEffects new];state->pending.store(0);
            // Never allocate from the game queue inside its completion handler:
            // a bounded producer may not release that slot until we return.
            // Leave capacity for buffers whose completion callbacks are retiring.
            state->queue=[producer.device newCommandQueueWithMaxCommandBufferCount:16];
            objc_setAssociatedObject(producer,&scheduledEffectsKey,state,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
        return state;
    }
}
void addScheduled(id object,SEL selector,MTLCommandBufferHandler handler) {
    auto add=reinterpret_cast<void(*)(id,SEL,MTLCommandBufferHandler)>(original(object,selector));
    // An explicit registration can consume a drawable even with shared FX Off.
    // Existing contexts retain their callbacks; fresh idle buffers need none.
    if(encodingEffects || macfx::ownsPresentationBuffer(object)||
       (!nativeLayerRegistrations.load(std::memory_order_relaxed)&&!currentPresentationDemand())) { add(object,selector,handler); return; }
    auto context=std::make_shared<ScheduledContext>();
    [object addCompletedHandler:^(id<MTLCommandBuffer> game) { @autoreleasepool {
        if(context->pending.empty()) return;
        if(macfx::timingEnabled()) {
            id<CAMetalDrawable> drawable=(id<CAMetalDrawable>)context->pending.front().drawable;
            macfx::recordTiming(game,"game",drawable.texture.width,drawable.texture.height);
        }
        if(!macfx::effectRequested()&&!macfx::graphicsRequested()&&
           std::none_of(context->pending.begin(),context->pending.end(),[](const auto &pending){return pending.captureFrame||nativeLayer(((id<CAMetalDrawable>)pending.drawable).layer)!=nil;})) {
            for(const auto &pending:context->pending)finishPresent(pending);
            return;
        }
        if(game.status!=MTLCommandBufferStatusCompleted) {
            for(const auto &pending:context->pending){bypassNativeHistory(pending.drawable);finishPresent(pending);}
            return;
        }
        auto state=scheduledEffects(game.commandQueue);
        auto count=state->pending.load();
        while(count<8 && !state->pending.compare_exchange_weak(count,count+1)) {}
        if(count>=8 || !state->queue) {
            if(count<8)state->pending.fetch_sub(1);
            for(const auto &pending:context->pending){bypassNativeHistory(pending.drawable);finishPresent(pending);}
            return;
        }
        id<MTLCommandBuffer> effects;
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalQueue);effects=[state->queue commandBuffer];}
        if(!effects) {
            state->pending.fetch_sub(1);
            for(const auto &pending:context->pending){bypassNativeHistory(pending.drawable);finishPresent(pending);}
            return;
        }
        [effects addCompletedHandler:^(id<MTLCommandBuffer>) {state->pending.fetch_sub(1);}];
        struct Encoding {bool previous=encodingEffects;Encoding(){encodingEffects=true;}~Encoding(){encodingEffects=previous;}} encoding;
        for(const auto &pending:context->pending) process(effects,pending.drawable,"effects",pending.captureFrame);
        auto originalAdd=reinterpret_cast<void(*)(id,SEL,MTLCommandBufferHandler)>(original(effects,@selector(addScheduledHandler:)));
        originalAdd(effects,@selector(addScheduledHandler:),^(id<MTLCommandBuffer>) {
            for(const auto &pending:context->pending) finishPresent(pending);
        });
        [effects commit];
    }}];
    add(object,selector,^(id<MTLCommandBuffer> buffer) {
        auto *previous=scheduledContext;scheduledContext=context.get();
        @try {handler(buffer);} @finally {scheduledContext=previous;}
    });
}
void replace(Class,SEL,IMP);
char metal4BridgeKey;
// Metal 4 signals drawable completion on its queue rather than presenting from
// an MTLCommandBuffer. Synchronize the exact producer queue with the existing
// Metal effect backend, then leave the original drawable/presentation owner in
// control. Both directions use GPU events; no CPU completion wait is introduced.
API_AVAILABLE(macos(26.0))
void readyMetal4Frame(RSMMetal4Bridge*state,uint64_t value){
    {std::lock_guard guard(state->lock);const auto found=state->pending.find(value);if(found==state->pending.end())return;found->second->ready=true;}
    // Preserve the original producer's frame order even when a later fallback
    // is ready before an earlier asynchronous scene receipt. Committing that
    // later effects buffer first would wait on a producer blocked by frame one.
    dispatch_async(state->recordingQueue,^{@autoreleasepool{
        for(;;){std::shared_ptr<Metal4PendingFrame>frame;
            {std::lock_guard guard(state->lock);if(state->pending.empty()||!state->pending.begin()->second->ready)return;frame=std::move(state->pending.begin()->second);state->pending.erase(state->pending.begin());}
            auto commands=frame->commands;const auto signal=frame->value;
            if(const auto source=macfx::temporalOutputSourceFrame(commands,frame->drawable.texture);source&&source->timeMs>0)frame->sourceTime=source->timeMs/1000;
            @try{try{auto layer=frame->drawable.layer;const auto color=layer.colorspace;const bool sameColor=frame->color==color||(frame->color&&color&&CFEqual(frame->color,color));
                if(!state->failed.load()&&sameColor&&frame->opaque==layer.opaque&&frame->extended==layer.wantsExtendedDynamicRangeContent)process(commands,frame->drawable,"metal4-effects-and-producer-dependency",frame->captureFrame,frame->sourceTime);
                else if(macfx::effectRequested()){const auto presentation=macfx::metalPresentation(layer);if(!presentation||presentation->snapshot().stopped)if(auto history=nativeHistory(layer,false))if(auto retained=history->images.retained(frame->drawable.texture,reinterpret_cast<uintptr_t>(frame->color)))replayNativeHistory(retained,commands,frame->drawable.texture,reinterpret_cast<uintptr_t>((__bridge void*)layer));}}
                catch(const std::exception&error){log("Metal 4 frame processing retained native output: "+std::string(error.what()));}}
            @catch(NSException*error){log("Metal 4 frame processing retained native output: "+std::string(error.reason.UTF8String?:"Image processing failed"));}
            [commands encodeSignalEvent:state->finished value:signal];
            const auto failedPlan=macfx::effectPlanDemandGeneration(),failedControls=macfx::liveState().generation;
            const uint64_t failedExtent=(uint64_t(frame->drawable.texture.width)<<32)|frame->drawable.texture.height;const auto failedFormat=uint32_t(frame->drawable.texture.pixelFormat);
            [commands addCompletedHandler:^(id<MTLCommandBuffer>completed){if(completed.status!=MTLCommandBufferStatusCompleted){
                if(completed.status==MTLCommandBufferStatusError){state->failedPlan.store(failedPlan);state->failedControls.store(failedControls);state->failedExtent.store(failedExtent);state->failedFormat.store(failedFormat);if(!state->failed.exchange(true))log("Metal 4 effect queue disabled for the current graphics and source contract");}
                if(state->finished.signaledValue<signal)state->finished.signaledValue=signal;
            }}];
            [commands commit];
        }
    }});
}
API_AVAILABLE(macos(26.0))
void signalMetal4Drawable(id object,SEL selector,id<MTLDrawable> drawable) {
    auto forward=reinterpret_cast<void(*)(id,SEL,id<MTLDrawable>)>(original(object,selector));
    if(![drawable conformsToProtocol:@protocol(CAMetalDrawable)]) {forward(object,selector,drawable);return;}
    id<CAMetalDrawable> metal=(id<CAMetalDrawable>)drawable;
    const auto captureFrame=pendingCaptureFrame(metal.layer);
    const bool explicitFrame=nativeLayer(metal.layer)!=nil;
    if((!explicitFrame&&!macfx::effectRequested()&&!macfx::graphicsRequested()&&!captureFrame)||macfx::ownsPresentation(metal.layer) || !acceptsNativeLayer(metal.layer) || objc_getAssociatedObject(drawable,&nativePresentationKey)) {forward(object,selector,drawable);return;}
    if(!explicitFrame&&!macfx::effectRequested()&&!captureFrame) {
        const auto presentation=macfx::metalPresentation(metal.layer);
        if(!presentation||presentation->snapshot().stopped){observeBypassedLayer(metal.layer);forward(object,selector,drawable);return;}
    }
    id<MTL4CommandQueue> producerQueue=object;
    RSMMetal4Bridge *state;
    @synchronized(object) {
        state=objc_getAssociatedObject(object,&metal4BridgeKey);
        if(state&&state->failed.load()){
            const uint64_t extent=(uint64_t(metal.texture.width)<<32)|metal.texture.height;
            std::lock_guard guard(state->lock);
            if(state->pending.empty()&&(state->failedPlan.load()!=macfx::effectPlanDemandGeneration()||state->failedControls.load()!=macfx::liveState().generation||state->failedExtent.load()!=extent||state->failedFormat.load()!=uint32_t(metal.texture.pixelFormat)))state=nil;
        }
        if(!state) {
            state=[RSMMetal4Bridge new];state->failed.store(false);
            state->effects=[producerQueue.device newCommandQueue];
            state->producer=[producerQueue.device newSharedEvent];
            state->finished=[producerQueue.device newSharedEvent];
            state->recordingQueue=dispatch_queue_create("org.maclauncher.metal4.frame-recording",dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL,QOS_CLASS_USER_INITIATED,0));
            objc_setAssociatedObject(object,&metal4BridgeKey,state,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
    }
    std::lock_guard<std::mutex> guard(state->lock);
    if(state->failed.load() || !state->effects || !state->producer || !state->finished) {bypassNativeHistory(drawable);forward(object,selector,drawable);return;}
    id<MTLCommandBuffer> effects=[state->effects commandBuffer];
    if(!effects) {bypassNativeHistory(drawable);forward(object,selector,drawable);return;}
    const uint64_t value=++state->sequence;
    // Build the whole effect buffer before placing any dependent work on the
    // application queue. Failed/unsupported shaders still release the fence.
    [effects encodeWaitForEvent:state->producer value:value];
    auto pending=std::make_shared<Metal4PendingFrame>();pending->commands=effects;pending->drawable=metal;pending->value=value;pending->captureFrame=captureFrame;pending->sourceTime=CACurrentMediaTime();pending->opaque=metal.layer.opaque;pending->extended=metal.layer.wantsExtendedDynamicRangeContent;pending->color=metal.layer.colorspace;if(pending->color)CGColorSpaceRetain(pending->color);state->pending.emplace(value,pending);
    const bool waiting=macfx::observeDeferredTemporalOutput(effects,metal.texture,0,state->recordingQueue,[state,value](macfx::ShaderResult){readyMetal4Frame(state,value);});
    macfx::ownPresentationBuffer(effects);
    claimNativePresentation(drawable);
    [producerQueue signalEvent:state->producer value:value];
    [producerQueue waitForEvent:state->finished value:value];
    forward(object,selector,drawable);
    if(!waiting){pending->ready=true;dispatch_async(state->recordingQueue,^{readyMetal4Frame(state,value);});}
}
API_AVAILABLE(macos(26.0))
void addMetal4Feedback(id object,SEL selector,MTL4CommitFeedbackHandler handler) {
    using Add=void(*)(id,SEL,MTL4CommitFeedbackHandler);
    reinterpret_cast<Add>(original(object,selector))(object,selector,macfx::metal4TimingHandler(handler));
}
API_AVAILABLE(macos(26.0))
void hookMetal4Feedback() {
    replace(MTL4CommitOptions.class,@selector(addFeedbackHandler:),reinterpret_cast<IMP>(addMetal4Feedback));
}
API_AVAILABLE(macos(26.0))
void commitMetal4(id object,SEL selector,const id<MTL4CommandBuffer> *buffers,NSUInteger count) {
    if(macfx::timingEnabled()) {
        auto options=[MTL4CommitOptions new];
        using Add=void(*)(id,SEL,MTL4CommitFeedbackHandler);
        reinterpret_cast<Add>(original(options,@selector(addFeedbackHandler:)))(options,@selector(addFeedbackHandler:),macfx::metal4TimingHandler(nil));
        [(id<MTL4CommandQueue>)object commit:buffers count:count options:options];
        return;
    }
    using Commit=void(*)(id,SEL,const id<MTL4CommandBuffer>*,NSUInteger);
    reinterpret_cast<Commit>(original(object,selector))(object,selector,buffers,count);
}
API_AVAILABLE(macos(26.0))
void hookMetal4Queue(id<MTL4CommandQueue> queue) {
    if(queue) {
        Class cls=object_getClass(queue);
        replace(cls,@selector(signalDrawable:),reinterpret_cast<IMP>(signalMetal4Drawable));
        if(macfx::timingEnabled()) {
            hookMetal4Feedback();
            replace(cls,@selector(commit:count:),reinterpret_cast<IMP>(commitMetal4));
        }
    }
}
typedef id (*RetainedFactory)(id,SEL) __attribute__((ns_returns_retained));
typedef id (*RetainedDescriptorFactory)(id,SEL,id,NSError **) __attribute__((ns_returns_retained));
API_AVAILABLE(macos(26.0)) __attribute__((ns_returns_retained))
id newMetal4Queue(id object,SEL selector) {
    id queue=reinterpret_cast<RetainedFactory>(original(object,selector))(object,selector);
    hookMetal4Queue(queue);return queue;
}
API_AVAILABLE(macos(26.0)) __attribute__((ns_returns_retained))
id newMetal4QueueDescriptor(id object,SEL selector,id descriptor,NSError **error) {
    id queue=reinterpret_cast<RetainedDescriptorFactory>(original(object,selector))(object,selector,descriptor,error);
    hookMetal4Queue(queue);return queue;
}

char resolutionKey;
RSMLayerResolution *resolutionState(CAMetalLayer *layer) {
    auto state=(RSMLayerResolution*)objc_getAssociatedObject(layer,&resolutionKey);
    if(state)return state;
    @synchronized(layer){
        state=(RSMLayerResolution*)objc_getAssociatedObject(layer,&resolutionKey);
        if(!state){state=[RSMLayerResolution new];objc_setAssociatedObject(layer,&resolutionKey,state,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}
    }
    return state;
}
void sizeForResolution(CAMetalLayer *layer,CGSize requested,bool publisher) {
    bool resolution=false;
    try {resolution=macfx::drawableResolutionRequested();}catch(const std::exception&e){static std::atomic<bool>warned{false};if(!warned.exchange(true))log(e.what());}
    if(!resolution&&!publisher)return;
    const SEL selector=@selector(setDrawableSize:);
    auto forward=reinterpret_cast<void(*)(id,SEL,CGSize)>(original(layer,selector));
    if(!resolution||macfx::ownsPresentation(layer)){if(publisher)forward(layer,selector,requested);return;}
    auto presentation=macfx::metalPresentation(layer);
    const CGSize output=presentation&&!presentation->snapshot().stopped?presentation->outputSize():CGSizeZero;
    auto state=resolutionState(layer);std::lock_guard<std::mutex>guard(state->lock);
    if(publisher){state->publisherSize=requested;state->recorded=true;}
    else if(!state->recorded){state->publisherSize=layer.drawableSize;state->recorded=true;}
    const auto desired=macfx::renderSourceSize(output.width,output.height,state->publisherSize.width,state->publisherSize.height);
    const CGSize target=CGSizeMake(desired.width,desired.height);
    if(publisher||!CGSizeEqualToSize(layer.drawableSize,target))forward(layer,selector,target);
}
void setDrawableSize(id object,SEL selector,CGSize size) {
    if(explicitHost()){reinterpret_cast<void(*)(id,SEL,CGSize)>(original(object,selector))(object,selector,size);return;}
    (void)selector;sizeForResolution((CAMetalLayer*)object,size,true);
}
// A game drawable request that returns nil, or waits at least 500 ms, while
// graphics processing is active. An engine can stop presenting after it (Godot
// 4 loses a swapchain slot on each nil drawable) and then never enters these
// hooks again; a minimized or occluded window can stall and later resume. A
// stall that no prompt request clears within a second is reported each second
// as the current plan revision, Prepared without accepted resources, on a
// context of its own (the layer address with its low bit set). That row neither
// fails nor votes on acceptance; its reason explains a change that stays
// unconfirmed, which still applies when the game draws again. Each layer logs
// its first stall.
//
// The window of each such layer is also watched for occlusion. Its AppKit
// notification runs on the main thread and is recorded in diagnostics. Engines
// such as Godot 4 stop presenting while macOS reports their window hidden, and
// may still render frames that never present. While processing is active,
// every watched game window is hidden, there is no virtual output window and no
// game drawable request has succeeded promptly for a second, each hidden layer
// reports Hidden each second on the same context. Hidden withholds acceptance,
// so a change stays unconfirmed with its reason. The next prompt request clears
// the report. Without one the report lapses after the window is visible again.
struct GameDrawableStall {
    __weak CAMetalLayer *layer=nil;std::chrono::steady_clock::time_point since{};std::string reason;
    bool active=false,logged=false,watched=false,hidden=false,shown=false;id observer=nil;
};
struct GameDrawableStalls {
    std::mutex lock;std::map<uintptr_t,GameDrawableStall> layers;dispatch_source_t timer=nil;
    std::atomic<unsigned> active{0},hidden{0},shown{0};std::atomic<uintptr_t> watched{0};
    // The steady-clock time of the latest prompt game drawable request.
    std::atomic<int64_t> drawn{0};
};
GameDrawableStalls &gameDrawableStalls() {static auto *const value=new GameDrawableStalls;return *value;}
constexpr std::string_view hiddenGameWindowReason="The game window is hidden, so the game is not drawing; changes apply when it is visible again";
void reportGameDrawableStalls();
// Called with the lock held.
void ensureGameDrawableTimer(GameDrawableStalls &stalls) {
    if(stalls.timer)return;
    stalls.timer=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_global_queue(QOS_CLASS_UTILITY,0));
    dispatch_source_set_timer(stalls.timer,dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),NSEC_PER_SEC,100*NSEC_PER_MSEC);
    dispatch_source_set_event_handler(stalls.timer,^{reportGameDrawableStalls();});dispatch_resume(stalls.timer);
}
// Called with the lock held. Returns the observer to remove after unlocking.
id forgetGameDrawableLayer(GameDrawableStalls &stalls,GameDrawableStall &entry) {
    if(entry.active)stalls.active.fetch_sub(1,std::memory_order_relaxed);
    if(entry.hidden)stalls.hidden.fetch_sub(1,std::memory_order_relaxed);
    if(entry.shown)stalls.shown.fetch_sub(1,std::memory_order_relaxed);
    return entry.observer;
}
void observeGameDrawableStatus(uintptr_t context,macfx::RuntimeStatusPhase phase,std::string_view reason) {
    const auto plan=macfx::currentEffectPlan();if(!reason.empty()&&(!plan||plan->revision.empty()))return;
    macfx::RuntimeStatusEvent event;event.context=context;event.processing=true;event.phase=phase;event.reason=reason;
    if(plan)event.planRevision=plan->revision;
    const auto digest=macfx::presentationControlsDigest();event.controlsDigest=digest;macfx::observeRuntimeStatus(event);
}
void reportGameDrawableStalls() {
    auto &stalls=gameDrawableStalls();std::vector<std::tuple<uintptr_t,macfx::RuntimeStatusPhase,std::string>> due;std::vector<id> removed;
    const bool processing=macfx::imageProcessingRequested();
    {std::lock_guard<std::mutex> guard(stalls.lock);const auto now=std::chrono::steady_clock::now();
     const auto drawn=stalls.drawn.load(std::memory_order_relaxed);
     bool watched=false,hidden=true;
     for(auto at=stalls.layers.begin();at!=stalls.layers.end();){
         if(!at->second.layer){
             if(id observer=forgetGameDrawableLayer(stalls,at->second))removed.push_back(observer);
             if(stalls.watched.load(std::memory_order_relaxed)==at->first)stalls.watched.store(0,std::memory_order_relaxed);
             at=stalls.layers.erase(at);continue;
         }
         if(at->second.observer){watched=true;hidden&=at->second.hidden;}
         ++at;
     }
     hidden=hidden&&watched&&processing&&!macfx::virtualWindowEnabled()&&now.time_since_epoch().count()-drawn>=std::chrono::steady_clock::duration(std::chrono::seconds(1)).count();
     for(auto &[key,entry]:stalls.layers){
         if(hidden&&entry.hidden){
             if(!entry.shown){entry.shown=true;stalls.shown.fetch_add(1,std::memory_order_relaxed);}
             due.emplace_back(key|1,macfx::RuntimeStatusPhase::Hidden,std::string(hiddenGameWindowReason));
         }else if(entry.shown&&!processing){
             entry.shown=false;stalls.shown.fetch_sub(1,std::memory_order_relaxed);due.emplace_back(key|1,macfx::RuntimeStatusPhase::Prepared,std::string());
         }else if(processing&&entry.active&&now-entry.since>=std::chrono::seconds(1))due.emplace_back(key|1,macfx::RuntimeStatusPhase::Prepared,entry.reason);
     }
     if(!stalls.active.load(std::memory_order_relaxed)&&!stalls.hidden.load(std::memory_order_relaxed)&&!stalls.shown.load(std::memory_order_relaxed)&&stalls.timer){
         dispatch_source_cancel(stalls.timer);stalls.timer=nil;
     }}
    for(id observer:removed)[NSNotificationCenter.defaultCenter removeObserver:observer];
    for(const auto &[context,phase,reason]:due)observeGameDrawableStatus(context,phase,reason);
}
// Main thread: the initial read, then each window notification. Diagnostics
// record the initial state and every change.
void setGameWindowHidden(uintptr_t key,NSWindow *window,bool initial=false) {
    const bool hidden=!(window.occlusionState&NSWindowOcclusionStateVisible);
    auto &stalls=gameDrawableStalls();
    {std::lock_guard<std::mutex> guard(stalls.lock);const auto found=stalls.layers.find(key);
     if(found==stalls.layers.end()||!found->second.observer||!initial&&found->second.hidden==hidden)return;
     if(found->second.hidden!=hidden){
         found->second.hidden=hidden;
         if(hidden){stalls.hidden.fetch_add(1,std::memory_order_relaxed);ensureGameDrawableTimer(stalls);}
         else stalls.hidden.fetch_sub(1,std::memory_order_relaxed);
     }}
    const auto size=window.frame.size;
    macfx::diagnosticEvent(macfx::DiagnosticStage::WindowSelected,uintptr_t(window.windowNumber),unsigned(size.width),unsigned(size.height),
        hidden?"window-hidden":"window-visible");
}
// Main thread. A layer can request drawables before it joins a window; the
// lookup is retried each second a few times.
void watchGameWindow(uintptr_t key,unsigned attempt) {
    auto &stalls=gameDrawableStalls();CAMetalLayer *layer=nil;
    {std::lock_guard<std::mutex> guard(stalls.lock);const auto found=stalls.layers.find(key);
     if(found==stalls.layers.end()||found->second.observer)return;layer=found->second.layer;}
    if(!layer)return;
    NSWindow *window=nil;
    for(CALayer *at=layer;at&&!window;at=at.superlayer)if([at.delegate isKindOfClass:NSView.class])window=((NSView*)at.delegate).window;
    if(!window){
        if(attempt<5)dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),dispatch_get_main_queue(),^{watchGameWindow(key,attempt+1);});
        return;
    }
    __weak NSWindow *watched=window;
    id observer=[NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidChangeOcclusionStateNotification object:window queue:nil
        usingBlock:^(NSNotification*){if(NSWindow *current=watched)setGameWindowHidden(key,current);}];
    {std::lock_guard<std::mutex> guard(stalls.lock);const auto found=stalls.layers.find(key);
     if(found==stalls.layers.end()||found->second.observer){[NSNotificationCenter.defaultCenter removeObserver:observer];return;}
     found->second.observer=observer;}
    setGameWindowHidden(key,window,true);
}
// Render thread, when the requesting layer differs from the previous one.
// Entries of layers that no longer exist, including an earlier layer at the
// same address, are swept here as well as by the timer.
void watchGameDrawableLayer(CAMetalLayer *layer,uintptr_t key) {
    auto &stalls=gameDrawableStalls();std::vector<id> removed;bool watch=false;
    {std::lock_guard<std::mutex> guard(stalls.lock);
     if(const auto found=stalls.layers.find(key);found!=stalls.layers.end()&&found->second.watched&&found->second.layer==layer){
         stalls.watched.store(key,std::memory_order_relaxed);return;
     }
     for(auto at=stalls.layers.begin();at!=stalls.layers.end();){
         if(at->second.layer!=layer&&(!at->second.layer||at->first==key)){
             if(id observer=forgetGameDrawableLayer(stalls,at->second))removed.push_back(observer);
             at=stalls.layers.erase(at);
         }else ++at;
     }
     auto &entry=stalls.layers[key];entry.layer=layer;watch=!entry.watched;entry.watched=true;
     stalls.watched.store(key,std::memory_order_relaxed);}
    for(id observer:removed)[NSNotificationCenter.defaultCenter removeObserver:observer];
    if(watch)dispatch_async(dispatch_get_main_queue(),^{watchGameWindow(key,0);});
}
void observeGameDrawable(CAMetalLayer *layer,bool acquired,double milliseconds,bool processing,std::chrono::steady_clock::time_point ended) {
    auto &stalls=gameDrawableStalls();const auto key=reinterpret_cast<uintptr_t>((__bridge void*)layer);
    if(key!=stalls.watched.load(std::memory_order_relaxed))watchGameDrawableLayer(layer,key);
    const bool prompt=acquired&&milliseconds<500;
    if(prompt)stalls.drawn.store(ended.time_since_epoch().count(),std::memory_order_relaxed);
    if(!processing||prompt){
        if(!stalls.active.load(std::memory_order_relaxed)&&!stalls.shown.load(std::memory_order_relaxed))return;
        bool clear=false;
        {std::lock_guard<std::mutex> guard(stalls.lock);
         if(const auto found=stalls.layers.find(key);found!=stalls.layers.end()){
             if(found->second.active){found->second.active=false;stalls.active.fetch_sub(1,std::memory_order_relaxed);}
             if(prompt&&found->second.shown){found->second.shown=false;stalls.shown.fetch_sub(1,std::memory_order_relaxed);clear=true;}
         }}
        if(clear)observeGameDrawableStatus(key|1,macfx::RuntimeStatusPhase::Prepared,{});
        return;
    }
    const auto waited=std::to_string(std::lround(milliseconds));
    std::string reason=std::string("The game stopped drawing after macOS ")+(acquired?"delayed a display image by ":"returned no display image after ")+waited+" ms; changes apply if it draws again";
    bool first=false;
    {std::lock_guard<std::mutex> guard(stalls.lock);
     auto &stall=stalls.layers[key];stall.layer=layer;stall.reason=std::move(reason);first=!stall.logged;stall.logged=true;
     if(!stall.active){stall.active=true;stall.since=std::chrono::steady_clock::now();stalls.active.fetch_add(1,std::memory_order_relaxed);}
     ensureGameDrawableTimer(stalls);}
    if(first)log("Game drawable request on layer "+std::to_string(key)+(acquired?" waited ":" returned nil after ")+waited+
        " ms during graphics processing; edits report this until a later request succeeds within 500 ms");
}
void installMetalDeviceHooks(id<MTLDevice> device);
id<CAMetalDrawable> nextDrawable(id object,SEL selector) {
    if(macfx::ownsPresentation(object)||(explicitHost()&&!nativeLayer(object))) return reinterpret_cast<id<CAMetalDrawable>(*)(id,SEL)>(original(object,selector))(object,selector);
    if(!macfx::effectRequested())if(auto history=nativeHistory(object,false))history->images.reset();
    const auto activePresentation=macfx::metalPresentation((CAMetalLayer*)object);
    const bool readsSource=activePresentation&&!activePresentation->snapshot().stopped;
    bool source=false;try{source=macfx::drawableResolutionRequested();}catch(...){}
    if(!nativeLayer(object)&&!macfx::imageProcessingRequested(readsSource)&&!source&&!macfx::virtualWindowEnabled()&&!macfx::timingEnabled()&&!macfx::FrameCapture::configured())
        return reinterpret_cast<id<CAMetalDrawable>(*)(id,SEL)>(original(object,selector))(object,selector);
    installMetalDeviceHooks(((CAMetalLayer*)object).device);
    if(!explicitHost())macfx::acceptsLayer(object);
    // A cooperating publisher may opt in to a reduced drawable. Other engines
    // retain their own final allocation and resize through their renderer API.
    if(!explicitHost())sizeForResolution((CAMetalLayer*)object,CGSizeZero,false);
    // The attachment-fetch adapter preserves the producer's framebuffer-only
    // contract (which SpriteKit uses for its Y convention) for its supported
    // layer formats. Other cases need a sampleable drawable.
    CAMetalLayer *layer=(CAMetalLayer*)object;
    if(nativeLayer(object)||(macfx::imageProcessingRequested(readsSource)&&
       !macfx::nativeMetalSourceReadable(layer.pixelFormat,layer.framebufferOnly,
           macfx::framebuffer::supported(layer.device))))[layer setFramebufferOnly:NO];
    id<CAMetalDrawable> drawable;const auto requested=layer.drawableSize;const auto began=std::chrono::steady_clock::now();
    {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalDrawable,reinterpret_cast<uintptr_t>((__bridge void*)layer),unsigned(requested.width),unsigned(requested.height),"game.next-drawable");
     drawable=reinterpret_cast<id<CAMetalDrawable>(*)(id,SEL)>(original(object,selector))(object,selector);}
    const auto ended=std::chrono::steady_clock::now();
    observeGameDrawable(layer,drawable!=nil,std::chrono::duration<double,std::milli>(ended-began).count(),macfx::imageProcessingRequested(readsSource),ended);
    if(drawable) {
        macfx::registerTemporalDrawable(drawable);
        if(macfx::effectRequested())try {
            const bool required=macfx::frameRequiresDepth((__bridge void*)object,drawable.texture.device,drawable.texture.width,drawable.texture.height);
            macfx::setColorDepthDemand(drawable.texture,required);
            if(required)captureDepth.store(true,std::memory_order_relaxed);
        }catch(const std::exception &error){log("Cannot inspect selected Metal effect: "+std::string(error.what()));}
        objc_setAssociatedObject(drawable,&nativePresentationKey,nil,OBJC_ASSOCIATION_RETAIN);
        Class cls=object_getClass(drawable);
        replace(cls,@selector(present),reinterpret_cast<IMP>(drawablePresent));
        replace(cls,@selector(presentAtTime:),reinterpret_cast<IMP>(drawablePresentTime));
        replace(cls,@selector(presentAfterMinimumDuration:),reinterpret_cast<IMP>(drawablePresentTime));
    }
    return drawable;
}
void replace(Class cls,SEL selector,IMP hook) { hooks().replace(cls,selector,hook); }
void installMetalDeviceHooks(id<MTLDevice> device) {
    static std::atomic<bool> installed{false};static std::mutex installing;
    if(!device||installed.load(std::memory_order_acquire))return;
    std::lock_guard<std::mutex> lock(installing);if(installed.load())return;
    // Device allocation belongs after the application creates its renderer.
    // In particular, Wine must reserve its Windows address space before Metal
    // allocates GPU mappings. The layer hook runs before the first presentation.
    id<MTLCommandQueue> queue=[device newCommandQueue];id<MTLCommandBuffer> buffer=[queue commandBuffer];
    if(!buffer) { log("Metal is unavailable"); return; }
    Class cls=object_getClass(buffer);
    replace(cls,@selector(presentDrawable:),reinterpret_cast<IMP>(present));
    replace(cls,@selector(presentDrawable:atTime:),reinterpret_cast<IMP>(presentTime));
    replace(cls,@selector(presentDrawable:afterMinimumDuration:),reinterpret_cast<IMP>(presentTime));
    replace(cls,@selector(commit),reinterpret_cast<IMP>(commit));
    replace(cls,@selector(addScheduledHandler:),reinterpret_cast<IMP>(addScheduled));
    replace(cls,@selector(renderCommandEncoderWithDescriptor:),reinterpret_cast<IMP>(captureRenderPass));
    macfx::installSceneCopyBoundaryHooks(buffer);
    if(@available(macOS 26.0,*)) {
        Class deviceClass=object_getClass(device);
        replace(deviceClass,@selector(newMTL4CommandQueue),reinterpret_cast<IMP>(newMetal4Queue));
        replace(deviceClass,@selector(newMTL4CommandQueueWithDescriptor:error:),reinterpret_cast<IMP>(newMetal4QueueDescriptor));
        hookMetal4Queue([device newMTL4CommandQueue]);
        log("Metal 4 queue presentation hooks installed");
    }
    installed.store(true,std::memory_order_release);
    log("Metal presentation hooks installed: "+std::string(object_getClassName(buffer))+" device="+device.name.UTF8String);
}
}
void macfx::writeCapturedFrame(const std::string &file,const void *bytes,unsigned width,unsigned height,bool bgra,bool flip,unsigned stride){savePNG(file,bytes,width,height,bgra,flip,stride);}
__attribute__((constructor)) static void loadMetal() { @autoreleasepool {
    if(explicitHost()) return;
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::Hooks,1);
    if(!macfx::liveEffects() && !macfx::effectRequested() && !macfx::timingEnabled() && !macfx::graphicsRequested() && !macfx::FrameCapture::configured()) return;
    if(@available(macOS 26.0,*))if(macfx::timingEnabled())hookMetal4Feedback();
    try { if(macfx::effectRequested())prepareLaunchEffect(); }
    catch(const std::exception &error) { log("Effect preload failed: "+std::string(error.what())); return; }
    Class layer=(Class)objc_getClass("CAMetalLayer");
    replace(layer,@selector(nextDrawable),reinterpret_cast<IMP>(nextDrawable));
    replace(layer,@selector(setDrawableSize:),reinterpret_cast<IMP>(setDrawableSize));
}}
extern "C" int rsRegisterNativeMetalLayer(void *value,RSNativeMetalFrame frame,void *context) { @autoreleasepool {
    id layer=(__bridge id)value;
    if(!layer||![layer isKindOfClass:CAMetalLayer.class]||!frame)return 0;
    RSMNativeLayer *previous;
    @synchronized(layer) {
        previous=nativeLayer(layer);
        if(previous&&previous->frame==frame&&previous->context==context)return 1;
        auto registration=[RSMNativeLayer new];registration->frame=frame;registration->context=context;
        objc_setAssociatedObject(layer,&nativeLayerKey,registration,OBJC_ASSOCIATION_RETAIN);
    }
    retireNativeLayer(previous);
    replace(CAMetalLayer.class,@selector(nextDrawable),reinterpret_cast<IMP>(nextDrawable));
    replace(CAMetalLayer.class,@selector(setDrawableSize:),reinterpret_cast<IMP>(setDrawableSize));
    installMetalDeviceHooks(((CAMetalLayer*)layer).device);
    return 1;
}}
extern "C" void *rsRetainNativeMetalSource(void *commands,void *texture){
    auto source=(__bridge id<CAMetalDrawable>)retainedNativeSource;
    if(!source||retainedNativeCommands!=commands||source.texture!=(__bridge id<MTLTexture>)texture)return nullptr;
    return (__bridge_retained void*)source;
}
extern "C" void rsReleaseNativeMetalSource(void *lease){if(lease){id owner=(__bridge_transfer id)lease;(void)owner;}}
extern "C" void rsUnregisterNativeMetalLayer(void *value) { @autoreleasepool {
    if(!value)return;
    id layer=(__bridge id)value;RSMNativeLayer *previous;
    @synchronized(layer) {previous=nativeLayer(layer);objc_setAssociatedObject(layer,&nativeLayerKey,nil,OBJC_ASSOCIATION_RETAIN);}
    retireNativeLayer(previous);
}}
extern "C" bool rsProcessRGBA(void *context,unsigned char *bytes,unsigned width,unsigned height) { @autoreleasepool {
    static id<MTLDevice> device=MTLCreateSystemDefaultDevice();
    static id<MTLCommandQueue> queue=[device newCommandQueue];
    std::lock_guard<std::mutex> guard(bridgeMutex());
    auto &runtime=bridgeRuntimes()[context];runtime.statusContext=reinterpret_cast<uintptr_t>(context);runtime.captureFlipY=true;
    if(!queue)return false;
    if(runtime.failed){if(runtime.automaticFailure.blocks(device,width,height,MTLPixelFormatRGBA8Unorm))return false;runtime.failed=false;runtime.w=runtime.h=runtime.compiledWidth=runtime.compiledHeight=0;runtime.rgbaCommands=nil;runtime.rgbaImage=nil;runtime.rgbaCompleted=nil;}
    const auto replay=[&]{
        auto image=runtime.rgbaCompleted;if(!image||image.width!=width||image.height!=height)return false;
        [image getBytes:bytes bytesPerRow:width*4 fromRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0];return true;
    };
    try {
        // One pending compatibility job owns its image until actual completion.
        // A short wait never permits reuse or rejects the graphics request.
        if(runtime.rgbaCommands&&runtime.rgbaCommands.status<MTLCommandBufferStatusCompleted)return replay();
        if(runtime.rgbaCommands.status==MTLCommandBufferStatusError)throw std::runtime_error(runtime.rgbaCommands.error.localizedDescription.UTF8String?:"Metal GPU error");
        id<MTLTexture> image=runtime.rgbaImage;
        if(!image||image==runtime.rgbaCompleted||image.width!=width||image.height!=height){
            auto *descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:width height:height mipmapped:NO];
            descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;
            descriptor.storageMode=MTLStorageModeShared;
            image=[device newTextureWithDescriptor:descriptor];
        }
        if(!image)throw std::runtime_error("Cannot allocate an RGBA compatibility image");
        [image replaceRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0 withBytes:bytes bytesPerRow:width*4];
        auto buffer=[queue commandBuffer];if(!buffer)throw std::runtime_error("Cannot allocate RGBA compatibility commands");runtime.render(buffer,image);
        macfx::observeTiming(buffer,"probe-effects",width,height);
        macfx::CommandDeadline completed(buffer,macfx::CommandDeadline::Milestone::Completed);
        runtime.rgbaImage=image;runtime.rgbaCommands=buffer;
        [buffer commit];if(!completed.wait()){
            if(buffer.status==MTLCommandBufferStatusError)throw std::runtime_error(buffer.error.localizedDescription.UTF8String?:"Metal GPU error");
            return replay();
        }
        if(buffer.status!=MTLCommandBufferStatusCompleted) throw std::runtime_error(buffer.error.localizedDescription.UTF8String?:"Metal GPU error");
        auto previous=runtime.rgbaCompleted;runtime.rgbaCompleted=image;runtime.rgbaImage=previous?:image;
        [image getBytes:bytes bytesPerRow:width*4 fromRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0];
        return true;
    } catch(const SpatialBusy &) { return replay(); }
      catch(const std::exception &error) { runtime.failed=true;runtime.automaticFailure.reject(device,width,height,MTLPixelFormatRGBA8Unorm);log("OpenGL to Metal effect disabled for the current graphics and source contract: "+std::string(error.what())); return false; }
}}
void macfx::waitWindowSurfaceProducer(void *owner) {
    id<MTLCommandBuffer> previous;{std::lock_guard<std::mutex> guard(queueMutex());previous=lastGameBuffer();}
    // Optional compatibility capture never waits on a producer that may need
    // this same game thread to submit or retire its work.
    if(previous.status>=MTLCommandBufferStatusCommitted&&previous.status<MTLCommandBufferStatusCompleted)
        throw macfx::borrowed::Busy();
    if(previous.status==MTLCommandBufferStatusError)throw std::runtime_error("The window surface producer failed on the GPU");
    (void)owner;
}

enum class SurfaceSource { Window, CompletedOpenGL };
static IOSurfaceRef filterSurface(void *owner,IOSurfaceRef surface,const char *timingScope,SurfaceSource sourceKind) { @autoreleasepool {
    if(sourceKind==SurfaceSource::Window)try{macfx::waitWindowSurfaceProducer(owner);}catch(const std::exception&){return nullptr;}
    static id<MTLDevice> device=MTLCreateSystemDefaultDevice();
    static id<MTLCommandQueue> queue=[device newCommandQueue];
    if(!queue) return nullptr;
    MTLPixelFormat pixelFormat=IOSurfaceGetPixelFormat(surface)=='BGRA'?MTLPixelFormatBGRA8Unorm:
        IOSurfaceGetPixelFormat(surface)=='RGBA'?MTLPixelFormatRGBA8Unorm:MTLPixelFormatInvalid;
    if(pixelFormat==MTLPixelFormatInvalid) return nullptr;
    auto *descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:pixelFormat width:IOSurfaceGetWidth(surface) height:IOSurfaceGetHeight(surface) mipmapped:NO];
    descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;
    auto source=[device newTextureWithDescriptor:descriptor iosurface:surface plane:0];
    if(!source) return nullptr;
    // The OpenGL bridge completes its source blit with glFinish before this
    // call. Waiting on an unrelated process-wide Metal submission adds a false
    // dependency and can block the thread responsible for releasing that work.
    // Window surfaces retain their existing pending-producer synchronization.

    std::unique_lock<std::mutex> guard(mutex(),std::defer_lock);
    {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalRuntimeLock,reinterpret_cast<uintptr_t>(owner));guard.lock();}
    auto &runtime=runtimes()[owner];runtime.statusContext=reinterpret_cast<uintptr_t>(owner);
    auto &pool=surfacePools()[owner];
    if(runtime.failed){if(runtime.automaticFailure.blocks(source))return nullptr;runtime.failed=false;runtime.w=runtime.h=runtime.compiledWidth=runtime.compiledHeight=0;pool.clear();}
    if(pool.w!=source.width || pool.h!=source.height || pool.format!=IOSurfaceGetPixelFormat(surface)) {
        pool.clear();pool.w=source.width;pool.h=source.height;pool.format=IOSurfaceGetPixelFormat(surface);
    }
    try {
    // Timed-out work stays leased but is never promoted on a later source call.
    // Only a positively completed wait can replace the retained output.
    if(pool.pending){
        if(pool.pending.status<MTLCommandBufferStatusCompleted)return pool.completed?(IOSurfaceRef)CFRetain(pool.completed):nullptr;
        if(pool.pending.status==MTLCommandBufferStatusError){runtime.failed=true;runtime.automaticFailure.reject(source);log("Window surface GPU processing failed");return nullptr;}
        pool.pending=nil;
    }
    IOSurfaceRef output=nullptr;
    if(pool.surfaces.size()>=3) {
        for(unsigned i=0;i<pool.surfaces.size();++i) {
            unsigned index=(pool.cursor+i)%pool.surfaces.size();
            if(pool.surfaces[index]!=pool.completed&&!IOSurfaceIsInUse(pool.surfaces[index])) {output=pool.surfaces[index];pool.cursor=(index+1)%pool.surfaces.size();break;}
        }
    }
    if(!output) {
        if(pool.surfaces.size()>=8) {log("Window display surfaces are still in use");return nullptr;}
        pool.surfaces.reserve(8);pool.reservations.reserve(8);
        const auto row=IOSurfaceAlignProperty(kIOSurfaceBytesPerRow,size_t(pool.w)*4);
        const auto bytes=IOSurfaceAlignProperty(kIOSurfaceAllocSize,row*pool.h);
        auto reservation=macfx::reserveImageBytes(device,bytes,reinterpret_cast<uintptr_t>(owner),"surface-output-memory",true);
        NSDictionary *properties=@{(__bridge NSString*)kIOSurfaceWidth:@(pool.w),(__bridge NSString*)kIOSurfaceHeight:@(pool.h),
            (__bridge NSString*)kIOSurfaceBytesPerElement:@4,(__bridge NSString*)kIOSurfaceBytesPerRow:@(IOSurfaceAlignProperty(kIOSurfaceBytesPerRow,pool.w*4)),
            (__bridge NSString*)kIOSurfacePixelFormat:@(pool.format)};
        output=IOSurfaceCreate((__bridge CFDictionaryRef)properties);
        if(!output) return nullptr;
        try{reservation->commit(IOSurfaceGetAllocSize(output));}catch(...){CFRelease(output);throw;}
        pool.surfaces.push_back(output);pool.reservations.push_back(std::move(reservation));pool.cursor=0;
    }
    auto target=[device newTextureWithDescriptor:descriptor iosurface:output plane:0];
    if(!target) return nullptr;
    const auto index=std::find(pool.surfaces.begin(),pool.surfaces.end(),output)-pool.surfaces.begin();
    macfx::attachImageReservation(target,pool.reservations[index]);
    struct Encoding {Encoding(){encodingEffects=true;}~Encoding(){encodingEffects=false;}} encoding;
    try {
        id<MTLCommandBuffer> buffer;
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalQueue);buffer=[queue commandBuffer];}
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalEncode,reinterpret_cast<uintptr_t>(owner),pool.w,pool.h);runtime.render(buffer,source,target);}
        macfx::observeTiming(buffer,timingScope,pool.w,pool.h);
        auto sourceLease=std::shared_ptr<const void>(CFRetain(surface),[](const void*value){CFRelease(value);});
        auto outputLease=std::shared_ptr<const void>(CFRetain(output),[](const void*value){CFRelease(value);});
        const auto imageLease=pool.reservations[index];
        [buffer addCompletedHandler:^(id<MTLCommandBuffer>){(void)sourceLease;(void)outputLease;(void)imageLease;}];
        macfx::CommandDeadline completed(buffer,macfx::CommandDeadline::Milestone::Completed);
        pool.pending=buffer;
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalCommit);[buffer commit];}
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalEffectWait,reinterpret_cast<uintptr_t>(owner),pool.w,pool.h);
         if(!completed.wait()){
             if(buffer.status==MTLCommandBufferStatusError)throw std::runtime_error(buffer.error.localizedDescription.UTF8String?:"Metal GPU error");
             return pool.completed?(IOSurfaceRef)CFRetain(pool.completed):nullptr;
         }}
        pool.pending=nil;pool.completed=output;
        return (IOSurfaceRef)CFRetain(output);
    } catch(const SpatialBusy &){return pool.completed?(IOSurfaceRef)CFRetain(pool.completed):nullptr;}
      catch(const macfx::ImageBudgetExceeded &){return pool.completed?(IOSurfaceRef)CFRetain(pool.completed):nullptr;}
      catch(const std::exception &error) { runtime.failed=true;runtime.automaticFailure.reject(source);log("Window surface effect disabled for the current graphics and source contract: "+std::string(error.what()));return nullptr; }
    }catch(const macfx::ImageBudgetExceeded&){return pool.completed?(IOSurfaceRef)CFRetain(pool.completed):nullptr;}
}}

extern "C" IOSurfaceRef rsFilterWindowSurface(void *owner,IOSurfaceRef surface) {
    return filterSurface(owner,surface,"surface-copy-and-effects",SurfaceSource::Window);
}
extern "C" IOSurfaceRef rsFilterOpenGLSurface(void *owner,IOSurfaceRef surface) {
    return filterSurface(owner,surface,"legacy-surface-copy-and-effects",SurfaceSource::CompletedOpenGL);
}

namespace macfx {static FrameResult processColorFrame(void*,id<MTLCommandBuffer>,const SpatialFrame&,SpatialMethod,const DepthFrame*,bool,const FrameEncodingInputs*,FrameEncodingReceipt*,ImageColorSpace,const ImageColorDescription*);}
macfx::FrameResult macfx::processColorFrame(void *owner,id<MTLCommandBuffer> commands,const SpatialFrame &frame,SpatialMethod method,const DepthFrame *depth,bool opaqueDisplay,const FrameEncodingInputs*strict,FrameEncodingReceipt*receipt,ImageColorSpace colorSpace,const ImageColorDescription*colorDescription) { @autoreleasepool {
    FrameResult result;
    if(receipt)*receipt={};
    if(!owner || !commands || !frame.source || !frame.output) {result.reason="Missing frame owner, command buffer or image";return result;}
    if(commands.status>=MTLCommandBufferStatusCommitted) {result.reason="Command buffer is already submitted";return result;}
    if(!commands.retainedReferences) {result.reason="Frame processing requires a command buffer that retains resources";return result;}
    if(frame.source.framebufferOnly || frame.output.framebufferOnly) {result.reason="Frame images must support access outside render passes";return result;}
    if(frame.source.device!=commands.device || frame.output.device!=commands.device) {result.reason="Frame images must use the command buffer device";return result;}
    if(frame.source.textureType!=MTLTextureType2D || frame.output.textureType!=MTLTextureType2D || frame.source.sampleCount!=1 || frame.output.sampleCount!=1) {result.reason="Frame processing requires resolved 2D images";return result;}
    if(strict&&strict->refreshControls)refreshLiveState();
    LiveStatePin pinned(strict||receipt);
    const auto generation=receipt||strict?liveState().generation:0;
    const auto digest=receipt||strict?presentationControlsDigest():std::string{};
    if(strict&&(!strict->plan||strict->plan->mode!="simple"||!liveEffects()||digest.empty()||digest!=strict->controlsDigest)){
        result.reason="The accepted frame inputs do not match the held graphics publication";return result;
    }
    std::lock_guard<std::mutex> guard(mutex());auto &runtime=runtimes()[owner];runtime.statusContext=reinterpret_cast<uintptr_t>(owner);
    result.effects=strict?bool(livePacket()&&(livePacket()->flags&8)):macfx::effectRequested();
    result.scaled=frame.source.width!=frame.output.width || frame.source.height!=frame.output.height || frame.source.pixelFormat!=frame.output.pixelFormat;
    @try { try {
        if(depth)validateDepth(*depth,frame.source,frame.frameId,frame.origin);
        if(result.effects) {runtime.render(commands,frame.source,frame.output,method,frame.frameId,frame.color,frame.origin,depth,nullptr,opaqueDisplay,strict,receipt,colorSpace,colorDescription);if(result.scaled)result.scaling=runtime.lastScaling;}
        else if(result.scaled) {result.scaling=runtime.scale(commands,frame,method);if(!result.scaling.encoded){result.busy=result.scaling.busy;result.reason=result.scaling.reason;return result;}}
        else if(frame.source!=frame.output) {auto copy=[commands blitCommandEncoder];[copy copyFromTexture:frame.source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(frame.source.width,frame.source.height,1) toTexture:frame.output destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];}
        if(receipt){
            if(strict&&!result.effects)receipt->planRevision=strict->plan->revision;
            if(liveState().generation!=generation||presentationControlsDigest()!=digest){
                if(strict)throw HeldInputMismatch("Frame controls changed while encoding the held output");
                *receipt={};
            }else {receipt->controlsGeneration=generation;receipt->controlsDigest=digest;}
        }
        result.encoded=true;
        if(!result.effects&&!strict)macfx::observeBypassedPlan(runtime.statusContext);
    } catch(const SpatialBusy &error) {result.busy=true;result.scaling=runtime.lastScaling;result.reason=error.what();}
    catch(const ImageBudgetExceeded &error) {result.busy=true;result.reason=error.what();}
    catch(const HeldInputMismatch &error) {result.reason=error.what();}
    catch(const PlacementUnavailable &error) {result.reason=error.what();}
    catch(const std::exception &error) {runtime.w=runtime.h=0;result.reason=error.what();} }
    @catch(NSException *error) {runtime.w=runtime.h=0;result.reason=error.reason.UTF8String?:"Frame processing failed";}
    if(!result.encoded&&receipt)*receipt={};return result;
}}
macfx::FrameResult macfx::processFrameWithDepth(void *owner,id<MTLCommandBuffer>commands,const SpatialFrame&frame,SpatialMethod method,const DepthFrame*depth,bool opaque,const FrameEncodingInputs*strict,FrameEncodingReceipt*receipt){return processColorFrame(owner,commands,frame,method,depth,opaque,strict,receipt,ImageColorSpace::LegacySDR,nullptr);}
macfx::FrameResult macfx::processFrameWithDepth(void *owner,id<MTLCommandBuffer> commands,const SpatialFrame &frame,SpatialMethod method,const DepthFrame *depth,bool opaqueDisplay){
    return processFrameWithDepth(owner,commands,frame,method,depth,opaqueDisplay,nullptr,nullptr);
}
macfx::FrameResult macfx::processFrameWithDepth(void *owner,id<MTLCommandBuffer> commands,const SpatialFrame &frame,SpatialMethod method,const DepthFrame *depth,bool opaqueDisplay,const FrameEncodingInputs&strict,FrameEncodingReceipt&receipt){
    return processFrameWithDepth(owner,commands,frame,method,depth,opaqueDisplay,&strict,&receipt);
}
macfx::FrameResult macfx::processFrameWithDepth(void *owner,id<MTLCommandBuffer> commands,const SpatialFrame &frame,SpatialMethod method,const DepthFrame *depth) {
    return processFrameWithDepth(owner,commands,frame,method,depth,true);
}

namespace macfx {
namespace {
class ShaderRuntimeNode final : public ShaderNode {
    struct HistorySlot {Runtime runtime;};
    struct HistoryFlight {
        std::shared_ptr<HistorySlot>slot,baseline;
        GPUCompletionFence fence;
        ShaderHistoryInput input;uint64_t sequence=0,generation=0;
        double time=0;float frameTime=0;
        std::atomic<bool>success{false},cancelled{false};bool real=false;__weak id<MTLCommandBuffer>commands=nil;
    };
    struct State {
        Runtime runtime;std::mutex lock;
        bool realHistory=false;uint64_t generation=0,sequence=0;
        std::vector<std::shared_ptr<HistorySlot>>pool;
        std::shared_ptr<HistorySlot>accepted,baseline;
        std::shared_ptr<HistoryFlight>pending,lastFlight;
        ShaderHistoryInput acceptedInput,contract;double acceptedTime=0;float acceptedFrameTime=0;
    };
    std::shared_ptr<State> state=std::make_shared<State>();
    ShaderSpec spec;std::mutex lock;const unsigned capacity=4;const bool realHistory=false;
    static id<MTLTexture>cloneImage(id<MTLTexture>source){if(!source)return nil;auto*d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:source.pixelFormat width:source.width height:source.height mipmapped:NO];d.mipmapLevelCount=source.mipmapLevelCount;d.usage=source.usage;d.storageMode=MTLStorageModePrivate;return newAdmittedTexture(source.device,d);}
    static void prepareHistory(State&state,unsigned capacity){
        auto&base=state.runtime;state.realHistory=true;
        if(base.needsDepth){NSError*error=nil;auto library=[base.workingDevice newLibraryWithSource:@"#include <metal_stdlib>\nusing namespace metal; kernel void copyDepth(depth2d<float,access::read> source [[texture(0)]],texture2d<float,access::write> target [[texture(1)]],uint2 p [[thread_position_in_grid]]){if(p.x<target.get_width()&&p.y<target.get_height())target.write(float4(source.read(p)),p);}" options:nil error:&error];if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare shader depth access");base.depthPipeline=[base.workingDevice newComputePipelineStateWithFunction:[library newFunctionWithName:@"copyDepth"] error:&error];if(!base.depthPipeline)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare shader depth access");auto*d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR32Float width:base.w height:base.h mipmapped:NO];d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;d.storageMode=MTLStorageModePrivate;base.depthCopy=newAdmittedTexture(base.workingDevice,d);}
        // Immutable code, pipelines, samplers and source assets are shared.
        // Each admitted command owns every mutable feedback and scratch image.
        for(unsigned n=0;n<capacity+2;++n){auto slot=std::make_shared<HistorySlot>();slot->runtime=base;auto&r=slot->runtime;
            if(n){for(unsigned i=0;i<2;++i)r.colors[i]=cloneImage(base.colors[i]);r.stencilTexture=cloneImage(base.stencilTexture);r.depthCopy=cloneImage(base.depthCopy);
                for(const auto&t:base.effect.module.textures)if(t.semantic.empty()&&!base.external(t.unique_name)&&textureSource(t).empty())r.textures[t.unique_name]=cloneImage(base.textures.at(t.unique_name));
                r.storages.clear();for(const auto&storage:base.effect.module.storages){auto image=r.textures.at(storage.texture_name);auto view=[image newTextureViewWithPixelFormat:image.pixelFormat textureType:MTLTextureType2D levels:NSMakeRange(storage.level,1) slices:NSMakeRange(0,1)];if(!view)throw std::runtime_error("Cannot prepare feedback storage views");r.storages.push_back(view);}
            }
            state.pool.push_back(std::move(slot));
        }
    }
    static void seed(id<MTLCommandBuffer>commands,Runtime&target,const Runtime*source){
        for(const auto&t:target.effect.module.textures){if(!t.semantic.empty()||target.external(t.unique_name)||!textureSource(t).empty())continue;auto image=target.textures.at(t.unique_name);
            for(unsigned level=0;level<image.mipmapLevelCount;++level){if(source){auto encoder=[commands blitCommandEncoder];if(!encoder)throw std::runtime_error("Cannot seed shader history");auto from=source->textures.at(t.unique_name);[encoder copyFromTexture:from sourceSlice:0 sourceLevel:level sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(std::max(NSUInteger(1),image.width>>level),std::max(NSUInteger(1),image.height>>level),1) toTexture:image destinationSlice:0 destinationLevel:level destinationOrigin:MTLOriginMake(0,0,0)];[encoder endEncoding];}
                else {auto*pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=image;pass.colorAttachments[0].level=level;pass.colorAttachments[0].loadAction=MTLLoadActionClear;pass.colorAttachments[0].clearColor=MTLClearColorMake(0,0,0,1);pass.colorAttachments[0].storeAction=MTLStoreActionStore;auto encoder=[commands renderCommandEncoderWithDescriptor:pass];if(!encoder)throw std::runtime_error("Cannot clear shader history");[encoder endEncoding];}}
            target.initializedTextures.insert(t.unique_name);
        }
        if(source){target.uniformSources=source->uniformSources;target.effect.uniforms=source->effect.uniforms;target.frames=source->frames;target.lastFrame=source->lastFrame;target.started=source->started;}
        target.appliedParameters=~uint64_t(0);
    }
    static void promote(State&state,const std::shared_ptr<HistoryFlight>&flight){
        if(!flight||flight->cancelled||!flight->success||!flight->real||!flight->fence.completed()||state.pending!=flight||flight->generation!=state.generation)return;
        state.accepted=flight->slot;state.baseline=flight->baseline;state.acceptedInput=flight->input;state.acceptedTime=flight->time;state.acceptedFrameTime=flight->frameTime;state.pending.reset();
    }
    ShaderResult encodeHistory(const ShaderFrame&frame,const ShaderSpec&spec,const std::shared_ptr<State>&state){
        auto input=currentShaderHistory?*currentShaderHistory:ShaderHistoryInput{};if(!input.contentId)input.contentId=frame.frameId;
        if(!input.contentId)return {false,"Real-frame shader history needs an exact content identity"};
        if(state->pending){promote(*state,state->pending);if(state->pending&&(!state->pending->success||state->pending->fence.failed())){state->pending->cancelled=true;state->pending.reset();}}
        const bool real=!input.synthetic&&!input.redraw;
        const bool contractChanged=state->contract.epoch!=input.epoch||state->contract.imageRevision!=input.imageRevision||state->contract.history()!=input.history();
        const bool sameContent=(state->accepted&&state->acceptedInput.contentId==input.contentId)||(state->pending&&state->pending->input.contentId==input.contentId);
        const bool seek=real&&state->accepted&&std::isfinite(frame.timeMs)&&(frame.timeMs<state->acceptedTime||frame.timeMs-state->acceptedTime>1000);
        const bool repeated=!contractChanged&&!seek&&sameContent;
        const bool reset=contractChanged||seek||(input.reset&&!repeated);
        if(reset){++state->generation;state->contract=input;state->accepted.reset();state->baseline.reset();if(state->pending)state->pending->cancelled=true;state->pending.reset();}
        std::shared_ptr<HistorySlot>baseline=state->accepted;
        if((input.redraw||repeated)&&state->accepted&&state->acceptedInput.contentId==input.contentId)baseline=state->baseline;
        if(state->pending){auto previous=state->pending;
            if(repeated)baseline=previous->baseline;
            else if(real&&previous->commands==frame.commands)baseline=previous->slot;
            else if(previous->fence.status()<MTLCommandBufferStatusCommitted&&real){previous->cancelled=true;state->pending.reset();}
            else if(real)return {false,"Waiting for this shader's preceding real GPU history",true};
            else if(previous->input.contentId==input.contentId)baseline=previous->baseline;
        }
        std::shared_ptr<HistorySlot>slot;
        // Generated phases on one command may reuse a disposable set: each is
        // reseeded on GPU and copied to its distinct output before reuse.
        if(!real&&state->lastFlight&&!state->lastFlight->real&&state->lastFlight->commands==frame.commands&&state->lastFlight->fence.status()<MTLCommandBufferStatusCommitted&&state->lastFlight->slot!=baseline)slot=state->lastFlight->slot;
        if(!slot)for(const auto&candidate:state->pool)if(candidate.use_count()==1){slot=candidate;break;}
        if(!slot)return {false,"Shader feedback images are retained by unfinished commands",true};
        auto flight=std::make_shared<HistoryFlight>();flight->slot=slot;flight->baseline=baseline;flight->input=input;flight->real=real&&!repeated;flight->sequence=++state->sequence;flight->generation=state->generation;flight->time=frame.timeMs;flight->frameTime=frame.frameTimeMs;flight->fence.bind(frame.commands);flight->commands=frame.commands;state->lastFlight=flight;if(flight->real)state->pending=flight;
        const std::weak_ptr<State>weak=state;
        [frame.commands addCompletedHandler:^(id<MTLCommandBuffer>commands){flight->fence.observe(commands);if(auto owner=weak.lock()){std::lock_guard guard(owner->lock);promote(*owner,flight);}}];
        auto&r=slot->runtime;if(!baseline){r.uniformSources=state->runtime.uniformSources;r.effect.uniforms=state->runtime.effect.uniforms;r.frames=0;}seed(frame.commands,r,baseline?&baseline->runtime:nullptr);
        const Runtime*animation=!flight->real&&repeated&&state->pending?&state->pending->slot->runtime:!flight->real&&state->accepted?&state->accepted->runtime:nullptr;
        if(animation){r.uniformSources=animation->uniformSources;r.effect.uniforms=animation->effect.uniforms;r.frames=animation->frames;}
        r.sceneReset=!baseline;r.sceneAnimation=flight->real;r.fixedParameters=spec.parameters;++r.parameterGeneration;
        auto context=frame;r.uniformFrameId=input.contentId;if(!real||repeated){context.timeMs=state->acceptedTime;context.frameTimeMs=state->acceptedFrameTime;r.uniformFrameId=state->accepted?state->acceptedInput.contentId:input.contentId;if(repeated&&state->pending){context.timeMs=state->pending->time;context.frameTimeMs=state->pending->frameTime;r.uniformFrameId=state->pending->input.contentId;}}
        struct ClearInputs{Runtime&runtime;~ClearInputs(){runtime.externalTextures.clear();}}clear{r};r.render(context.commands,context.source,context.target,SpatialMethod::Bilinear,context.frameId,context.color,context.origin,context.depth,&context);flight->success=true;return {true,{}};
    }
    std::pair<std::shared_ptr<State>,ShaderSpec> snapshot(){std::lock_guard guard(lock);return {state,spec};}
public:
    explicit ShaderRuntimeNode(const ShaderSpec &value):spec(value){}
    ShaderRuntimeNode(const ShaderSpec&value,std::shared_ptr<State>shared,unsigned frames=4,bool history=false):state(std::move(shared)),spec(value),capacity(frames),realHistory(history){}
    std::shared_ptr<ShaderNode> fork(const ShaderSpec&value){const auto current=snapshot();return std::make_shared<ShaderRuntimeNode>(value,current.first,capacity,realHistory);}
    unsigned concurrentFrames()const noexcept{return capacity;}
    std::shared_ptr<ShaderNode>withConcurrency(unsigned frames){const auto current=snapshot();return std::make_shared<ShaderRuntimeNode>(current.second,current.first,frames,realHistory);}
    bool usesRealHistory()const noexcept{return realHistory;}
    std::shared_ptr<ShaderNode>withHistory(bool enabled){const auto current=snapshot();return std::make_shared<ShaderRuntimeNode>(current.second,current.first,capacity,enabled);}
    std::function<ShaderResult()>historyTicket(){const auto current=snapshot();std::lock_guard guard(current.first->lock);const auto flight=current.first->lastFlight;if(!flight)return {};return [flight](){return ShaderResult{flight->success&&!flight->cancelled&&flight->fence.completed(),flight->cancelled?"Shader history command was superseded":flight->fence.failed()?"Shader history GPU command failed":"Shader history GPU command has not completed"};};}
    void setParameters(const ShaderParameters &parameters) override {std::lock_guard guard(lock);spec.parameters=parameters;}
    ShaderResult prepare(const ShaderFrame &frame) override { @autoreleasepool {
        if(!frame.commands||!frame.source||!frame.target)return {false,"Shader preparation requires the real queue and image extent"};
        try {
            auto current=snapshot();bool changed=false;
            {std::lock_guard guard(current.first->lock);const auto&runtime=current.first->runtime;
             changed=runtime.w!=frame.source.width||runtime.h!=frame.source.height||runtime.colorFormat!=frame.source.pixelFormat||runtime.workingDevice!=frame.commands.device||runtime.processingQueue!=frame.commands.commandQueue||runtime.uniformCapacity!=capacity||current.first->realHistory!=realHistory;}
            if(changed){
                // Candidate preparation never reinitializes an accepted shared
                // generation. Geometry/device/queue changes get their own state.
                auto next=std::make_shared<State>();next->runtime.fixedSelection=current.second.selection;next->runtime.fixedParameters=current.second.parameters;next->runtime.declareSceneInputs(shaderSceneInputs(frame));next->runtime.uniformCapacity=capacity;
                next->runtime.init(frame.commands.device,frame.source,false,frame.commands.commandQueue);
                if(realHistory)prepareHistory(*next,capacity);
                {std::lock_guard guard(lock);if(state==current.first)state=next;else return {false,"Shader preparation was superseded",true};}
                current.first=std::move(next);
            }
            std::lock_guard guard(current.first->lock);
            current.first->runtime.validateSceneInputs(shaderSceneInputs(frame));
            return {true,{}};
        }catch(const std::exception &error){return {false,error.what()};}
    }}
    ShaderResult encode(const ShaderFrame &frame) override { @autoreleasepool {
        if(!frame.commands||!frame.source||!frame.target)return {false,"Shader stage requires its command buffer, source and target"};
        if(frame.commands.status>=MTLCommandBufferStatusCommitted)return {false,"Shader stage command buffer is already submitted"};
        if(frame.source.device!=frame.commands.device||frame.target.device!=frame.commands.device)return {false,"Shader stage images must use the command buffer device"};
        if(frame.source.framebufferOnly||frame.target.framebufferOnly||frame.source.textureType!=MTLTextureType2D||frame.target.textureType!=MTLTextureType2D||frame.source.sampleCount!=1||frame.target.sampleCount!=1)return {false,"Shader stage requires accessible, resolved 2D images"};
        const auto ready=prepare(frame);if(!ready.encoded)return ready;
        auto current=snapshot();std::lock_guard guard(current.first->lock);
        if(current.first->runtime.needsDepth&&!frame.depth)return {false,"The selected shader requires depth from this frame"};
        try {
            if(current.first->realHistory)return encodeHistory(frame,current.second,current.first);
            auto&runtime=current.first->runtime;
            // This is accepted encoding, after the candidate has passed all
            // preparation. Borrowed-resource admission inside render protects
            // actual GPU uniform writes; each node retains its own desired map.
            if(runtime.fixedParameters!=current.second.parameters){runtime.fixedParameters=current.second.parameters;++runtime.parameterGeneration;}
            auto retained=current.first;[frame.commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)retained;}];
            struct ClearInputs{Runtime&runtime;~ClearInputs(){runtime.externalTextures.clear();}}clearInputs{runtime};
            runtime.render(frame.commands,frame.source,frame.target,SpatialMethod::Bilinear,frame.frameId,frame.color,frame.origin,frame.depth,&frame);
            return {true,{}};
        }catch(const borrowed::Busy &error){return {false,error.what(),true};}
        catch(const SpatialBusy &error){return {false,error.what(),true};}
        catch(const std::exception &error){return {false,error.what()};}
    }}

};
}
std::shared_ptr<ShaderNode>coreShaderWithRealHistory(const std::shared_ptr<ShaderNode>&node,bool enabled){const auto runtime=std::dynamic_pointer_cast<ShaderRuntimeNode>(node);return runtime&&runtime->usesRealHistory()!=enabled?runtime->withHistory(enabled):node;}
std::function<ShaderResult()>coreShaderHistoryCompletionTicket(const std::shared_ptr<ShaderNode>&node){const auto runtime=std::dynamic_pointer_cast<ShaderRuntimeNode>(node);return runtime?runtime->historyTicket():std::function<ShaderResult()>{};}
std::shared_ptr<ShaderNode>coreShaderWithConcurrency(const std::shared_ptr<ShaderNode>&node,unsigned frames){if(!frames||frames>4*maximumTimelineImages)throw std::invalid_argument("The shader frame capacity exceeds the admitted timeline");const auto runtime=std::dynamic_pointer_cast<ShaderRuntimeNode>(node);return runtime&&runtime->concurrentFrames()!=frames?runtime->withConcurrency(frames):node;}
std::shared_ptr<ShaderNode> forkCoreShaderNode(const std::shared_ptr<ShaderNode>&node,const ShaderSpec&spec){
    const auto original=std::dynamic_pointer_cast<ShaderRuntimeNode>(node);return original?original->fork(spec):nullptr;
}
std::shared_ptr<ShaderNode> makeShaderNode(const ShaderSpec &spec) {
    if(spec.selection.file.empty())throw std::runtime_error("Shader stage has no prepared source");
    return std::make_shared<ShaderRuntimeNode>(spec);
}
}

void macfx::releaseFrameOwner(void *owner) {
    if (!owner) return;
    noteMetalDecision(reinterpret_cast<uintptr_t>(owner),"owner-retired");
    retireRuntimeStatus(reinterpret_cast<uintptr_t>(owner));
    // Retired resources may invoke framework teardown. Never destroy them
    // while the global owner map is locked; submitted buffers retain their own
    // GPU resources and Core Animation retains displayed IOSurfaces.
    std::map<void*,Runtime>::node_type runtime,bridge;
    std::map<void*,SurfacePool>::node_type pool;
    {std::lock_guard<std::mutex> guard(mutex());runtime=runtimes().extract(owner);pool=surfacePools().extract(owner);}
    {std::lock_guard<std::mutex> guard(bridgeMutex());bridge=bridgeRuntimes().extract(owner);}
}
extern "C" void rsReleaseFrameOwner(void *owner) { macfx::releaseFrameOwner(owner); }

static int processFrameAPI(const RSFrameRequest *request,const RSFrameDepth *depth,RSFrameResult *result,const RSImageColorDescription*color=nullptr) {
    if(!request || !result || request->size<sizeof(RSFrameRequest) || result->size<sizeof(RSFrameResult) || request->version!=RS_FRAME_ABI_VERSION || result->version!=RS_FRAME_ABI_VERSION) return RS_FRAME_INVALID_ARGUMENT;
    const uint32_t size=result->size;*result={};result->size=size;result->version=RS_FRAME_ABI_VERSION;result->frameId=request->frameId;
    if(request->method>RS_FRAME_BICUBIC || request->color>RS_FRAME_LINEAR || request->origin>RS_FRAME_BOTTOM_LEFT) {std::strncpy(result->reason,"Unsupported frame method, colour mode or origin",sizeof(result->reason)-1);return RS_FRAME_INVALID_ARGUMENT;}
    try { @try {
        macfx::SpatialFrame frame{(__bridge id<MTLTexture>)request->sourceTexture,(__bridge id<MTLTexture>)request->outputTexture,request->frameId,static_cast<macfx::SpatialColor>(request->color),static_cast<macfx::FrameOrigin>(request->origin)};
        const macfx::DepthFrame captured{depth?(__bridge id<MTLTexture>)depth->texture:nil,depth?depth->frameId:0,depth?static_cast<macfx::FrameOrigin>(depth->origin):macfx::FrameOrigin::TopLeft};
        std::optional<macfx::ImageColorDescription>description;if(color){description=macfx::readImageColor(*color);frame.color=macfx::spatialColorForDescription(*description);}
        auto value=description?macfx::processColorFrame(request->owner,(__bridge id<MTLCommandBuffer>)request->commandBuffer,frame,static_cast<macfx::SpatialMethod>(request->method),depth?&captured:nullptr,description->alpha==macfx::ColorAlpha::Opaque,nullptr,nullptr,macfx::imageColorLabel(*description),&*description):macfx::processFrameWithDepth(request->owner,(__bridge id<MTLCommandBuffer>)request->commandBuffer,frame,static_cast<macfx::SpatialMethod>(request->method),depth?&captured:nullptr);
        if(value.encoded)macfx::observeRuntimeFrameSource(reinterpret_cast<uintptr_t>(request->owner),macfx::RuntimeFrameSource::ExplicitTexture,depth?macfx::RuntimeInputDepth:0);
        result->encoded=value.encoded;result->effects=value.effects;result->scaled=value.scaled;result->activeMethod=value.scaled?static_cast<uint32_t>(value.scaling.active):request->method;
        result->inputWidth=frame.source.width;result->inputHeight=frame.source.height;result->outputWidth=frame.output.width;result->outputHeight=frame.output.height;
        const auto &reason=value.reason.empty()?value.scaling.reason:value.reason;std::strncpy(result->reason,reason.c_str(),sizeof(result->reason)-1);
        return value.encoded?RS_FRAME_OK:value.busy?RS_FRAME_BUSY:RS_FRAME_ENCODE_FAILED;
    } @catch(NSException *error) {std::strncpy(result->reason,error.reason.UTF8String?:"Frame processing failed",sizeof(result->reason)-1);} }
    catch(const std::exception &error) {std::strncpy(result->reason,error.what(),sizeof(result->reason)-1);}
    catch(...) {std::strncpy(result->reason,"Frame processing failed",sizeof(result->reason)-1);}
    return RS_FRAME_ENCODE_FAILED;
}

// A valid plan that selects no image processing is adopted without an
// executor. While a reader leases a page this process already mapped, record
// that revision for the frame owner on a revision or controls change, then
// refresh it at most every 250 ms. Without a lease this returns after one load.
void macfx::observeBypassedPlan(uintptr_t owner) noexcept {
    if(!owner||!macfx::runtimeStatusLeased())return;
    try{
        std::string revision;if(!macfx::effectPlanBypassRevision(revision))return;
        struct Recorded {std::string revision;uint64_t controls=0;std::chrono::steady_clock::time_point at;};
        static auto *const lock=new std::mutex;static auto *const recorded=new std::map<uintptr_t,Recorded>;
        const auto controls=macfx::liveState().generation;const auto now=std::chrono::steady_clock::now();
        {std::lock_guard<std::mutex> guard(*lock);if(recorded->size()>64)recorded->clear();auto &last=(*recorded)[owner];
         if(last.revision==revision&&last.controls==controls&&now<last.at+std::chrono::milliseconds(250))return;last={revision,controls,now};}
        const auto digest=macfx::presentationControlsDigest();
        macfx::RuntimeStatusEvent event;event.context=owner;event.processing=true;event.idle=true;event.resourceAccepted=true;
        event.phase=macfx::RuntimeStatusPhase::Bypassed;event.planRevision=revision;event.controlsDigest=digest;macfx::observeRuntimeStatus(event);
        // A document whose rows were all rejected is a pass-through plan too;
        // its rows carry the reader's reasons.
        if(const auto plan=macfx::currentEffectPlan();plan&&plan->revision==revision)for(const auto &node:plan->nodes)if(!node.rejection.empty()){
            macfx::RuntimeStatusEvent row;row.context=owner;row.processing=true;row.idle=true;row.phase=macfx::RuntimeStatusPhase::Bypassed;row.planRevision=revision;
            row.stageId=node.id;row.requestedMethod=node.method.empty()?node.format:node.method;row.activeMethod="passthrough";row.reason=node.rejection;macfx::observeRuntimeStatus(row);
        }
    }catch(...){}
}
macfx::FrameResult macfx::processFrame(void *owner,id<MTLCommandBuffer> commands,const SpatialFrame &frame,SpatialMethod method){return processFrameWithDepth(owner,commands,frame,method,nullptr);}
bool macfx::frameRequiresDepth(void *owner,id<MTLDevice> device,unsigned width,unsigned height){
    if(!macfx::effectRequested())return false;
    if(!owner||!device||!width||!height||width>16384||height>16384)throw std::runtime_error("Invalid frame dimensions or owner");
    if(macfx::effectPlanRequested()){
        // The reader's demand covers the current plan; an accepted execution
        // keeps its own inputs. Nothing is created here, so a layer that the
        // window resolver does not accept costs a few loads per drawable.
        if(macfx::effectPlanDemands(macfx::PlanDemandDepth))return true;
        // Map lookups do not message or dereference the opaque owner. Release
        // their lock before taking a presenter lock, then the runtime lock.
        auto presentation=macfx::viewPresentationForOwner(owner);
        if(presentation&&presentation->requiresDepth())return true;
        std::lock_guard<std::mutex> guard(mutex());const auto found=runtimes().find(owner);
        return found!=runtimes().end()&&found->second.plan&&found->second.plan->requiresDepth();
    }
    std::lock_guard<std::mutex> guard(mutex());auto &runtime=runtimes()[owner];runtime.statusContext=reinterpret_cast<uintptr_t>(owner);
    if(runtime.selection.revision!=macfx::effectSelection().revision){Runtime next;next.prepare(width,height);return next.needsDepth;}
    return runtime.needsDepth;
}
extern "C" int rsProcessFrame(const RSFrameRequest *request,RSFrameResult *result){return processFrameAPI(request,nullptr,result);}
extern "C" int rsProcessFrameWithDepth(const RSFrameRequest *request,const RSFrameDepth *depth,RSFrameResult *result){if(!depth||depth->size<sizeof(*depth)||depth->version!=RS_DEPTH_ABI_VERSION||depth->reserved||depth->origin>RS_FRAME_BOTTOM_LEFT||!depth->texture)return RS_FRAME_INVALID_ARGUMENT;return processFrameAPI(request,depth,result);}
extern "C" int rsProcessFrameWithColor(const RSFrameRequest*request,const RSFrameDepth*depth,const RSImageColorDescription*color,RSFrameResult*result){if(!color||depth&&(depth->size<sizeof(*depth)||depth->version!=RS_DEPTH_ABI_VERSION||depth->reserved||depth->origin>RS_FRAME_BOTTOM_LEFT||!depth->texture))return RS_FRAME_INVALID_ARGUMENT;return processFrameAPI(request,depth,result,color);}

CGSize macfx::publisherDrawableSize(CAMetalLayer *layer){
    bool resolution=false;try{resolution=macfx::drawableResolutionRequested();}catch(...){}
    if(resolution)if(auto state=(RSMLayerResolution*)objc_getAssociatedObject(layer,&resolutionKey)){std::lock_guard<std::mutex>guard(state->lock);if(state->recorded)return state->publisherSize;}
    return layer.drawableSize;
}
extern "C" uint32_t rsShaderSceneHistoryAPI(void){return 1;}
