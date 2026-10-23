#include "spatial.hpp"
#include "ls1.hpp"
#include "mako-spatial.hpp"
#include "fsr1.hpp"
#include "graphics.hpp"
#import <MetalFX/MetalFX.h>
#include <mutex>
#include <stdexcept>

namespace macfx {
namespace {
const char *bilinearSource = R"METAL(
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
)METAL";
bool supportedFormat(MTLPixelFormat format) {
    return format == MTLPixelFormatRGBA8Unorm || format == MTLPixelFormatBGRA8Unorm ||
           format == MTLPixelFormatRGBA16Float;
}
}
struct SpatialEncoder::Impl {
    id<MTLDevice> device;
    id<MTLComputePipelineState> bilinear;
    id<MTLFXSpatialScaler> scaler;
    std::unique_ptr<Ls1Encoder> ls1;
    std::unique_ptr<MakoSpatialEncoder> mako;
    std::unique_ptr<Fsr1Encoder> fsr1;
    unsigned sourceW=0,sourceH=0,outputW=0,outputH=0;
    MTLPixelFormat sourceFormat=MTLPixelFormatInvalid,outputFormat=MTLPixelFormatInvalid;
    SpatialColor color=SpatialColor::Perceptual;
    std::mutex mutex;
};
SpatialEncoder::SpatialEncoder(id<MTLDevice> device):impl(std::make_unique<Impl>()) {
    if(!device) throw std::invalid_argument("Spatial scaling requires a Metal device");
    impl->device=device;
}
SpatialEncoder::~SpatialEncoder() = default;
bool SpatialEncoder::metalFXAvailable(id<MTLDevice> device) {
    if(@available(macOS 13.0,*)) return [MTLFXSpatialScalerDescriptor supportsDevice:device];
    return false;
}
SpatialStatus SpatialEncoder::encode(id<MTLCommandBuffer> commands,const SpatialFrame &frame,SpatialMethod method) {
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
    if(!supportedFormat(frame.source.pixelFormat) || !supportedFormat(frame.output.pixelFormat)) return reject("Unsupported image format");
    if(frame.source.width>frame.output.width || frame.source.height>frame.output.height) return reject("Output must not be smaller than the game image");
    if(frame.output.width>frame.source.width*2 || frame.output.height>frame.source.height*2) return reject("Spatial scaling supports ratios up to 2x");
    if(!(frame.source.usage&MTLTextureUsageShaderRead)) return reject("Source image is not readable by shaders");
    if(!(frame.output.usage&MTLTextureUsageShaderWrite)) return reject("Output image is not writable by shaders");
    std::lock_guard lock(impl->mutex);
    if(!commands.retainedReferences) return reject("Spatial scaling requires a retaining command buffer");
    if(method==SpatialMethod::FSR1) {
        try {
            if(!impl->fsr1)impl->fsr1=std::make_unique<Fsr1Encoder>(impl->device);
            result.encoded=impl->fsr1->encode(commands,frame,float(graphicsEnvironment().sharpness),result.reason,&result.busy);
        } catch(const std::exception &error) {result.reason=error.what();}
        return result;
    }
    if(method==SpatialMethod::Mako) {
        try {
            if(!impl->mako)impl->mako=std::make_unique<MakoSpatialEncoder>(impl->device,float(graphicsEnvironment().sharpness));
            impl->mako->encode(commands,frame);result.encoded=true;return result;
        } catch(const std::exception &error) {return reject(error.what());}
    }
    if(method==SpatialMethod::LS1) {
        try {
            if(!impl->ls1) { const auto config=graphicsEnvironment();impl->ls1=std::make_unique<Ls1Encoder>(impl->device,Ls1Config{config.modelPath,config.ls1Performance,float(config.sharpness)}); }
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
                descriptor.colorProcessingMode=frame.color==SpatialColor::Linear?MTLFXSpatialScalerColorProcessingModeLinear:MTLFXSpatialScalerColorProcessingModePerceptual;
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
    result.active=SpatialMethod::Bilinear;
    if(!impl->bilinear) {
        NSError *error=nil;
        id<MTLLibrary> library=[impl->device newLibraryWithSource:@(bilinearSource) options:nil error:&error];
        if(!library) return reject(error.localizedDescription.UTF8String ?: "Cannot compile bilinear scaler");
        impl->bilinear=[impl->device newComputePipelineStateWithFunction:[library newFunctionWithName:@"spatial_bilinear"] error:&error];
        if(!impl->bilinear) return reject(error.localizedDescription.UTF8String ?: "Cannot create bilinear scaler");
    }
    id<MTLComputeCommandEncoder> encoder=[commands computeCommandEncoder];
    [encoder setComputePipelineState:impl->bilinear];[encoder setTexture:frame.source atIndex:0];[encoder setTexture:frame.output atIndex:1];
    const NSUInteger width=impl->bilinear.threadExecutionWidth;
    [encoder dispatchThreads:MTLSizeMake(frame.output.width,frame.output.height,1) threadsPerThreadgroup:MTLSizeMake(width,1,1)];
    [encoder endEncoding];
    id<MTLTexture> source=frame.source,output=frame.output;id<MTLComputePipelineState> retainedPipeline=impl->bilinear;
    [commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)source;(void)output;(void)retainedPipeline;}];
    result.encoded=true;return result;
}
}
