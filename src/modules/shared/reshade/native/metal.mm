#include "live-controls.hpp"
#include "log.hpp"
#include "presentation-internal.hpp"
#include "effect.hpp"
#include "metal-library-cache.hpp"
#include "metal-frame-failure.hpp"
#include "uniform-sources.hpp"
#include "retroarch.hpp"
#include "effect-node.hpp"
#include "effects-execution.hpp"
#include "temporal-plan.hpp"
#include "frame-capture.hpp"
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
#include "native-layer.h"
#include <unistd.h>
#import <IOSurface/IOSurface.h>

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

API_AVAILABLE(macos(26.0))
@interface RSMMetal4Bridge : NSObject {
@public
    std::mutex lock;
    id<MTLCommandQueue> effects;
    id<MTLSharedEvent> producer;
    id<MTLSharedEvent> finished;
    std::atomic<bool> failed;
    uint64_t sequence;
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
    if(macfx::InPlaceHistory::original(state))macfx::nativeLog("In-place processing remained busy; original rendering is retained until settings or the source changes");
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
bool explicitHost() { static const bool value=[] { const char *text=std::getenv("RESHADE_EXPLICIT_HOST");return text&&std::strcmp(text,"1")==0; }();return value; }
bool acceptsNativeLayer(CALayer *layer) { return nativeLayer(layer)||(explicitHost()?false:macfx::acceptsLayer(layer)); }
bool currentPresentationDemand() {
    if(macfx::imageProcessingRequested()||macfx::virtualWindowEnabled()||macfx::timingEnabled())return true;
    try{return macfx::drawableResolutionRequested();}catch(...){return false;}
}
bool layerPresentationDemand(CAMetalLayer *layer) {
    if(nativeLayer(layer)||currentPresentationDemand())return true;
    const auto presentation=macfx::metalPresentation(layer);
    return presentation&&!presentation->snapshot().stopped;
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
    if(!std::getenv("RESHADE_DIAGNOSTICS")&&!std::getenv("RESHADE_TRACE"))return {};
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
struct Pass { reshadefx::pass metadata; id<MTLRenderPipelineState> pipeline; id<MTLDepthStencilState> stencil; id<MTLComputePipelineState> compute; MTLSize threads; };
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
    uint64_t placeboControls=~uint64_t(0);
    std::shared_ptr<macfx::EffectPlanExecutor> plan;uintptr_t statusContext=0;
    id<MTLTexture> colors[2]; std::map<std::string,id<MTLTexture>> textures;
    std::vector<id<MTLSamplerState>> samplers; std::vector<Pass> passes; std::set<std::string> initializedTextures;
    std::vector<id<MTLTexture>> storages;
    bool failed=false, captureFlipY=false, needsDepth=false, depthWarning=false, scalingFirst=false; uint64_t frames=0;
    macfx::MetalFrameFailure automaticFailure;
    unsigned compiledWidth=0,compiledHeight=0;
    id<MTLTexture> depthCopy,frameDepth,stencilTexture;
    id<MTLComputePipelineState> depthPipeline;
    void prepare(unsigned width,unsigned height) {
        if(compiledWidth==width&&compiledHeight==height)return;
        prepareLaunchEffect();
        selection=fixedSelection?*fixedSelection:macfx::effectSelection();const char *fx=selection.file.c_str();
        if(macfx::retroarchFile(selection.file)||macfx::libplaceboFile(selection.file)) {needsDepth=false;compiledWidth=width;compiledHeight=height;return;}
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
    std::unique_ptr<macfx::SpatialEncoder> spatial;id<MTLDevice> spatialDevice=nil;
    __weak id<MTLCommandQueue> spatialQueue=nil;
    macfx::SpatialStatus lastScaling;
    macfx::SpatialEncoder &spatialEncoder(id<MTLCommandBuffer> commands) {
        if(!spatial||spatialDevice!=commands.device||spatialQueue!=commands.commandQueue) {
            spatial=std::make_unique<macfx::SpatialEncoder>(commands.device);
            spatialDevice=commands.device;spatialQueue=commands.commandQueue;
        }
        return *spatial;
    }
    macfx::SpatialStatus scale(id<MTLCommandBuffer> commands,const macfx::SpatialFrame &frame,macfx::SpatialMethod method) {
        return lastScaling=spatialEncoder(commands).encode(commands,frame,method);
    }
    macfx::SpatialStatus transfer(id<MTLCommandBuffer> commands,id<MTLTexture> source,id<MTLTexture> target,uint64_t frameId,macfx::SpatialColor color) {
        // A physical texel transfer is independent of the selected upscaler,
        // its status, and the source's logical presentation orientation.
        return spatialEncoder(commands).encode(commands,{source,target,frameId,color,macfx::FrameOrigin::TopLeft},macfx::SpatialMethod::Nearest,{});
    }
    std::chrono::steady_clock::time_point started=std::chrono::steady_clock::now(),lastFrame=started;
    void init(id<MTLDevice> device,id<MTLTexture> target,bool scaleFirst=false,id<MTLCommandQueue> queue=nil) {
        w=target.width; h=target.height; colorFormat=target.pixelFormat;
        processingQueue=queue;workingDevice=device;
        scalingFirst=scaleFirst;
        const auto formatDiagnostic=colorFormatDiagnostic(colorFormat);
        if(!macfx::nativeFxColorFormatSupported(colorFormat))
            throw std::runtime_error("Metal drawable format is not supported yet"+formatDiagnostic);
        prepare(w,h);
        const char *fx=selection.file.c_str();
        textures.clear(); samplers.clear(); passes.clear(); storages.clear(); initializedTextures.clear();stencilTexture=nil;
        // The stock Slang Metal provider normalizes its 8-bit allocations and
        // render pipelines to BGRA. Give both sides that actual format rather
        // than raw-blit RGBA bytes into its history or a mismatched attachment.
        const bool normalizeSlang=macfx::retroarchFile(selection.file)&&colorFormat==MTLPixelFormatRGBA8Unorm;
        const auto workingFormat=normalizeSlang?MTLPixelFormatBGRA8Unorm:colorFormat;
        colors[0]=texture(device,w,h,workingFormat,1,scalingFirst||normalizeSlang);colors[1]=texture(device,w,h,workingFormat,1,normalizeSlang);
        if(macfx::libplaceboFile(selection.file)) {
            if(!queue)throw std::runtime_error("libplacebo initialization requires its Metal queue");
            placebo=macfx::makeLibplaceboShaderNode({selection,fixedParameters});
            const auto ready=placebo->prepare({[queue commandBuffer],colors[0],colors[1]});
            if(!ready.encoded)throw std::runtime_error(ready.reason);
            log("Metal libplacebo shader selected: "+selection.file+" "+std::to_string(w)+"x"+std::to_string(h)+formatDiagnostic);return;
        }
        if(macfx::retroarchFile(selection.file)) {
            if(!queue)throw std::runtime_error("RetroArch preset initialization requires its Metal queue");
            retroarch=std::make_shared<macfx::RetroarchChain>(selection.file,selection.key,queue);
            log("Metal RetroArch preset selected: "+selection.file+" "+std::to_string(w)+"x"+std::to_string(h)+formatDiagnostic);return;
        }
        size_t imageBytes=0;
        for(const auto &t:effect.module.textures) if(t.semantic.empty()) {
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
            for(const auto &t:effect.module.textures)if(t.unique_name==s.texture_name&&!t.semantic.empty()&&t.semantic!="COLOR"&&t.semantic!="DEPTH")
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
                passes.push_back({p,pipeline,stencil,nil,{0,0,0}});
            }
        }
        if(passes.empty()) throw std::runtime_error("No matching graphics technique");
        log("Metal effect ready: "+std::string(fx)+" "+std::to_string(w)+"x"+std::to_string(h)+" passes="+std::to_string(passes.size())+formatDiagnostic);
    }
    id<MTLTexture> resolve(const std::string &name,unsigned current) {
        auto t=textures.find(name); if(t!=textures.end()) return t->second;
        for(const auto &meta:effect.module.textures) if(meta.unique_name==name) {
            if(meta.semantic=="COLOR")return colors[current];
            if(meta.semantic=="DEPTH"&&frameDepth)return frameDepth;
        }
        throw std::runtime_error("Unsupported texture semantic: "+name);
    }
    void render(id<MTLCommandBuffer> buffer,id<MTLTexture> target) {render(buffer,target,target,macfx::SpatialMethod::Bilinear);}
    void render(id<MTLCommandBuffer> buffer,id<MTLTexture> source,id<MTLTexture> target,macfx::SpatialMethod method=macfx::SpatialMethod::Bilinear,uint64_t frameId=0,macfx::SpatialColor color=macfx::SpatialColor::Perceptual,macfx::FrameOrigin origin=macfx::FrameOrigin::TopLeft,const macfx::DepthFrame *depth=nullptr,const macfx::ShaderFrame *stage=nullptr,bool opaqueDisplay=true,const macfx::FrameEncodingInputs*strict=nullptr,macfx::FrameEncodingReceipt*receipt=nullptr) {
        if(strict&&receipt)receipt->planRevision=strict->plan->revision;
        if(!stage&&macfx::effectPlanRequested()&&!strict) {
            if(!plan)plan=std::make_shared<macfx::EffectPlanExecutor>();
            plan->setStatusContext(statusContext);
            const auto now=std::chrono::steady_clock::now();
            macfx::ShaderFrame context{buffer,source,target,frameId?frameId:frames+1,std::chrono::duration<double,std::milli>(now-started).count(),frames?float(std::chrono::duration<double,std::milli>(now-lastFrame).count()):16.666667f,origin,color,depth};
            context.opaqueDisplay=opaqueDisplay;
            if(auto scene=macfx::takeTemporalOutput(buffer,source);scene.execution) {
                scene.execution->setStatusContext(statusContext);
                context.frameId=scene.frameId;context.depth=nullptr;
                auto capture=scene.capture?scene.capture:macfx::FrameCapture::begin(buffer,source,frames+1,captureFlipY);
                const auto result=scene.execution->encodeAfterScene(context);
                if(!result.encoded){if(result.busy)throw SpatialBusy(result.reason);throw std::runtime_error(result.reason);}
                if(capture)capture->finish(buffer,target,captureFlipY);
                if(receipt){receipt->advanced=true;receipt->planRevision=scene.execution->revision();}
                const auto controlsIdentity=macfx::presentationControlsDigest();macfx::RuntimeStatusEvent event;event.context=statusContext;event.processing=true;event.resourceAccepted=true;event.phase=macfx::RuntimeStatusPhase::Encoded;event.planRevision=scene.execution->revision();event.controlsDigest=controlsIdentity;macfx::observeRuntimeStatus(event);
                lastFrame=now;++frames;return;
            }
            const auto selected=plan->prepare(context);
            if(selected.active) {
                if(!selected.execution)throw std::runtime_error(selected.error.empty()?"The ordered effect plan is unavailable":selected.error);
                auto capture=macfx::FrameCapture::begin(buffer,source,frames+1,captureFlipY);
                const auto result=selected.execution->encode(context);
                if(!result.encoded){if(result.busy)throw SpatialBusy(result.reason);throw std::runtime_error(result.reason);}
                if(capture)capture->finish(buffer,target,captureFlipY);
                if(receipt){receipt->advanced=true;receipt->planRevision=selected.execution->revision();}
                lastFrame=now;++frames;return;
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
            try{Runtime next;next.fixedSelection=fixedSelection;next.fixedParameters=fixedParameters;next.parameterGeneration=parameterGeneration;next.captureFlipY=captureFlipY;next.borrowedOwner=borrowedOwner;next.statusContext=statusContext;next.init(buffer.device,effectTarget,scaleFirst,buffer.commandQueue);if(!moved){next.spatial=std::move(spatial);next.spatialDevice=spatialDevice;next.spatialQueue=spatialQueue;}*this=std::move(next);}
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
        if(scaleFirst||source.pixelFormat!=colors[0].pixelFormat) {
            const auto status=scaleFirst?scale(buffer,{source,colors[0],frameId,color,origin},method):transfer(buffer,source,colors[0],frameId,color);
            if(!status.encoded){if(status.busy)throw SpatialBusy(status.reason);throw std::runtime_error(status.reason);}
            pending.started=true;
        } else {
            pending.started=true;
            auto input=[buffer blitCommandEncoder];
            [input copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toTexture:colors[0] destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
            [input endEncoding];
        }
        unsigned current=0;
        const auto now=std::chrono::steady_clock::now();
        const float frameTime=stage?stage->frameTimeMs:frames?std::chrono::duration<float,std::milli>(now-lastFrame).count():16.666667f;lastFrame=now;
        const bool slang=macfx::retroarchFile(selection.file),hook=macfx::libplaceboFile(selection.file);
        const uint64_t sourceFrameId=stage?stage->frameId:frameId?frameId:frames;
        if(!slang&&!hook)uniformSources.update(effect,stage?stage->timeMs:std::chrono::duration<double,std::milli>(now-started).count(),frameTime,sourceFrameId,depth!=nullptr);
        if(!slang&&!hook&&fixedSelection&&appliedParameters!=parameterGeneration) {
            uniformSources.setParameters(effect,fixedParameters);appliedParameters=parameterGeneration;
        }
        const auto &values=effect.uniforms;
        id<MTLBuffer> capturedInput=nil;
        const char *capture=stage?nullptr:std::getenv("RESHADE_CAPTURE_PREFIX");
        const char *captureAt=std::getenv("RESHADE_CAPTURE_FRAME");
        const char *captureTrigger=std::getenv("RESHADE_CAPTURE_TRIGGER");
        const bool captureRequested=capture && (captureTrigger?unlink(captureTrigger)==0:
            frames+1==(captureAt?std::strtoull(captureAt,nullptr,10):120));
        // PNG readback below is explicitly RGBA8/BGRA8, not packed 10-bit or
        // eight-byte FP16 pixels. Effect images keep their original format.
        const bool captureFrame=captureRequested&&(colorFormat==MTLPixelFormatBGRA8Unorm||colorFormat==MTLPixelFormatRGBA8Unorm);
        if(captureRequested&&!captureFrame){
            static std::atomic<bool> warned{false};
            if(!warned.exchange(true))log("PNG frame capture requires RGBA8 or BGRA8; effect processing continues");
        }
        unsigned stride=(w*4+255)&~255u;
        if(captureFrame) {
            capturedInput=[buffer.device newBufferWithLength:stride*h options:MTLResourceStorageModeShared];
            auto encoder=[buffer blitCommandEncoder];
            [encoder copyFromTexture:colors[0] sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toBuffer:capturedInput destinationOffset:0 destinationBytesPerRow:stride destinationBytesPerImage:stride*h];
            [encoder endEncoding];
        }
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
            const auto result=placebo->encode({buffer,colors[0],colors[1],sourceFrameId,stage?stage->timeMs:std::chrono::duration<double,std::milli>(now-started).count(),frameTime,origin,color,depth,stage?stage->opaqueDisplay:opaqueDisplay});
            if(!result.encoded){if(result.busy)throw SpatialBusy(result.reason);throw std::runtime_error(result.reason);}current=1;
            if(lease)lease->hold(colors[1]);
        }
        if(slang) {
            if(!retroarch||retroarch->queue!=buffer.commandQueue)
                retroarch=std::make_shared<macfx::RetroarchChain>(selection.file,selection.key,buffer.commandQueue);
            // The original chain owns its LUT/history/feedback resources until
            // every encoding using it has completed, including live replacement.
            auto retained=retroarch;
            [buffer addCompletedHandler:^(id<MTLCommandBuffer>){(void)retained;}];
            if(lease)lease->hold(colors[1]);
            try {retroarch->encode(buffer,colors[0],colors[1],sourceFrameId,frameTime,fixedSelection?&fixedParameters:nullptr,parameterGeneration);}
            catch(const macfx::RetroarchBusy &error){throw SpatialBusy(error.what());}
            current=1;
        }
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
            id<MTLTexture> output=back?colors[1-current]:textures.at(p.render_target_names[0]);
            if(lease){lease->hold(output);lease->hold(pass.pipeline);}
            if(back) {
                auto copy=[buffer blitCommandEncoder];
                [copy copyFromTexture:colors[current] sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toTexture:output destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
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
        const bool scaling=needsScaling&&!scaleFirst&&(!slang||colors[current].width!=target.width||colors[current].height!=target.height);
        const bool conversion=!scaling&&colors[current].pixelFormat!=target.pixelFormat;
        if(scaling||conversion) {
            auto status=scaling?scale(buffer,{colors[current],target,frameId,color,origin},method):transfer(buffer,colors[current],target,frameId,color);
            if(!status.encoded) {if(status.busy)throw SpatialBusy(status.reason);throw std::runtime_error(status.reason);}
        }
        auto output=(!(scaling||conversion) || captureFrame)?[buffer blitCommandEncoder]:nil;
        if(!(scaling||conversion)) [output copyFromTexture:colors[current] sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toTexture:target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
        id<MTLBuffer> capturedOutput=nil;
        if(captureFrame) {
            capturedOutput=[buffer.device newBufferWithLength:stride*h options:MTLResourceStorageModeShared];
            [output copyFromTexture:colors[current] sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toBuffer:capturedOutput destinationOffset:0 destinationBytesPerRow:stride destinationBytesPerImage:stride*h];
        }
        [output endEncoding];
        if(captureFrame) {
            std::string prefix=capture;unsigned width=w,height=h;bool inputBgra=colors[0].pixelFormat==MTLPixelFormatBGRA8Unorm,outputBgra=colors[current].pixelFormat==MTLPixelFormatBGRA8Unorm,flip=captureFlipY;
            [buffer addCompletedHandler:^(id<MTLCommandBuffer> b) { @autoreleasepool {
                if(b.status==MTLCommandBufferStatusCompleted) {
                    try {
                        savePNG(prefix+"-before.png",capturedInput.contents,width,height,inputBgra,flip,stride);
                        savePNG(prefix+"-after.png",capturedOutput.contents,width,height,outputBgra,flip,stride);
                        log("Metal frame capture saved: "+prefix);
                    } catch(const std::exception &error) { log(error.what()); }
                } else log("Metal GPU error: "+std::string(b.error.localizedDescription.UTF8String?:"unknown"));
            }}];
        }
        if(receipt){receipt->selection=selection;receipt->afterScaling=scaleFirst;
            if(!sameSelection(selection,desired))receipt->planRevision.clear();}
        ++frames; if(frames==1 || frames==120) log("Metal effect frame="+std::to_string(frames));
    }
};
std::mutex &mutex() { static auto *m=new std::mutex; return *m; }
std::map<void*,Runtime> &runtimes() { static auto *m=new std::map<void*,Runtime>; return *m; }
std::mutex &bridgeMutex() { static auto *m=new std::mutex;return *m; }
std::map<void*,Runtime> &bridgeRuntimes() {static auto *m=new std::map<void*,Runtime>;return *m;}
struct SurfacePool {
    unsigned w=0,h=0,cursor=0;OSType format=0;std::vector<IOSurfaceRef> surfaces;
    std::vector<std::shared_ptr<macfx::ImageReservation>> reservations;
    void clear(){for(size_t i=0;i<surfaces.size();++i)macfx::retireOwnedSurface(surfaces[i],std::move(reservations[i]));surfaces.clear();reservations.clear();cursor=0;}
    ~SurfacePool(){clear();}
};
std::map<void*,SurfacePool> &surfacePools(){static auto *m=new std::map<void*,SurfacePool>;return *m;}

std::map<std::pair<Class,SEL>,IMP> &originals() { static auto *m=new std::map<std::pair<Class,SEL>,IMP>; return *m; }
std::mutex &hookMutex() { static auto *m=new std::mutex; return *m; }
IMP original(id object,SEL selector) {
    std::lock_guard<std::mutex> guard(hookMutex());
    for(Class cls=object_getClass(object);cls;cls=class_getSuperclass(cls)) { auto it=originals().find({cls,selector}); if(it!=originals().end()) return it->second; }
    return nullptr;
}
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
    if(!encoder||!captureDepth.load(std::memory_order_relaxed)||!macfx::effectRequested())return encoder;
    const auto attachment=descriptor.depthAttachment;
    const auto colorAttachment=descriptor.colorAttachments[0];
    const auto stored=[](MTLRenderPassAttachmentDescriptor *a)->id<MTLTexture>{
        if(a.storeAction==MTLStoreActionStore)return a.texture;
        if(a.storeAction==MTLStoreActionMultisampleResolve||a.storeAction==MTLStoreActionStoreAndMultisampleResolve)return a.resolveTexture;
        return nil;
    };
    const auto depth=stored(attachment),color=stored(colorAttachment);
    // Match the actual acquired presentation color. A previous depth shader
    // cannot keep retaining attachments for a later color-only selection, and
    // one layer's color-only frame cannot clear another layer's requirement.
    if(!color||!macfx::colorRequiresDepth(color))return encoder;
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
void process(id<MTLCommandBuffer> buffer,id<MTLDrawable> drawable,const char *timingScope="game-and-effects") {
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
    noteMetalDecision(reinterpret_cast<uintptr_t>((__bridge void*)metal.layer),"frame-owner-accepted",metal.texture.width,metal.texture.height,
        reinterpret_cast<uintptr_t>((__bridge void*)buffer.commandQueue),uint32_t(metal.texture.pixelFormat));
    if(macfx::effectRequested()){
        // Do not create runtime state for dormant publishers. A changed actual
        // image contract admits one retry before depth/compiler preparation.
        std::lock_guard<std::mutex>guard(mutex());auto found=runtimes().find((__bridge void*)metal.layer);
        if(found!=runtimes().end()&&found->second.automaticFailure.blocks(metal.texture))return;
    }
    if(std::getenv("RESHADE_NEURAL_CAPTURE_INPUT")){
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
    if(metal.texture.framebufferOnly&&macfx::imageProcessingRequested(readsSource)) {
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
            auto result=presentation->submitDisplayFrame(buffer,source,0,CACurrentMediaTime(),metal.layer.opaque,captured?&depth:nullptr);
            if(result.encoded){macfx::observeTiming(buffer,timingScope,source.width,source.height);return;}
            if(result.busy)return;
            presentation->stop();log("Graphics presentation disabled: "+result.reason);
        }catch(const std::exception&error){presentation->stop();log("Graphics presentation disabled: "+std::string(error.what()));}}
        @catch(NSException*error){presentation->stop();log("Graphics presentation disabled: "+std::string(error.reason.UTF8String?:"Presentation failed"));}
    }
    if(!macfx::effectRequested()) {
        macfx::observeTiming(buffer,"game",metal.texture.width,metal.texture.height);
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
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalEncode,0,target.width,target.height);runtime.render(buffer,target,target,macfx::SpatialMethod::Bilinear,0,macfx::SpatialColor::Perceptual,macfx::FrameOrigin::TopLeft,captured?&depth:nullptr,nullptr,metal.layer.opaque);}
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
    if(std::getenv("RESHADE_TRACE") && calls.fetch_add(1)==0) log("Metal commit: "+std::string(object_getClassName(object)));
    encodePendingPresentations(object);
    reinterpret_cast<void(*)(id,SEL)>(original(object,selector))(object,selector);
    if(!encodingEffects && !macfx::ownsPresentationBuffer(object) && std::getenv("RESHADE_LAYER_SURFACE")) {
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
    if(macfx::ownsPresentation(layer)||!layerPresentationDemand(layer))return;
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
struct PendingPresent { id<MTLDrawable> drawable; SEL selector; CFTimeInterval time; };
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
        objc_getAssociatedObject(drawable,&nativePresentationKey) || macfx::ownsPresentation(((id<CAMetalDrawable>)drawable).layer) ||
        !layerPresentationDemand(((id<CAMetalDrawable>)drawable).layer)||
        !acceptsNativeLayer(((id<CAMetalDrawable>)drawable).layer)) return false;
    const bool explicitFrame=nativeLayer(((id<CAMetalDrawable>)drawable).layer)!=nil;
    if(!explicitFrame&&macfx::graphicsRequested()&&!macfx::effectRequested()) {
        const auto presentation=macfx::metalPresentation(((id<CAMetalDrawable>)drawable).layer);
        if(!presentation||presentation->snapshot().stopped)return false;
    }
    if(!explicitFrame&&!macfx::effectRequested()&&!macfx::graphicsRequested())return false;
    scheduledContext->pending.push_back({drawable,selector,time});
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
           std::none_of(context->pending.begin(),context->pending.end(),[](const auto &pending){return nativeLayer(((id<CAMetalDrawable>)pending.drawable).layer)!=nil;})) {
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
        for(const auto &pending:context->pending) process(effects,pending.drawable,"effects");
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
void signalMetal4Drawable(id object,SEL selector,id<MTLDrawable> drawable) {
    auto forward=reinterpret_cast<void(*)(id,SEL,id<MTLDrawable>)>(original(object,selector));
    if(![drawable conformsToProtocol:@protocol(CAMetalDrawable)]) {forward(object,selector,drawable);return;}
    id<CAMetalDrawable> metal=(id<CAMetalDrawable>)drawable;
    const bool explicitFrame=nativeLayer(metal.layer)!=nil;
    if((!explicitFrame&&!macfx::effectRequested()&&!macfx::graphicsRequested())||macfx::ownsPresentation(metal.layer) || !acceptsNativeLayer(metal.layer) || objc_getAssociatedObject(drawable,&nativePresentationKey)) {forward(object,selector,drawable);return;}
    if(!explicitFrame&&!macfx::effectRequested()) {
        const auto presentation=macfx::metalPresentation(metal.layer);
        if(!presentation||presentation->snapshot().stopped){forward(object,selector,drawable);return;}
    }
    id<MTL4CommandQueue> producerQueue=object;
    RSMMetal4Bridge *state;
    @synchronized(object) {
        state=objc_getAssociatedObject(object,&metal4BridgeKey);
        if(!state) {
            state=[RSMMetal4Bridge new];state->failed.store(false);
            state->effects=[producerQueue.device newCommandQueue];
            state->producer=[producerQueue.device newSharedEvent];
            state->finished=[producerQueue.device newSharedEvent];
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
    process(effects,drawable,"metal4-effects-and-producer-dependency");
    [effects encodeSignalEvent:state->finished value:value];
    [effects addCompletedHandler:^(id<MTLCommandBuffer> completed) {
        if(completed.status!=MTLCommandBufferStatusCompleted) {
            state->failed.store(true);
            // A failed GPU buffer may not execute its signal command. Release
            // only this queue's effect fence so the application cannot stall.
            if(state->finished.signaledValue<value)state->finished.signaledValue=value;
            log("Metal 4 effect queue disabled after GPU failure");
        }
    }];
    macfx::ownPresentationBuffer(effects);
    claimNativePresentation(drawable);
    [producerQueue signalEvent:state->producer value:value];
    [effects commit];
    [producerQueue waitForEvent:state->finished value:value];
    forward(object,selector,drawable);
}
API_AVAILABLE(macos(26.0))
void hookMetal4Queue(id<MTL4CommandQueue> queue) {
    if(queue) replace(object_getClass(queue),@selector(signalDrawable:),reinterpret_cast<IMP>(signalMetal4Drawable));
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
void installMetalDeviceHooks(id<MTLDevice> device);
id<CAMetalDrawable> nextDrawable(id object,SEL selector) {
    if(macfx::ownsPresentation(object)||(explicitHost()&&!nativeLayer(object))) return reinterpret_cast<id<CAMetalDrawable>(*)(id,SEL)>(original(object,selector))(object,selector);
    if(!macfx::effectRequested())if(auto history=nativeHistory(object,false))history->images.reset();
    const auto activePresentation=macfx::metalPresentation((CAMetalLayer*)object);
    const bool readsSource=activePresentation&&!activePresentation->snapshot().stopped;
    bool source=false;try{source=macfx::drawableResolutionRequested();}catch(...){}
    if(!nativeLayer(object)&&!macfx::imageProcessingRequested(readsSource)&&!source&&!macfx::virtualWindowEnabled()&&!macfx::timingEnabled())
        return reinterpret_cast<id<CAMetalDrawable>(*)(id,SEL)>(original(object,selector))(object,selector);
    installMetalDeviceHooks(((CAMetalLayer*)object).device);
    if(!explicitHost())macfx::acceptsLayer(object);
    // A cooperating publisher may opt in to a reduced drawable. Other engines
    // retain their own final allocation and resize through their renderer API.
    if(!explicitHost())sizeForResolution((CAMetalLayer*)object,CGSizeZero,false);
    // The RGBA8 attachment-fetch adapter preserves the producer's framebuffer-
    // only contract (which SpriteKit uses for its Y convention). Other formats
    // need a sampleable drawable even on devices supporting attachment fetch.
    CAMetalLayer *layer=(CAMetalLayer*)object;
    if(nativeLayer(object)||(macfx::imageProcessingRequested(readsSource)&&
       !macfx::nativeMetalSourceReadable(layer.pixelFormat,layer.framebufferOnly,
           macfx::framebuffer::supported(layer.device))))[layer setFramebufferOnly:NO];
    id<CAMetalDrawable> drawable;
    {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalDrawable);drawable=reinterpret_cast<id<CAMetalDrawable>(*)(id,SEL)>(original(object,selector))(object,selector);}
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
void replace(Class cls,SEL selector,IMP hook) {
    std::lock_guard<std::mutex> guard(hookMutex());
    Method method=class_getInstanceMethod(cls,selector); if(!method) return;
    IMP old=method_getImplementation(method); if(old==hook) return;
    originals()[{cls,selector}]=old;
    if(!class_addMethod(cls,selector,hook,method_getTypeEncoding(method))) method_setImplementation(class_getInstanceMethod(cls,selector),hook);
}
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
    if(const char *explicitHost=std::getenv("RESHADE_EXPLICIT_HOST");explicitHost && std::string(explicitHost)=="1") return;
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::Hooks,1);
    if(!macfx::liveEffects() && !macfx::effectRequested() && !macfx::timingEnabled() && !macfx::graphicsRequested()) return;
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
    if(runtime.failed || !queue) return false;
    try {
        auto *descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:width height:height mipmapped:NO];
        descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;
        descriptor.storageMode=MTLStorageModeShared;
        auto image=[device newTextureWithDescriptor:descriptor];
        if(!image)throw std::runtime_error("Cannot allocate an RGBA compatibility image");
        [image replaceRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0 withBytes:bytes bytesPerRow:width*4];
        auto buffer=[queue commandBuffer];if(!buffer)throw std::runtime_error("Cannot allocate RGBA compatibility commands");runtime.render(buffer,image);
        macfx::observeTiming(buffer,"probe-effects",width,height);
        macfx::CommandDeadline completed(buffer,macfx::CommandDeadline::Milestone::Completed);
        [buffer commit];if(!completed.wait())throw std::runtime_error("RGBA processing exceeded its compatibility wait; the original image is retained");
        if(buffer.status!=MTLCommandBufferStatusCompleted) throw std::runtime_error(buffer.error.localizedDescription.UTF8String?:"Metal GPU error");
        [image getBytes:bytes bytesPerRow:width*4 fromRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0];
        return true;
    } catch(const SpatialBusy &) { return false; }
      catch(const std::exception &error) { runtime.failed=true; log("OpenGL to Metal effect disabled: "+std::string(error.what())); return false; }
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
    if(runtime.failed) return nullptr;
    auto &pool=surfacePools()[owner];
    if(pool.w!=source.width || pool.h!=source.height || pool.format!=IOSurfaceGetPixelFormat(surface)) {
        pool.clear();pool.w=source.width;pool.h=source.height;pool.format=IOSurfaceGetPixelFormat(surface);
    }
    try {
    IOSurfaceRef output=nullptr;
    if(pool.surfaces.size()>=3) {
        for(unsigned i=0;i<pool.surfaces.size();++i) {
            unsigned index=(pool.cursor+i)%pool.surfaces.size();
            if(!IOSurfaceIsInUse(pool.surfaces[index])) {output=pool.surfaces[index];pool.cursor=(index+1)%pool.surfaces.size();break;}
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
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalCommit);[buffer commit];}
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalEffectWait,reinterpret_cast<uintptr_t>(owner),pool.w,pool.h);
         if(!completed.wait())throw std::runtime_error("Window surface processing did not complete within its compatibility wait; original rendering is retained");}
        return (IOSurfaceRef)CFRetain(output);
    } catch(const SpatialBusy &){return nullptr;}
      catch(const macfx::ImageBudgetExceeded &){return nullptr;}
      catch(const std::exception &error) { runtime.failed=true;log("Window surface effect disabled: "+std::string(error.what()));return nullptr; }
    }catch(const macfx::ImageBudgetExceeded&){return nullptr;}
}}

extern "C" IOSurfaceRef rsFilterWindowSurface(void *owner,IOSurfaceRef surface) {
    return filterSurface(owner,surface,"surface-copy-and-effects",SurfaceSource::Window);
}
extern "C" IOSurfaceRef rsFilterOpenGLSurface(void *owner,IOSurfaceRef surface) {
    return filterSurface(owner,surface,"legacy-surface-copy-and-effects",SurfaceSource::CompletedOpenGL);
}

macfx::FrameResult macfx::processFrameWithDepth(void *owner,id<MTLCommandBuffer> commands,const SpatialFrame &frame,SpatialMethod method,const DepthFrame *depth,bool opaqueDisplay,const FrameEncodingInputs*strict,FrameEncodingReceipt*receipt) { @autoreleasepool {
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
        if(result.effects) {runtime.render(commands,frame.source,frame.output,method,frame.frameId,frame.color,frame.origin,depth,nullptr,opaqueDisplay,strict,receipt);if(result.scaled)result.scaling=runtime.lastScaling;}
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
    } catch(const SpatialBusy &error) {result.busy=true;result.scaling=runtime.lastScaling;result.reason=error.what();}
    catch(const ImageBudgetExceeded &error) {result.busy=true;result.reason=error.what();}
    catch(const HeldInputMismatch &error) {result.reason=error.what();}
    catch(const PlacementUnavailable &error) {result.reason=error.what();}
    catch(const std::exception &error) {runtime.w=runtime.h=0;result.reason=error.what();} }
    @catch(NSException *error) {runtime.w=runtime.h=0;result.reason=error.reason.UTF8String?:"Frame processing failed";}
    if(!result.encoded&&receipt)*receipt={};return result;
}}
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
    Runtime runtime;
    std::mutex lock;
