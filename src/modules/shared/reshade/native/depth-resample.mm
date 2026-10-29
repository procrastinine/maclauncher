#import <Foundation/Foundation.h>
#include "depth-resample.hpp"
#include <stdexcept>
#include <cmath>
#include "metal-library-cache.hpp"
namespace macfx {
DepthResampler::DepthResampler(id<MTLDevice> value):device(value){
    if(!device)throw std::runtime_error("Depth resizing requires the current GPU device.");
    NSString *source=@"#include <metal_stdlib>\nusing namespace metal;\n"
      "kernel void resize_color(texture2d<float,access::sample> input [[texture(0)]],texture2d<float,access::write> output [[texture(1)]],constant float4 &policy [[buffer(0)]],uint2 p [[thread_position_in_grid]]){"
      "if(p.x>=output.get_width()||p.y>=output.get_height())return;constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::nearest);"
      "float2 uv=(float2(p)+.5f)/float2(output.get_width(),output.get_height());if(policy.x)uv.y=1-uv.y;uv-=policy.yz/float2(input.get_width(),input.get_height());output.write(float4(input.sample(s,uv).r),p);}\n"
      "kernel void resize_depth(depth2d<float,access::sample> input [[texture(0)]],texture2d<float,access::write> output [[texture(1)]],constant float4 &policy [[buffer(0)]],uint2 p [[thread_position_in_grid]]){"
      "if(p.x>=output.get_width()||p.y>=output.get_height())return;constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::nearest);"
      "float2 uv=(float2(p)+.5f)/float2(output.get_width(),output.get_height());if(policy.x)uv.y=1-uv.y;uv-=policy.yz/float2(input.get_width(),input.get_height());output.write(float4(input.sample(s,uv)),p);}";
    NSError *error=nil;auto library=cachedMetalLibrary(device,std::string(source.UTF8String),&error);
    if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"The depth resize shader could not be compiled.");
    color=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"resize_color"] error:&error];
    depth=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"resize_depth"] error:&error];
    if(!color||!depth)throw std::runtime_error(error.localizedDescription.UTF8String?:"The depth resize pipeline could not be created.");
}
bool DepthResampler::encode(id<MTLCommandBuffer> commands,const DepthFrame &input,id<MTLTexture> output,FrameOrigin outputOrigin,std::string &reason,float jitterX,float jitterY){
    if(!std::isfinite(jitterX)||!std::isfinite(jitterY)||!commands||commands.status>=MTLCommandBufferStatusCommitted||!input.texture||!output||
      commands.commandQueue.device.registryID!=device.registryID||input.texture.device.registryID!=device.registryID||output.device.registryID!=device.registryID||
      input.texture.sampleCount!=1||input.texture.textureType!=MTLTextureType2D||output.textureType!=MTLTextureType2D||output.pixelFormat!=MTLPixelFormatR32Float||
      input.texture==output||(input.texture.usage!=MTLTextureUsageUnknown&&!(input.texture.usage&MTLTextureUsageShaderRead))||!(output.usage&MTLTextureUsageShaderWrite)){
        reason="Depth resizing requires distinct resolved textures on the current GPU and an unsubmitted command buffer.";return false;
    }
    bool depthFormat=false;
    switch(input.texture.pixelFormat){
      case MTLPixelFormatDepth16Unorm:case MTLPixelFormatDepth32Float:case MTLPixelFormatDepth32Float_Stencil8:case MTLPixelFormatDepth24Unorm_Stencil8:depthFormat=true;break;
      case MTLPixelFormatR16Float:case MTLPixelFormatR32Float:case MTLPixelFormatR16Unorm:break;
      default:reason="The resolved depth texture has an unsupported numeric format.";return false;
    }
    auto encoder=[commands computeCommandEncoder];if(!encoder){reason="The depth resize encoder could not be created.";return false;}
    const float policy[4]={input.origin==outputOrigin?0.f:1.f,jitterX,jitterY,0};
    [encoder setComputePipelineState:depthFormat?depth:color];[encoder setTexture:input.texture atIndex:0];[encoder setTexture:output atIndex:1];
    [encoder setBytes:policy length:sizeof(policy) atIndex:0];
    [encoder dispatchThreads:MTLSizeMake(output.width,output.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];
    return true;
}
}
