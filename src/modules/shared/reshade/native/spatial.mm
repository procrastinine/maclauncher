#include "spatial.hpp"
#include "image-admission.hpp"
#include "ls1.hpp"
#include "mako-spatial.hpp"
#include "fsr1.hpp"
#include "graphics.hpp"
#include "color-formats.hpp"
#include "metal-library-cache.hpp"
#import <MetalFX/MetalFX.h>
#include <mutex>
#include <stdexcept>
#include <vector>
#include <algorithm>
#include <array>
#include <map>

namespace macfx {
namespace {
const char *interpolationSource = R"METAL(
#include <metal_stdlib>
using namespace metal;
kernel void spatial_bilinear(texture2d<float, access::sample> input [[texture(0)]],
                             texture2d<float, access::write> output [[texture(1)]],
                             uint2 p [[thread_position_in_grid]]) {
    if (p.x >= output.get_width() || p.y >= output.get_height()) return;
    constexpr sampler filtering(coord::normalized, address::clamp_to_edge, filter::linear);
    const float2 uv = (float2(p) + 0.5f) / float2(output.get_width(), output.get_height());
    output.write(input.sample(filtering, uv), p);
}
kernel void spatial_nearest(texture2d<float, access::read> input [[texture(0)]],
                            texture2d<float, access::write> output [[texture(1)]],
                            uint2 p [[thread_position_in_grid]]) {
    if (p.x >= output.get_width() || p.y >= output.get_height()) return;
    const uint2 extent(input.get_width(), input.get_height());
    const float2 position = (float2(p) + 0.5f) * float2(extent) / float2(output.get_width(), output.get_height());
    output.write(input.read(min(uint2(position), extent - 1)), p);
}
kernel void spatial_area(texture2d<float, access::read> input [[texture(0)]],
                         texture2d<float, access::write> output [[texture(1)]],
                         uint2 p [[thread_position_in_grid]]) {
    if (p.x >= output.get_width() || p.y >= output.get_height()) return;
    const float2 ratio=float2(input.get_width(),input.get_height())/float2(output.get_width(),output.get_height());
    const float2 lo=float2(p)*ratio, hi=float2(p+1)*ratio;
    const uint2 first=uint2(floor(lo)), last=min(uint2(ceil(hi)),uint2(input.get_width(),input.get_height()));
    float4 sum(0); float weightSum=0;
    for(uint y=first.y;y<last.y;++y) for(uint x=first.x;x<last.x;++x) {
        const float2 overlap=max(float2(0),min(hi,float2(x+1,y+1))-max(lo,float2(x,y)));
        const float weight=overlap.x*overlap.y;sum+=input.read(uint2(x,y))*weight;weightSum+=weight;
    }
    output.write(sum/max(weightSum,1e-12f),p);
}
vertex float4 spatial_transfer_vertex(uint id [[vertex_id]]) {
    const float2 points[] = {float2(-1,-1), float2(3,-1), float2(-1,3)};
    return float4(points[id], 0, 1);
}
fragment float4 spatial_transfer_fragment(float4 position [[position]],
                                         texture2d<float, access::read> input [[texture(0)]]) {
    return input.read(uint2(position.xy));
}
float catmull_rom(float value) {
    const float x = abs(value);
    if (x <= 1.0f) return ((1.5f * x - 2.5f) * x) * x + 1.0f;
    if (x < 2.0f) return ((-0.5f * x + 2.5f) * x - 4.0f) * x + 2.0f;
    return 0.0f;
}
kernel void spatial_bicubic(texture2d<float, access::read> input [[texture(0)]],
                            texture2d<float, access::write> output [[texture(1)]],
                            uint2 p [[thread_position_in_grid]]) {
    if (p.x >= output.get_width() || p.y >= output.get_height()) return;
    const int2 extent(input.get_width(), input.get_height());
    const float2 position = (float2(p) + 0.5f) * float2(extent) / float2(output.get_width(), output.get_height()) - 0.5f;
    const int2 base = int2(floor(position));
    float4 color(0.0f); float total = 0.0f;
    for (int y = -1; y <= 2; ++y) for (int x = -1; x <= 2; ++x) {
        const int2 sample = base + int2(x, y);
        const float weight = catmull_rom(position.x - sample.x) * catmull_rom(position.y - sample.y);
        color += input.read(uint2(clamp(sample, int2(0), extent - 1))) * weight;
        total += weight;
    }
    output.write(color / total, p);
}
)METAL";
bool interpolation(SpatialMethod method){return method==SpatialMethod::Bilinear||method==SpatialMethod::Nearest||method==SpatialMethod::Bicubic||method==SpatialMethod::Area;}
}
const char *spatialMethodName(SpatialMethod method)noexcept{
    switch(method){case SpatialMethod::MetalFX:return "metalfx";case SpatialMethod::LS1:return "ls1";case SpatialMethod::Mako:return "mako";case SpatialMethod::FSR1:return "fsr1";
    case SpatialMethod::Nearest:return "nearest";case SpatialMethod::Bicubic:return "bicubic";case SpatialMethod::Area:return "area";case SpatialMethod::Bilinear:break;}
    return "bilinear";
}
SpatialMethod spatialMethodForName(const std::string &name){
    if(name=="off"||name=="bilinear"||name=="downsample")return SpatialMethod::Bilinear;
    if(name=="nearest")return SpatialMethod::Nearest;
    if(name=="bicubic")return SpatialMethod::Bicubic;
    if(name=="area")return SpatialMethod::Area;
    if(name=="metalfx")return SpatialMethod::MetalFX;
    if(name=="fsr1")return SpatialMethod::FSR1;
    if(name=="mako")return SpatialMethod::Mako;
    if(name=="ls1")return SpatialMethod::LS1;
    throw std::invalid_argument("Unknown spatial scaling method");
}
struct SpatialEncoder::Impl {
    struct MultiTargets {std::vector<id<MTLTexture>> images;unsigned sourceW=0,sourceH=0,outputW=0,outputH=0;MTLPixelFormat format=MTLPixelFormatInvalid;SpatialMethod method=SpatialMethod::Bilinear;};
    id<MTLDevice> device;
    id<MTLLibrary> interpolationLibrary;
    std::array<id<MTLComputePipelineState>,4> interpolationPipelines;
    std::map<MTLPixelFormat,id<MTLRenderPipelineState>> transferPipelines;
    id<MTLFXSpatialScaler> scaler;
    std::unique_ptr<Ls1Encoder> ls1;
    std::unique_ptr<MakoSpatialEncoder> mako;
    std::unique_ptr<Fsr1Encoder> fsr1;double makoSharpness=-1,ls1Sharpness=-1;bool ls1Performance=false;std::string ls1Model;
    unsigned sourceW=0,sourceH=0,outputW=0,outputH=0;
    MTLPixelFormat sourceFormat=MTLPixelFormatInvalid,outputFormat=MTLPixelFormatInvalid;
    SpatialColor color=SpatialColor::Perceptual;
    std::mutex mutex;
    std::vector<std::shared_ptr<SpatialEncoder>> stages;
    std::vector<std::shared_ptr<MultiTargets>> multiTargets;
};
SpatialEncoder::SpatialEncoder(id<MTLDevice> device):impl(std::make_unique<Impl>()) {
    if(!device) throw std::invalid_argument("Spatial scaling requires a Metal device");
    impl->device=device;
}
SpatialEncoder::~SpatialEncoder() = default;
SpatialStatus SpatialEncoder::prepare(const SpatialFrame&frame,SpatialMethod method,const SpatialConfig&config){
 SpatialStatus result;result.requested=result.active=method;if(method!=SpatialMethod::LS1){result.encoded=true;return result;}
 try{if(!impl->ls1||impl->ls1Sharpness!=config.sharpness||impl->ls1Performance!=config.ls1Performance||impl->ls1Model!=config.modelPath){impl->ls1=std::make_unique<Ls1Encoder>(impl->device,Ls1Config{config.modelPath,config.ls1Performance,float(config.sharpness)});impl->ls1Sharpness=config.sharpness;impl->ls1Performance=config.ls1Performance;impl->ls1Model=config.modelPath;}return impl->ls1->prepare(frame.source.width,frame.source.height);}
 catch(const TransientBusy&error){result.reason=error.what();result.busy=!error.structurallyImpossible;}catch(const std::exception&error){result.reason=error.what();}return result;
}
bool SpatialEncoder::metalFXAvailable(id<MTLDevice> device) {
    if(@available(macOS 13.0,*)) return [MTLFXSpatialScalerDescriptor supportsDevice:device];
    return false;
}
SpatialStatus SpatialEncoder::encode(id<MTLCommandBuffer> commands,const SpatialFrame &frame,SpatialMethod method) {
    const auto &config=presentationGraphicsEnvironment();
    return encode(commands,frame,method,{config.sharpness,config.ls1Performance,config.modelPath});
}
SpatialStatus SpatialEncoder::encode(id<MTLCommandBuffer> commands,const SpatialFrame &frame,SpatialMethod method,const SpatialConfig &config) {
    SpatialStatus result;result.requested=method;result.active=method;result.frameId=frame.frameId;
    result.inputWidth=(unsigned)frame.source.width;result.inputHeight=(unsigned)frame.source.height;
    result.outputWidth=(unsigned)frame.output.width;result.outputHeight=(unsigned)frame.output.height;
    auto reject=[&](const char *reason){result.reason=reason;return result;};
    if(!commands || !frame.source || !frame.output) return reject("Missing command buffer or image");
    if(commands.status>=MTLCommandBufferStatusCommitted) return reject("Command buffer is already submitted");
    if(commands.device!=impl->device || frame.source.device!=impl->device || frame.output.device!=impl->device) return reject("Images must use the command buffer's Metal device");
    if(frame.source==frame.output) return reject("Spatial scaling requires distinct source and output images");
    if(!frame.source.width || !frame.source.height || !frame.output.width || !frame.output.height) return reject("Empty image dimensions");
    if(frame.source.textureType!=MTLTextureType2D || frame.output.textureType!=MTLTextureType2D || frame.source.sampleCount!=1 || frame.output.sampleCount!=1) return reject("Spatial scaling requires resolved 2D images");
    if((!SpatialEncoder::supportsFormat(frame.source.pixelFormat)&&!packedColorFormat(frame.source.pixelFormat)) || !SpatialEncoder::supportsFormat(frame.output.pixelFormat)) return reject("Unsupported image format");
    // A selected algorithm keeps its identity. The graph/presenter owns any
    // explicit recovery fit; this encoder never substitutes another filter.
    if(!interpolation(method)) {
        if(frame.source.width>frame.output.width || frame.source.height>frame.output.height) {
            return reject("The selected upscaler cannot reduce an image; use an explicit Downsample stage");
        }
    }
    if(method==SpatialMethod::Area&&(frame.output.width>frame.source.width||frame.output.height>frame.source.height))
        return reject("Area filtering reduces an image; choose an upscaler for enlargement");
    if(!(frame.source.usage&MTLTextureUsageShaderRead)) return reject("Source image is not readable by shaders");
    const bool renderTransfer=method==SpatialMethod::Nearest&&frame.source.width==frame.output.width&&frame.source.height==frame.output.height&&
        !(frame.output.usage&MTLTextureUsageShaderWrite)&&(frame.output.usage&MTLTextureUsageRenderTarget);
    if(!(frame.output.usage&MTLTextureUsageShaderWrite)&&!renderTransfer) return reject("Output image is not writable by shaders");
    std::lock_guard lock(impl->mutex);
    if(!commands.retainedReferences) return reject("Spatial scaling requires a retaining command buffer");
    if(renderTransfer) {
        // A 1:1 format transfer needs logical texel reads, not a byte-order
        // blit. Render-target-only images keep their existing public contract.
        auto &pipeline=impl->transferPipelines[frame.output.pixelFormat];
        if(!pipeline) {
            NSError *error=nil;
            if(!impl->interpolationLibrary)impl->interpolationLibrary=cachedMetalLibrary(impl->device,interpolationSource,&error);
            if(!impl->interpolationLibrary)return reject(error.localizedDescription.UTF8String? : "Cannot compile spatial transfer");
            auto descriptor=[MTLRenderPipelineDescriptor new];
            descriptor.vertexFunction=[impl->interpolationLibrary newFunctionWithName:@"spatial_transfer_vertex"];
            descriptor.fragmentFunction=[impl->interpolationLibrary newFunctionWithName:@"spatial_transfer_fragment"];
            descriptor.colorAttachments[0].pixelFormat=frame.output.pixelFormat;
            pipeline=[impl->device newRenderPipelineStateWithDescriptor:descriptor error:&error];
            if(!pipeline)return reject(error.localizedDescription.UTF8String? : "Cannot create spatial transfer");
        }
        auto descriptor=[MTLRenderPassDescriptor renderPassDescriptor];
        descriptor.colorAttachments[0].texture=frame.output;descriptor.colorAttachments[0].loadAction=MTLLoadActionDontCare;
        descriptor.colorAttachments[0].storeAction=MTLStoreActionStore;
        auto encoder=[commands renderCommandEncoderWithDescriptor:descriptor];
        if(!encoder)return reject("Cannot encode spatial transfer");
        [encoder setRenderPipelineState:pipeline];[encoder setFragmentTexture:frame.source atIndex:0];
        [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];
        id<MTLTexture> source=frame.source,output=frame.output;id<MTLRenderPipelineState> retainedPipeline=pipeline;
        [commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)source;(void)output;(void)retainedPipeline;}];
        result.encoded=true;return result;
    }
    if(!interpolation(method)&&(frame.output.width>frame.source.width*2||frame.output.height>frame.source.height*2)) {
        // Fit through supported ratios automatically. Each level owns its scaler
        // so a warm chain does not recreate MetalFX for every alternating size.
        if(frame.output.width>16384||frame.output.height>16384)return reject("Spatial output exceeds the supported dimensions");
        std::shared_ptr<Impl::MultiTargets> targets;
        for(const auto &slot:impl->multiTargets)if(slot.use_count()==1&&slot->sourceW==frame.source.width&&slot->sourceH==frame.source.height&&
            slot->outputW==frame.output.width&&slot->outputH==frame.output.height&&slot->format==frame.output.pixelFormat&&slot->method==method){targets=slot;break;}
        if(!targets) {
            impl->multiTargets.erase(std::remove_if(impl->multiTargets.begin(),impl->multiTargets.end(),[](const auto &slot){return slot.use_count()==1;}),impl->multiTargets.end());
            if(impl->multiTargets.size()>=4){result.busy=true;return reject("Spatial scaling capacity is busy");}
            targets=std::make_shared<Impl::MultiTargets>();targets->sourceW=frame.source.width;targets->sourceH=frame.source.height;
            targets->outputW=frame.output.width;targets->outputH=frame.output.height;targets->format=frame.output.pixelFormat;targets->method=method;
            NSUInteger width=frame.source.width,height=frame.source.height;
            while(frame.output.width>width*2||frame.output.height>height*2) {
                width=std::min(frame.output.width,width*2);height=std::min(frame.output.height,height*2);
                // Repeated MetalFX writes to 8-bit images compound quantization.
                // Keep intermediate colors in half precision until final output.
                const auto format=method==SpatialMethod::MetalFX?MTLPixelFormatRGBA16Float:frame.output.pixelFormat;
                auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];
                descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
                auto texture=newAdmittedTexture(impl->device,descriptor);
                targets->images.push_back(texture);
            }
            impl->multiTargets.push_back(targets);
        }
        while(impl->stages.size()<targets->images.size()+1)impl->stages.push_back(std::make_shared<SpatialEncoder>(impl->device));
        [commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)targets;}];
        id<MTLTexture> input=frame.source;
        for(size_t i=0;i<=targets->images.size();++i) {
            id<MTLTexture> output=i<targets->images.size()?targets->images[i]:frame.output;
            const auto status=impl->stages[i]->encode(commands,{input,output,frame.frameId,frame.color,frame.origin},method,config);
            if(!status.encoded){result.reason=status.reason;result.busy=status.busy;return result;}
            if(status.active!=method)result.active=status.active;
            if(!status.reason.empty())result.reason=status.reason;
            input=output;
        }
        result.encoded=true;return result;
    }
    if(method==SpatialMethod::FSR1) {
        try {
            if(!impl->fsr1)impl->fsr1=std::make_unique<Fsr1Encoder>(impl->device);
            result.encoded=impl->fsr1->encode(commands,frame,float(config.sharpness),result.reason,&result.busy);
        } catch(const std::exception &error) {result.reason=error.what();}
        return result;
    }
    if(method==SpatialMethod::Mako) {
        try {
            const auto sharpness=config.sharpness;if(!impl->mako||impl->makoSharpness!=sharpness){impl->mako=std::make_unique<MakoSpatialEncoder>(impl->device,float(sharpness));impl->makoSharpness=sharpness;}
            impl->mako->encode(commands,frame);result.encoded=true;return result;
        } catch(const std::exception &error) {return reject(error.what());}
    }
    if(method==SpatialMethod::LS1) {
        try {
            if(!impl->ls1||impl->ls1Sharpness!=config.sharpness||impl->ls1Performance!=config.ls1Performance||impl->ls1Model!=config.modelPath){impl->ls1=std::make_unique<Ls1Encoder>(impl->device,Ls1Config{config.modelPath,config.ls1Performance,float(config.sharpness)});impl->ls1Sharpness=config.sharpness;impl->ls1Performance=config.ls1Performance;impl->ls1Model=config.modelPath;}
            return impl->ls1->encode(commands,frame);
        } catch(const std::exception &error) { return reject(error.what()); }
    }
    if(method==SpatialMethod::MetalFX && metalFXAvailable(impl->device)) {
        if(@available(macOS 13.0,*)) {
            const bool changed=!impl->scaler || impl->sourceW!=frame.source.width || impl->sourceH!=frame.source.height ||
                impl->outputW!=frame.output.width || impl->outputH!=frame.output.height ||
                impl->sourceFormat!=frame.source.pixelFormat || impl->outputFormat!=frame.output.pixelFormat || impl->color!=frame.color;
            if(changed) {
                MTLFXSpatialScalerDescriptor *descriptor=[MTLFXSpatialScalerDescriptor new];
                descriptor.inputWidth=frame.source.width;descriptor.inputHeight=frame.source.height;
                descriptor.outputWidth=frame.output.width;descriptor.outputHeight=frame.output.height;
                descriptor.colorTextureFormat=frame.source.pixelFormat;descriptor.outputTextureFormat=frame.output.pixelFormat;
                descriptor.colorProcessingMode=frame.color==SpatialColor::HDR?MTLFXSpatialScalerColorProcessingModeHDR:frame.color==SpatialColor::Linear?MTLFXSpatialScalerColorProcessingModeLinear:MTLFXSpatialScalerColorProcessingModePerceptual;
                id<MTLFXSpatialScaler> scaler=[descriptor newSpatialScalerWithDevice:impl->device];
                if(scaler){impl->scaler=scaler;impl->sourceW=(unsigned)frame.source.width;impl->sourceH=(unsigned)frame.source.height;
                    impl->outputW=(unsigned)frame.output.width;impl->outputH=(unsigned)frame.output.height;
                    impl->sourceFormat=frame.source.pixelFormat;impl->outputFormat=frame.output.pixelFormat;impl->color=frame.color;}
                else {impl->scaler=nil;result.reason="MetalFX could not create a scaler for these images";}
            }
            if(impl->scaler) {
                if((frame.source.usage&impl->scaler.colorTextureUsage)!=impl->scaler.colorTextureUsage ||
                   (frame.output.usage&impl->scaler.outputTextureUsage)!=impl->scaler.outputTextureUsage)
                    return reject("Images do not satisfy MetalFX texture usage requirements");
                impl->scaler.colorTexture=frame.source;impl->scaler.outputTexture=frame.output;
                impl->scaler.inputContentWidth=frame.source.width;impl->scaler.inputContentHeight=frame.source.height;
                [impl->scaler encodeToCommandBuffer:commands];
                // Keep the exact scaler and images alive even if the next frame resizes.
                id<MTLFXSpatialScaler> retainedScaler=impl->scaler;
                id<MTLTexture> source=frame.source,output=frame.output;
                [commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)retainedScaler;(void)source;(void)output;}];
                result.encoded=true;return result;
            }
        }
    } else if(method==SpatialMethod::MetalFX) result.reason="MetalFX Spatial is unavailable on this device";
    if(!interpolation(method))return result;
    result.active=method;
    const unsigned index=method==SpatialMethod::Nearest?1:method==SpatialMethod::Bicubic?2:method==SpatialMethod::Area?3:0;
    auto &pipeline=impl->interpolationPipelines[index];
    if(!pipeline) {
        NSError *error=nil;
        if(!impl->interpolationLibrary)impl->interpolationLibrary=cachedMetalLibrary(impl->device,interpolationSource,&error);
        if(!impl->interpolationLibrary)return reject(error.localizedDescription.UTF8String ?: "Cannot compile spatial interpolation");
        NSString *names[]={@"spatial_bilinear",@"spatial_nearest",@"spatial_bicubic",@"spatial_area"};
        pipeline=[impl->device newComputePipelineStateWithFunction:[impl->interpolationLibrary newFunctionWithName:names[index]] error:&error];
        if(!pipeline)return reject(error.localizedDescription.UTF8String ?: "Cannot create spatial interpolation");
    }
    id<MTLComputeCommandEncoder> encoder=[commands computeCommandEncoder];
    if(!encoder)return reject("Cannot create the spatial compute encoder");
    [encoder setComputePipelineState:pipeline];[encoder setTexture:frame.source atIndex:0];[encoder setTexture:frame.output atIndex:1];
    const NSUInteger width=pipeline.threadExecutionWidth;
    [encoder dispatchThreads:MTLSizeMake(frame.output.width,frame.output.height,1) threadsPerThreadgroup:MTLSizeMake(width,1,1)];
    [encoder endEncoding];
    id<MTLTexture> source=frame.source,output=frame.output;id<MTLComputePipelineState> retainedPipeline=pipeline;
    [commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)source;(void)output;(void)retainedPipeline;}];
    result.encoded=true;return result;
}
}