public:
    explicit ShaderRuntimeNode(const ShaderSpec &spec){runtime.fixedSelection=spec.selection;runtime.fixedParameters=spec.parameters;}
    void setParameters(const ShaderParameters &parameters) override {
        std::lock_guard<std::mutex> guard(lock);
        if(runtime.fixedParameters!=parameters){runtime.fixedParameters=parameters;++runtime.parameterGeneration;}
    }
    ShaderResult prepare(const ShaderFrame &frame) override { @autoreleasepool {
        if(!frame.commands||!frame.source||!frame.target)return {false,"Shader preparation requires the real queue and image extent"};
        std::lock_guard<std::mutex> guard(lock);
        try {
            if(runtime.w!=frame.source.width||runtime.h!=frame.source.height||runtime.colorFormat!=frame.source.pixelFormat||runtime.workingDevice!=frame.commands.device||runtime.processingQueue!=frame.commands.commandQueue){
                Runtime next;next.fixedSelection=runtime.fixedSelection;next.fixedParameters=runtime.fixedParameters;next.parameterGeneration=runtime.parameterGeneration;
                next.init(frame.commands.device,frame.source,false,frame.commands.commandQueue);runtime=std::move(next);
            }
            if(runtime.needsDepth&&!frame.depth)return {false,"The selected shader requires depth from this frame"};
            return {true,{}};
        }catch(const std::exception &error){return {false,error.what()};}
    }}
    ShaderResult encode(const ShaderFrame &frame) override { @autoreleasepool {
        if(!frame.commands||!frame.source||!frame.target)return {false,"Shader stage requires its command buffer, source and target"};
        if(frame.commands.status>=MTLCommandBufferStatusCommitted)return {false,"Shader stage command buffer is already submitted"};
        if(frame.source.device!=frame.commands.device||frame.target.device!=frame.commands.device)
            return {false,"Shader stage images must use the command buffer device"};
        if(frame.source.framebufferOnly||frame.target.framebufferOnly||frame.source.textureType!=MTLTextureType2D||frame.target.textureType!=MTLTextureType2D||frame.source.sampleCount!=1||frame.target.sampleCount!=1)
            return {false,"Shader stage requires accessible, resolved 2D images"};
        std::lock_guard<std::mutex> guard(lock);
        try {
            runtime.render(frame.commands,frame.source,frame.target,SpatialMethod::Bilinear,frame.frameId,frame.color,frame.origin,frame.depth,&frame);
            return {true,{}};
        }catch(const borrowed::Busy &error){return {false,error.what(),true};}
        catch(const SpatialBusy &error){return {false,error.what(),true};}
        catch(const std::exception &error){return {false,error.what()};}
    }}
};
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

