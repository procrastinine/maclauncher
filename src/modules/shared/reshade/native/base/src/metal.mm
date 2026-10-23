#include "log.hpp"
#include "presentation-internal.hpp"
#include "effect.hpp"
#include "frame.hpp"
#include "frame.h"
#include "graphics.hpp"
#include "view-presentation.hpp"
#include "layer-presentation.hpp"
#include "window.hpp"
#include "timing.hpp"
#include "diagnostics.hpp"
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#import <objc/runtime.h>
#include <chrono>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <cstring>
#include <atomic>
#include <set>
#include "command-resources.hpp"
#include <unistd.h>
#import <IOSurface/IOSurface.h>

// Queue-local synchronization owns no reference back to the intercepted queue.

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

@interface RSMScheduledEffects : NSObject {
@public
    id<MTLCommandQueue> queue;
    std::atomic<unsigned> pending;
}
@end
@implementation RSMScheduledEffects
@end

namespace {
void log(const std::string &message) {macfx::nativeLog(message);}
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
        default:throw std::runtime_error("Unsupported Metal texture format");
    }
}
id<MTLTexture> texture(id<MTLDevice> device,unsigned w,unsigned h,MTLPixelFormat pixelFormat,unsigned levels=1) {
    auto *descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:pixelFormat width:w height:h mipmapped:NO];
    descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget|MTLTextureUsagePixelFormatView;
    descriptor.mipmapLevelCount=levels;
    descriptor.storageMode=MTLStorageModePrivate;
    id<MTLTexture> result=[device newTextureWithDescriptor:descriptor];
    if(!result) throw std::runtime_error("Cannot allocate an effect texture");
    return result;
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
struct Pass { reshadefx::pass metadata; id<MTLRenderPipelineState> pipeline; };
struct SpatialBusy final : std::runtime_error { using std::runtime_error::runtime_error; };
struct Runtime {
    std::shared_ptr<macfx::borrowed::Owner> borrowedOwner;
    macfx::Effect effect; unsigned w=0,h=0; MTLPixelFormat colorFormat=MTLPixelFormatInvalid;
    id<MTLTexture> colors[2]; std::map<std::string,id<MTLTexture>> textures;
    std::vector<id<MTLSamplerState>> samplers; std::vector<Pass> passes; std::set<std::string> initializedTextures;
    bool failed=false, captureFlipY=false; uint64_t frames=0;
    std::unique_ptr<macfx::SpatialEncoder> spatial; id<MTLDevice> spatialDevice=nil;
    macfx::SpatialStatus lastScaling;
    macfx::SpatialStatus scale(id<MTLCommandBuffer> commands,const macfx::SpatialFrame &frame,macfx::SpatialMethod method) {
        if(!spatial || spatialDevice!=commands.device) {spatial=std::make_unique<macfx::SpatialEncoder>(commands.device);spatialDevice=commands.device;}
        return lastScaling=spatial->encode(commands,frame,method);
    }
    std::chrono::steady_clock::time_point started=std::chrono::steady_clock::now(),lastFrame=started;
    void init(id<MTLDevice> device,id<MTLTexture> target) {
        w=target.width; h=target.height; colorFormat=target.pixelFormat;
        if(colorFormat!=MTLPixelFormatBGRA8Unorm && colorFormat!=MTLPixelFormatRGBA8Unorm)
            throw std::runtime_error("Metal drawable format is not supported yet");
        const char *fx=std::getenv("RESHADE_EFFECT");
        effect=macfx::compile(fx,w,h,410,macfx::includePaths());
        textures.clear(); samplers.clear(); passes.clear(); initializedTextures.clear();
        colors[0]=texture(device,w,h,colorFormat); colors[1]=texture(device,w,h,colorFormat);
        for(const auto &t:effect.module.textures) if(t.semantic.empty()) {
            if(t.type!=reshadefx::texture_type::texture_2d || t.storage_access)
                throw std::runtime_error("Only sampled 2D textures are supported");
            for(const auto &a:t.annotations) if(a.name=="source") throw std::runtime_error("External texture loading is not supported yet");
            textures[t.unique_name]=texture(device,t.width,t.height,format(t.format),t.levels);
        }
        for(const auto &s:effect.module.samplers) {
            auto *d=[MTLSamplerDescriptor new]; unsigned filter=static_cast<unsigned>(s.filter);
            d.minFilter=(filter&0x10)?MTLSamplerMinMagFilterLinear:MTLSamplerMinMagFilterNearest;
            d.magFilter=(filter&4)?MTLSamplerMinMagFilterLinear:MTLSamplerMinMagFilterNearest;
            d.sAddressMode=address(s.address_u); d.tAddressMode=address(s.address_v);
            samplers.push_back([device newSamplerStateWithDescriptor:d]);
        }
        std::map<std::string,id<MTLFunction>> functions;
        const char *selected=std::getenv("RESHADE_TECHNIQUE");
        for(const auto &tech:effect.module.techniques) {
            if(selected && tech.name!=selected) continue;
            if(!selected && !passes.empty()) break;
            for(const auto &p:tech.passes) {
                if(!p.cs_entry_point.empty() || p.stencil_enable || !p.render_target_names[1].empty()
                    || p.topology!=reshadefx::primitive_topology::triangle_list)
                    throw std::runtime_error("This technique requires unsupported render state");
                for(const auto &binding:p.texture_bindings) {
                    
                    const auto &s=effect.module.samplers.at(binding.index);
                    for(const auto &t:effect.module.textures) if(t.unique_name==s.texture_name && t.semantic=="DEPTH")
                        throw std::runtime_error("Scene depth capture is not implemented yet");
                }
                for(const auto &entry:{p.vs_entry_point,p.ps_entry_point}) if(!functions.count(entry)) {
                    const auto &shader=effect.shaders.at(entry); NSError *error=nil;
                    id<MTLLibrary> library=[device newLibraryWithSource:@(shader.msl.c_str()) options:nil error:&error];
                    if(!library) throw std::runtime_error(error.localizedDescription.UTF8String);
                    id<MTLFunction> function=[library newFunctionWithName:@(shader.mslEntry.c_str())];
                    if(!function) throw std::runtime_error("Metal entry point is missing");
                    functions[entry]=function;
                }
                auto *d=[MTLRenderPipelineDescriptor new]; d.vertexFunction=functions.at(p.vs_entry_point); d.fragmentFunction=functions.at(p.ps_entry_point);
                auto *attachment=d.colorAttachments[0];
                attachment.pixelFormat=p.render_target_names[0].empty()?colorFormat:textures.at(p.render_target_names[0]).pixelFormat;
                if(p.srgb_write_enable) attachment.pixelFormat=srgbFormat(attachment.pixelFormat);
                const unsigned mask=p.render_target_write_mask[0];
                attachment.writeMask=static_cast<MTLColorWriteMask>((mask&1?MTLColorWriteMaskRed:0) | (mask&2?MTLColorWriteMaskGreen:0) |
                    (mask&4?MTLColorWriteMaskBlue:0) | (mask&8?MTLColorWriteMaskAlpha:0));
                if(p.blend_enable[0]) {
                    attachment.blendingEnabled=YES;
                    attachment.sourceRGBBlendFactor=blendFactor(p.source_color_blend_factor[0]);
                    attachment.destinationRGBBlendFactor=blendFactor(p.dest_color_blend_factor[0]);
                    attachment.rgbBlendOperation=blendOp(p.color_blend_op[0]);
                    attachment.sourceAlphaBlendFactor=blendFactor(p.source_alpha_blend_factor[0]);
                    attachment.destinationAlphaBlendFactor=blendFactor(p.dest_alpha_blend_factor[0]);
                    attachment.alphaBlendOperation=blendOp(p.alpha_blend_op[0]);
                }
                const unsigned components=effect.shaders.at(p.ps_entry_point).colorComponents;
                attachment.writeMask=static_cast<MTLColorWriteMask>(attachment.writeMask & (MTLColorWriteMaskRed |
                    (components>1?MTLColorWriteMaskGreen:0) | (components>2?MTLColorWriteMaskBlue:0) | (components>3?MTLColorWriteMaskAlpha:0)));
                NSError *error=nil; auto pipeline=[device newRenderPipelineStateWithDescriptor:d error:&error];
                if(!pipeline) throw std::runtime_error(error.localizedDescription.UTF8String);
                passes.push_back({p,pipeline});
            }
        }
        if(passes.empty()) throw std::runtime_error("No matching graphics technique");
        log("Metal effect ready: "+std::string(fx)+" "+std::to_string(w)+"x"+std::to_string(h)+" passes="+std::to_string(passes.size()));
    }
    id<MTLTexture> resolve(const std::string &name,unsigned current) {
        auto t=textures.find(name); if(t!=textures.end()) return t->second;
        for(const auto &meta:effect.module.textures) if(meta.unique_name==name && meta.semantic=="COLOR") return colors[current];
        throw std::runtime_error("Unsupported texture semantic: "+name);
    }
    void render(id<MTLCommandBuffer> buffer,id<MTLTexture> target) {render(buffer,target,target,macfx::SpatialMethod::Bilinear);}
    void render(id<MTLCommandBuffer> buffer,id<MTLTexture> source,id<MTLTexture> target,macfx::SpatialMethod method=macfx::SpatialMethod::Bilinear,uint64_t frameId=0,macfx::SpatialColor color=macfx::SpatialColor::Perceptual,macfx::FrameOrigin origin=macfx::FrameOrigin::TopLeft) {
        auto lease=macfx::borrowed::acquire(buffer,borrowedOwner);
        macfx::borrowed::EmptyEncoding pending{lease};
        if(lease){lease->hold(source);lease->hold(target);}

        if(w!=source.width || h!=source.height || colorFormat!=source.pixelFormat) init(buffer.device,source);
        if(lease)lease->hold(colors[0]);
        pending.started=true;
        auto input=[buffer blitCommandEncoder];
        [input copyFromTexture:source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toTexture:colors[0] destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
        [input endEncoding]; unsigned current=0;
        const auto now=std::chrono::steady_clock::now();
        const float frameTime=frames?std::chrono::duration<float,std::milli>(now-lastFrame).count():16.666667f;lastFrame=now;
        std::vector<unsigned char> values=effect.uniforms;
        for(const auto &u:effect.module.uniforms) for(const auto &a:u.annotations) if(a.name=="source") {
            if(a.value.string_data=="timer") { float ms=std::chrono::duration<float,std::milli>(std::chrono::steady_clock::now()-started).count(); std::memcpy(values.data()+u.offset,&ms,4); }
            else if(a.value.string_data=="frametime") std::memcpy(values.data()+u.offset,&frameTime,4);
            else if(a.value.string_data=="framecount") { uint32_t n=frames; std::memcpy(values.data()+u.offset,&n,4); }
            else throw std::runtime_error("Unsupported uniform source: "+a.value.string_data);
        }
        id<MTLBuffer> capturedInput=nil;
        const char *capture=std::getenv("RESHADE_CAPTURE_PREFIX");
        const char *captureAt=std::getenv("RESHADE_CAPTURE_FRAME");
        const char *captureTrigger=std::getenv("RESHADE_CAPTURE_TRIGGER");
        bool captureFrame=capture && (captureTrigger?unlink(captureTrigger)==0:
            frames+1==(captureAt?std::strtoull(captureAt,nullptr,10):120));
        unsigned stride=(w*4+255)&~255u;
        if(captureFrame) {
            capturedInput=[buffer.device newBufferWithLength:stride*h options:MTLResourceStorageModeShared];
            auto encoder=[buffer blitCommandEncoder];
            [encoder copyFromTexture:colors[0] sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toBuffer:capturedInput destinationOffset:0 destinationBytesPerRow:stride destinationBytesPerImage:stride*h];
            [encoder endEncoding];
        }
        for(const auto &pass:passes) {
            const auto &p=pass.metadata; bool back=p.render_target_names[0].empty();
            id<MTLTexture> output=back?colors[1-current]:textures.at(p.render_target_names[0]);
            if(lease){lease->hold(output);lease->hold(pass.pipeline);}
            if(back) {
                auto copy=[buffer blitCommandEncoder];
                [copy copyFromTexture:colors[current] sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toTexture:output destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
                [copy endEncoding];
            }
            auto *d=[MTLRenderPassDescriptor renderPassDescriptor]; d.colorAttachments[0].texture=p.srgb_write_enable?[output newTextureViewWithPixelFormat:srgbFormat(output.pixelFormat)]:output;
            if(lease)lease->hold(d.colorAttachments[0].texture);
            d.colorAttachments[0].loadAction=p.clear_render_targets?MTLLoadActionClear:MTLLoadActionLoad;
            if(!back && initializedTextures.insert(p.render_target_names[0]).second) { d.colorAttachments[0].loadAction=MTLLoadActionClear; d.colorAttachments[0].clearColor=MTLClearColorMake(0,0,0,1); }
            d.colorAttachments[0].storeAction=MTLStoreActionStore;
            auto encoder=[buffer renderCommandEncoderWithDescriptor:d]; [encoder setRenderPipelineState:pass.pipeline];
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
            }
            [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:p.num_vertices]; [encoder endEncoding];
            if(p.generate_mipmaps && output.mipmapLevelCount>1) {
                auto mipmaps=[buffer blitCommandEncoder];[mipmaps generateMipmapsForTexture:output];[mipmaps endEncoding];
            }
            if(back) current=1-current;
        }
        const bool scaling=source.width!=target.width || source.height!=target.height || source.pixelFormat!=target.pixelFormat;
        if(scaling) {
            auto status=scale(buffer,{colors[current],target,frameId,color},method);
            if(!status.encoded) {if(status.busy)throw SpatialBusy(status.reason);throw std::runtime_error(status.reason);}
        }
        auto output=(!scaling || captureFrame)?[buffer blitCommandEncoder]:nil;
        if(!scaling) [output copyFromTexture:colors[current] sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toTexture:target destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];
        id<MTLBuffer> capturedOutput=nil;
        if(captureFrame) {
            capturedOutput=[buffer.device newBufferWithLength:stride*h options:MTLResourceStorageModeShared];
            [output copyFromTexture:colors[current] sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(w,h,1) toBuffer:capturedOutput destinationOffset:0 destinationBytesPerRow:stride destinationBytesPerImage:stride*h];
        }
        [output endEncoding];
        if(captureFrame) {
            std::string prefix=capture; unsigned width=w,height=h; bool bgra=colorFormat==MTLPixelFormatBGRA8Unorm,flip=captureFlipY;
            [buffer addCompletedHandler:^(id<MTLCommandBuffer> b) { @autoreleasepool {
                if(b.status==MTLCommandBufferStatusCompleted) {
                    try {
                        savePNG(prefix+"-before.png",capturedInput.contents,width,height,bgra,flip,stride);
                        savePNG(prefix+"-after.png",capturedOutput.contents,width,height,bgra,flip,stride);
                        log("Metal frame capture saved: "+prefix);
                    } catch(const std::exception &error) { log(error.what()); }
                } else log("Metal GPU error: "+std::string(b.error.localizedDescription.UTF8String?:"unknown"));
            }}];
        }
        ++frames; if(frames==1 || frames==120) log("Metal effect frame="+std::to_string(frames));
    }
};
std::mutex &mutex() { static auto *m=new std::mutex; return *m; }
std::map<void*,Runtime> &runtimes() { static auto *m=new std::map<void*,Runtime>; return *m; }
std::mutex &bridgeMutex() { static auto *m=new std::mutex;return *m; }
std::map<void*,Runtime> &bridgeRuntimes() {static auto *m=new std::map<void*,Runtime>;return *m;}
struct SurfacePool {
    unsigned w=0,h=0,cursor=0;OSType format=0;std::vector<IOSurfaceRef> surfaces;
    void clear(){for(auto surface:surfaces)CFRelease(surface);surfaces.clear();cursor=0;}
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
void process(id<MTLCommandBuffer> buffer,id<MTLDrawable> drawable,const char *timingScope="game-and-effects") {
    if(![drawable conformsToProtocol:@protocol(CAMetalDrawable)]) return;
    id<CAMetalDrawable> metal=(id<CAMetalDrawable>)drawable;
    if(macfx::ownsPresentation(metal.layer)) return;
    macfx::DiagnosticScope frame(macfx::DiagnosticStage::MetalFrame,reinterpret_cast<uintptr_t>((__bridge void *)metal.layer));
    bool accepted;{macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalOwnership);accepted=macfx::acceptsLayer(metal.layer);}
    if(!accepted) return;
    if(auto presentation=macfx::metalPresentation(metal.layer);presentation&&!presentation->snapshot().stopped) {
        @try {try {
            id<MTLTexture> source=metal.texture;
            if(source.pixelFormat==MTLPixelFormatBGRA8Unorm_sRGB||source.pixelFormat==MTLPixelFormatRGBA8Unorm_sRGB)
                source=[source newTextureViewWithPixelFormat:source.pixelFormat==MTLPixelFormatBGRA8Unorm_sRGB?MTLPixelFormatBGRA8Unorm:MTLPixelFormatRGBA8Unorm];
            if(!source)throw std::runtime_error("Cannot read the game presentation texture");
            auto result=presentation->submit(buffer,source,0,CACurrentMediaTime());
            if(result.encoded){macfx::observeTiming(buffer,timingScope,source.width,source.height);return;}
            if(result.busy)return;
            presentation->stop();log("Graphics presentation disabled: "+result.reason);
        }catch(const std::exception&error){presentation->stop();log("Graphics presentation disabled: "+std::string(error.what()));}}
        @catch(NSException*error){presentation->stop();log("Graphics presentation disabled: "+std::string(error.reason.UTF8String?:"Presentation failed"));}
    }
    if(!std::getenv("RESHADE_EFFECT")) {
        macfx::observeTiming(buffer,"game",metal.texture.width,metal.texture.height);
        return;
    }
    std::unique_lock<std::mutex> guard(mutex(),std::defer_lock);
    {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalRuntimeLock);guard.lock();}
    auto &runtime=runtimes()[(__bridge void*)metal.layer];
    if(runtime.failed) return;
    @try { try {
        id<MTLTexture> target=metal.texture;
        if(target.framebufferOnly) throw std::runtime_error("Drawable is framebuffer-only");
        if(target.pixelFormat==MTLPixelFormatBGRA8Unorm_sRGB || target.pixelFormat==MTLPixelFormatRGBA8Unorm_sRGB) {
            target=[target newTextureViewWithPixelFormat:target.pixelFormat==MTLPixelFormatBGRA8Unorm_sRGB?MTLPixelFormatBGRA8Unorm:MTLPixelFormatRGBA8Unorm];
            if(!target) throw std::runtime_error("Cannot create an sRGB drawable view");
        }
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalEncode,0,target.width,target.height);runtime.render(buffer,target);}
        macfx::observeTiming(buffer,timingScope,target.width,target.height);
    }
        catch(const macfx::borrowed::Busy &) { return; }
        catch(const std::exception &error) { runtime.failed=true; log("Metal effect disabled: "+std::string(error.what())); } }
    @catch(NSException *error) { runtime.failed=true; log("Metal effect disabled: "+std::string(error.reason.UTF8String)); }
}
thread_local bool encodingEffects=false;
std::mutex &queueMutex() { static auto *m=new std::mutex; return *m; }
id<MTLCommandBuffer> __weak &lastGameBuffer() { static __weak id<MTLCommandBuffer> buffer=nil; return buffer; }
void commit(id object,SEL selector) {
    static std::atomic<unsigned> calls{0};
    if(std::getenv("RESHADE_TRACE") && calls.fetch_add(1)==0) log("Metal commit: "+std::string(object_getClassName(object)));
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
void present(id object,SEL selector,id<MTLDrawable> drawable) {
    if(claimNativePresentation(drawable)) process(object,drawable); reinterpret_cast<void(*)(id,SEL,id<MTLDrawable>)>(original(object,selector))(object,selector,drawable);
}
void presentTime(id object,SEL selector,id<MTLDrawable> drawable,CFTimeInterval time) {
    if(claimNativePresentation(drawable)) process(object,drawable); reinterpret_cast<void(*)(id,SEL,id<MTLDrawable>,CFTimeInterval)>(original(object,selector))(object,selector,drawable,time);
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
        !macfx::acceptsLayer(((id<CAMetalDrawable>)drawable).layer)) return false;
    if(macfx::graphicsRequested()&&!std::getenv("RESHADE_EFFECT")) {
        const auto presentation=macfx::metalPresentation(((id<CAMetalDrawable>)drawable).layer);
        if(!presentation||presentation->snapshot().stopped)return false;
    }
    scheduledContext->pending.push_back({drawable,selector,time});
    return std::getenv("RESHADE_EFFECT")!=nullptr || macfx::graphicsRequested();
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
    if(encodingEffects || macfx::ownsPresentationBuffer(object)) { add(object,selector,handler); return; }
    auto context=std::make_shared<ScheduledContext>();
    [object addCompletedHandler:^(id<MTLCommandBuffer> game) { @autoreleasepool {
        if(context->pending.empty()) return;
        if(macfx::timingEnabled()) {
            id<CAMetalDrawable> drawable=(id<CAMetalDrawable>)context->pending.front().drawable;
            macfx::recordTiming(game,"game",drawable.texture.width,drawable.texture.height);
        }
        if(!std::getenv("RESHADE_EFFECT")&&!macfx::graphicsRequested()) return;
        if(game.status!=MTLCommandBufferStatusCompleted) {
            for(const auto &pending:context->pending) finishPresent(pending);
            return;
        }
        auto state=scheduledEffects(game.commandQueue);
        auto count=state->pending.load();
        while(count<8 && !state->pending.compare_exchange_weak(count,count+1)) {}
        if(count>=8 || !state->queue) {
            if(count<8)state->pending.fetch_sub(1);
            for(const auto &pending:context->pending) finishPresent(pending);
            return;
        }
        id<MTLCommandBuffer> effects;
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalQueue);effects=[state->queue commandBuffer];}
        if(!effects) {
            state->pending.fetch_sub(1);
            for(const auto &pending:context->pending) finishPresent(pending);
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
    if((!std::getenv("RESHADE_EFFECT")&&!macfx::graphicsRequested()) || ![drawable conformsToProtocol:@protocol(CAMetalDrawable)]) {forward(object,selector,drawable);return;}
    id<CAMetalDrawable> metal=(id<CAMetalDrawable>)drawable;
    if(macfx::ownsPresentation(metal.layer) || !macfx::acceptsLayer(metal.layer) || objc_getAssociatedObject(drawable,&nativePresentationKey)) {forward(object,selector,drawable);return;}
    if(!std::getenv("RESHADE_EFFECT")) {
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
    if(state->failed.load() || !state->effects || !state->producer || !state->finished) {forward(object,selector,drawable);return;}
    id<MTLCommandBuffer> effects=[state->effects commandBuffer];
    if(!effects) {forward(object,selector,drawable);return;}
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

id<CAMetalDrawable> nextDrawable(id object,SEL selector) {
    if(macfx::ownsPresentation(object)) return reinterpret_cast<id<CAMetalDrawable>(*)(id,SEL)>(original(object,selector))(object,selector);
    macfx::acceptsLayer(object);
    if(std::getenv("RESHADE_EFFECT")||macfx::graphicsRequested()) [(CAMetalLayer*)object setFramebufferOnly:NO];
    id<CAMetalDrawable> drawable;
    {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalDrawable);drawable=reinterpret_cast<id<CAMetalDrawable>(*)(id,SEL)>(original(object,selector))(object,selector);}
    if(drawable) {
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
}
__attribute__((constructor)) static void loadMetal() { @autoreleasepool {
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::Hooks,1);
    if(!std::getenv("RESHADE_EFFECT") && !macfx::timingEnabled() && !macfx::graphicsRequested()) return;
    try { if(const char *prepared=std::getenv("RESHADE_PREPARED_EFFECT")) macfx::loadPrepared(std::getenv("RESHADE_EFFECT"),prepared); }
    catch(const std::exception &error) { log("Effect preload failed: "+std::string(error.what())); return; }
    if(const char *explicitHost=std::getenv("RESHADE_EXPLICIT_HOST");explicitHost && std::string(explicitHost)=="1") return;
    replace([CAMetalLayer class],@selector(nextDrawable),reinterpret_cast<IMP>(nextDrawable));
    id<MTLDevice> device=MTLCreateSystemDefaultDevice(); id<MTLCommandQueue> queue=[device newCommandQueue]; id<MTLCommandBuffer> buffer=[queue commandBuffer];
    if(!buffer) { log("Metal is unavailable"); return; }
    Class cls=object_getClass(buffer);
    replace(cls,@selector(presentDrawable:),reinterpret_cast<IMP>(present));
    replace(cls,@selector(presentDrawable:atTime:),reinterpret_cast<IMP>(presentTime));
    replace(cls,@selector(presentDrawable:afterMinimumDuration:),reinterpret_cast<IMP>(presentTime));
    replace(cls,@selector(commit),reinterpret_cast<IMP>(commit));
    replace(cls,@selector(addScheduledHandler:),reinterpret_cast<IMP>(addScheduled));
    if(@available(macOS 26.0,*)) {
        Class deviceClass=object_getClass(device);
        replace(deviceClass,@selector(newMTL4CommandQueue),reinterpret_cast<IMP>(newMetal4Queue));
        replace(deviceClass,@selector(newMTL4CommandQueueWithDescriptor:error:),reinterpret_cast<IMP>(newMetal4QueueDescriptor));
        hookMetal4Queue([device newMTL4CommandQueue]);
        log("Metal 4 queue presentation hooks installed");
    }
    log("Metal presentation hooks installed: "+std::string(object_getClassName(buffer))+" device="+device.name.UTF8String);
}}
extern "C" bool rsProcessRGBA(void *context,unsigned char *bytes,unsigned width,unsigned height) { @autoreleasepool {
    static id<MTLDevice> device=MTLCreateSystemDefaultDevice();
    static id<MTLCommandQueue> queue=[device newCommandQueue];
    std::lock_guard<std::mutex> guard(bridgeMutex());
    auto &runtime=bridgeRuntimes()[context]; runtime.captureFlipY=true;
    if(runtime.failed || !queue) return false;
    try {
        auto *descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:width height:height mipmapped:NO];
        descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;
        descriptor.storageMode=MTLStorageModeShared;
        auto image=[device newTextureWithDescriptor:descriptor];
        [image replaceRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0 withBytes:bytes bytesPerRow:width*4];
        auto buffer=[queue commandBuffer]; runtime.render(buffer,image);
        macfx::observeTiming(buffer,"probe-effects",width,height);
        [buffer commit]; [buffer waitUntilCompleted];
        if(buffer.status!=MTLCommandBufferStatusCompleted) throw std::runtime_error(buffer.error.localizedDescription.UTF8String?:"Metal GPU error");
        [image getBytes:bytes bytesPerRow:width*4 fromRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0];
        return true;
    } catch(const std::exception &error) { runtime.failed=true; log("OpenGL to Metal effect disabled: "+std::string(error.what())); return false; }
}}
void macfx::waitWindowSurfaceProducer(void *owner) {
        id<MTLCommandBuffer> previous;
        { std::lock_guard<std::mutex> guard(queueMutex());previous=lastGameBuffer(); }
        if(previous.status>=MTLCommandBufferStatusCommitted && previous.status<MTLCommandBufferStatusCompleted) {
            macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalProducerWait,reinterpret_cast<uintptr_t>(owner));[previous waitUntilCompleted];
        }
}
enum class SurfaceSource { Window, CompletedOpenGL };
static IOSurfaceRef filterSurface(void *owner,IOSurfaceRef surface,const char *timingScope,SurfaceSource sourceKind) { @autoreleasepool {
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
    if(sourceKind==SurfaceSource::Window) {
        macfx::waitWindowSurfaceProducer(owner);
    }
    std::unique_lock<std::mutex> guard(mutex(),std::defer_lock);
    {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalRuntimeLock,reinterpret_cast<uintptr_t>(owner));guard.lock();}
    auto &runtime=runtimes()[owner];
    if(runtime.failed) return nullptr;
    auto &pool=surfacePools()[owner];
    if(pool.w!=source.width || pool.h!=source.height || pool.format!=IOSurfaceGetPixelFormat(surface)) {
        pool.clear();pool.w=source.width;pool.h=source.height;pool.format=IOSurfaceGetPixelFormat(surface);
    }
    IOSurfaceRef output=nullptr;
    if(pool.surfaces.size()>=3) {
        for(unsigned i=0;i<pool.surfaces.size();++i) {
            unsigned index=(pool.cursor+i)%pool.surfaces.size();
            if(!IOSurfaceIsInUse(pool.surfaces[index])) {output=pool.surfaces[index];pool.cursor=(index+1)%pool.surfaces.size();break;}
        }
    }
    if(!output) {
        if(pool.surfaces.size()>=8) {log("Window display surfaces are still in use");return nullptr;}
        NSDictionary *properties=@{(__bridge NSString*)kIOSurfaceWidth:@(pool.w),(__bridge NSString*)kIOSurfaceHeight:@(pool.h),
            (__bridge NSString*)kIOSurfaceBytesPerElement:@4,(__bridge NSString*)kIOSurfaceBytesPerRow:@(IOSurfaceAlignProperty(kIOSurfaceBytesPerRow,pool.w*4)),
            (__bridge NSString*)kIOSurfacePixelFormat:@(pool.format)};
        output=IOSurfaceCreate((__bridge CFDictionaryRef)properties);
        if(!output) return nullptr;
        pool.surfaces.push_back(output);pool.cursor=0;
    }
    auto target=[device newTextureWithDescriptor:descriptor iosurface:output plane:0];
    if(!target) return nullptr;
    struct Encoding {Encoding(){encodingEffects=true;}~Encoding(){encodingEffects=false;}} encoding;
    try {
        id<MTLCommandBuffer> buffer;
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalQueue);buffer=[queue commandBuffer];}
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalEncode,reinterpret_cast<uintptr_t>(owner),pool.w,pool.h);runtime.render(buffer,source,target);}
        macfx::observeTiming(buffer,timingScope,pool.w,pool.h);
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalCommit);[buffer commit];}
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::MetalEffectWait,reinterpret_cast<uintptr_t>(owner),pool.w,pool.h);[buffer waitUntilCompleted];}
        if(buffer.status!=MTLCommandBufferStatusCompleted) throw std::runtime_error("Window surface GPU processing failed");
        return (IOSurfaceRef)CFRetain(output);
    } catch(const std::exception &error) { runtime.failed=true;log("Window surface effect disabled: "+std::string(error.what()));return nullptr; }
}}