static int processFrameAPI(const RSFrameRequest *request,const RSFrameDepth *depth,RSFrameResult *result) {
    if(!request || !result || request->size<sizeof(RSFrameRequest) || result->size<sizeof(RSFrameResult) || request->version!=RS_FRAME_ABI_VERSION || result->version!=RS_FRAME_ABI_VERSION) return RS_FRAME_INVALID_ARGUMENT;
    const uint32_t size=result->size;*result={};result->size=size;result->version=RS_FRAME_ABI_VERSION;result->frameId=request->frameId;
    if(request->method>RS_FRAME_BICUBIC || request->color>RS_FRAME_LINEAR || request->origin>RS_FRAME_BOTTOM_LEFT) {std::strncpy(result->reason,"Unsupported frame method, colour mode or origin",sizeof(result->reason)-1);return RS_FRAME_INVALID_ARGUMENT;}
    try { @try {
        macfx::SpatialFrame frame{(__bridge id<MTLTexture>)request->sourceTexture,(__bridge id<MTLTexture>)request->outputTexture,request->frameId,static_cast<macfx::SpatialColor>(request->color),static_cast<macfx::FrameOrigin>(request->origin)};
        const macfx::DepthFrame captured{depth?(__bridge id<MTLTexture>)depth->texture:nil,depth?depth->frameId:0,depth?static_cast<macfx::FrameOrigin>(depth->origin):macfx::FrameOrigin::TopLeft};
        auto value=macfx::processFrameWithDepth(request->owner,(__bridge id<MTLCommandBuffer>)request->commandBuffer,frame,static_cast<macfx::SpatialMethod>(request->method),depth?&captured:nullptr);
        result->encoded=value.encoded;result->effects=value.effects;result->scaled=value.scaled;result->activeMethod=value.scaled?static_cast<uint32_t>(value.scaling.active):request->method;
        result->inputWidth=frame.source.width;result->inputHeight=frame.source.height;result->outputWidth=frame.output.width;result->outputHeight=frame.output.height;
        const auto &reason=value.reason.empty()?value.scaling.reason:value.reason;std::strncpy(result->reason,reason.c_str(),sizeof(result->reason)-1);
        return value.encoded?RS_FRAME_OK:value.busy?RS_FRAME_BUSY:RS_FRAME_ENCODE_FAILED;
    } @catch(NSException *error) {std::strncpy(result->reason,error.reason.UTF8String?:"Frame processing failed",sizeof(result->reason)-1);} }
    catch(const std::exception &error) {std::strncpy(result->reason,error.what(),sizeof(result->reason)-1);}
    catch(...) {std::strncpy(result->reason,"Frame processing failed",sizeof(result->reason)-1);}
    return RS_FRAME_ENCODE_FAILED;
}