extern "C" IOSurfaceRef rsFilterWindowSurface(void *owner,IOSurfaceRef surface) {
    return filterSurface(owner,surface,"surface-copy-and-effects",SurfaceSource::Window);
}
extern "C" IOSurfaceRef rsFilterOpenGLSurface(void *owner,IOSurfaceRef surface) {
    return filterSurface(owner,surface,"legacy-surface-copy-and-effects",SurfaceSource::CompletedOpenGL);
}

macfx::FrameResult macfx::processFrame(void *owner,id<MTLCommandBuffer> commands,const SpatialFrame &frame,SpatialMethod method) { @autoreleasepool {
    FrameResult result;
    if(!owner || !commands || !frame.source || !frame.output) {result.reason="Missing frame owner, command buffer or image";return result;}
    if(commands.status>=MTLCommandBufferStatusCommitted) {result.reason="Command buffer is already submitted";return result;}
    if(!commands.retainedReferences) {result.reason="Frame processing requires a command buffer that retains resources";return result;}
    if(frame.source.framebufferOnly || frame.output.framebufferOnly) {result.reason="Frame images must support access outside render passes";return result;}
    if(frame.source.device!=commands.device || frame.output.device!=commands.device) {result.reason="Frame images must use the command buffer device";return result;}
    if(frame.source.textureType!=MTLTextureType2D || frame.output.textureType!=MTLTextureType2D || frame.source.sampleCount!=1 || frame.output.sampleCount!=1) {result.reason="Frame processing requires resolved 2D images";return result;}
    if(frame.source.width>frame.output.width || frame.source.height>frame.output.height || frame.output.width>frame.source.width*2 || frame.output.height>frame.source.height*2) {result.reason="Output dimensions must be between the source size and twice its size";return result;}
    std::lock_guard<std::mutex> guard(mutex());auto &runtime=runtimes()[owner];
    result.effects=std::getenv("RESHADE_EFFECT")!=nullptr;
    result.scaled=frame.source.width!=frame.output.width || frame.source.height!=frame.output.height || frame.source.pixelFormat!=frame.output.pixelFormat;
    @try { try {
        if(result.effects) {runtime.render(commands,frame.source,frame.output,method,frame.frameId,frame.color,frame.origin);if(result.scaled)result.scaling=runtime.lastScaling;}
        else if(result.scaled) {result.scaling=runtime.scale(commands,frame,method);if(!result.scaling.encoded){result.busy=result.scaling.busy;result.reason=result.scaling.reason;return result;}}
        else if(frame.source!=frame.output) {auto copy=[commands blitCommandEncoder];[copy copyFromTexture:frame.source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(frame.source.width,frame.source.height,1) toTexture:frame.output destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[copy endEncoding];}
        result.encoded=true;
    } catch(const SpatialBusy &error) {result.busy=true;result.scaling=runtime.lastScaling;result.reason=error.what();}
    catch(const std::exception &error) {runtime.w=runtime.h=0;result.reason=error.what();} }
    @catch(NSException *error) {runtime.w=runtime.h=0;result.reason=error.reason.UTF8String?:"Frame processing failed";}
    return result;
}}

void macfx::releaseFrameOwner(void *owner) {
    if (!owner) return;
    // Retired resources may invoke framework teardown. Never destroy them
    // while the global owner map is locked; submitted buffers retain their own
    // GPU resources and Core Animation retains displayed IOSurfaces.
    std::map<void*,Runtime>::node_type runtime,bridge;
    std::map<void*,SurfacePool>::node_type pool;
    {std::lock_guard<std::mutex> guard(mutex());runtime=runtimes().extract(owner);pool=surfacePools().extract(owner);}
    {std::lock_guard<std::mutex> guard(bridgeMutex());bridge=bridgeRuntimes().extract(owner);}
}
extern "C" void rsReleaseFrameOwner(void *owner) { macfx::releaseFrameOwner(owner); }

extern "C" int rsProcessFrame(const RSFrameRequest *request,RSFrameResult *result) {
    if(!request || !result || request->size<sizeof(RSFrameRequest) || result->size<sizeof(RSFrameResult) || request->version!=RS_FRAME_ABI_VERSION || result->version!=RS_FRAME_ABI_VERSION) return RS_FRAME_INVALID_ARGUMENT;
    const uint32_t size=result->size;*result={};result->size=size;result->version=RS_FRAME_ABI_VERSION;result->frameId=request->frameId;
    if(request->method>RS_FRAME_FSR1 || request->color>RS_FRAME_LINEAR || request->origin>RS_FRAME_BOTTOM_LEFT) {std::strncpy(result->reason,"Unsupported frame method, colour mode or origin",sizeof(result->reason)-1);return RS_FRAME_INVALID_ARGUMENT;}
    try { @try {
        macfx::SpatialFrame frame{(__bridge id<MTLTexture>)request->sourceTexture,(__bridge id<MTLTexture>)request->outputTexture,request->frameId,static_cast<macfx::SpatialColor>(request->color),static_cast<macfx::FrameOrigin>(request->origin)};
        auto value=macfx::processFrame(request->owner,(__bridge id<MTLCommandBuffer>)request->commandBuffer,frame,static_cast<macfx::SpatialMethod>(request->method));
        result->encoded=value.encoded;result->effects=value.effects;result->scaled=value.scaled;result->activeMethod=value.scaled?static_cast<uint32_t>(value.scaling.active):request->method;
        result->inputWidth=frame.source.width;result->inputHeight=frame.source.height;result->outputWidth=frame.output.width;result->outputHeight=frame.output.height;
        const auto &reason=value.reason.empty()?value.scaling.reason:value.reason;std::strncpy(result->reason,reason.c_str(),sizeof(result->reason)-1);
        return value.encoded?RS_FRAME_OK:value.busy?RS_FRAME_BUSY:RS_FRAME_ENCODE_FAILED;
    } @catch(NSException *error) {std::strncpy(result->reason,error.reason.UTF8String?:"Frame processing failed",sizeof(result->reason)-1);} }
    catch(const std::exception &error) {std::strncpy(result->reason,error.what(),sizeof(result->reason)-1);}
    catch(...) {std::strncpy(result->reason,"Frame processing failed",sizeof(result->reason)-1);}
    return RS_FRAME_ENCODE_FAILED;
}