macfx::FrameResult macfx::processFrame(void *owner,id<MTLCommandBuffer> commands,const SpatialFrame &frame,SpatialMethod method){return processFrameWithDepth(owner,commands,frame,method,nullptr);}
bool macfx::frameRequiresDepth(void *owner,id<MTLDevice> device,unsigned width,unsigned height){
    if(!macfx::effectRequested())return false;
    if(!owner||!device||!width||!height||width>16384||height>16384)throw std::runtime_error("Invalid frame dimensions or owner");
    bool acceptedDepth=false;
    if(macfx::effectPlanRequested()){
        // Map lookups do not message or dereference the opaque owner. Release
        // their lock before taking a presenter lock, then the runtime lock.
        auto presentation=macfx::viewPresentationForOwner(owner);
        acceptedDepth=presentation&&presentation->requiresDepth();
    }
    std::lock_guard<std::mutex> guard(mutex());auto &runtime=runtimes()[owner];runtime.statusContext=reinterpret_cast<uintptr_t>(owner);
    if(macfx::effectPlanRequested()){
        if(!runtime.plan)runtime.plan=std::make_shared<macfx::EffectPlanExecutor>();
        runtime.plan->setStatusContext(runtime.statusContext);
        return acceptedDepth||runtime.plan->requiresDepth();
    }
    if(runtime.selection.revision!=macfx::effectSelection().revision){Runtime next;next.prepare(width,height);return next.needsDepth;}
    return runtime.needsDepth;
}
extern "C" int rsProcessFrame(const RSFrameRequest *request,RSFrameResult *result){return processFrameAPI(request,nullptr,result);}
extern "C" int rsProcessFrameWithDepth(const RSFrameRequest *request,const RSFrameDepth *depth,RSFrameResult *result){if(!depth||depth->size<sizeof(*depth)||depth->version!=RS_DEPTH_ABI_VERSION||depth->reserved||depth->origin>RS_FRAME_BOTTOM_LEFT||!depth->texture)return RS_FRAME_INVALID_ARGUMENT;return processFrameAPI(request,depth,result);}
