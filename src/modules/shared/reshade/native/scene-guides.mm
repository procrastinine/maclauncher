// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-guides.hpp"
#include "metal-library-cache.hpp"
#import <Foundation/Foundation.h>
#include <simd/simd.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace macfx { namespace {
struct Uniforms {simd_uint2 origin,extent;simd_float2 scale,bias,offset;};
static_assert(sizeof(Uniforms)==40);
bool depthFormat(MTLPixelFormat value){
    switch(value){
        case MTLPixelFormatDepth16Unorm:case MTLPixelFormatDepth32Float:
        case MTLPixelFormatDepth32Float_Stencil8:case MTLPixelFormatDepth24Unorm_Stencil8:return true;
        default:return false;
    }
}
bool scalarFormat(MTLPixelFormat value){
    switch(value){
        case MTLPixelFormatR8Unorm:case MTLPixelFormatR8Snorm:
        case MTLPixelFormatR16Unorm:case MTLPixelFormatR16Snorm:
        case MTLPixelFormatR16Float:case MTLPixelFormatR32Float:return true;
        default:return false;
    }
}
bool vectorFormat(MTLPixelFormat value){
    switch(value){
        case MTLPixelFormatRG8Unorm:case MTLPixelFormatRG8Snorm:
        case MTLPixelFormatRG16Unorm:case MTLPixelFormatRG16Snorm:
        case MTLPixelFormatRG16Float:case MTLPixelFormatRG32Float:
        case MTLPixelFormatRGBA16Float:case MTLPixelFormatRGBA32Float:return true;
        default:return false;
    }
}
bool region(id<MTLTexture> texture,uint32_t x,uint32_t y,uint32_t width,uint32_t height){
    return texture&&width&&height&&x<=texture.width&&y<=texture.height&&
        width<=texture.width-x&&height<=texture.height-y;
}
struct Job {
    id<MTLTexture> source=nil,target=nil;
    Uniforms uniforms{};
    bool depth=false,exposure=false;unsigned kind=2;
};
}

SceneGuideEncoder::SceneGuideEncoder(id<MTLDevice> value):device(value){
    if(!device)throw std::runtime_error("Scene guide normalization requires the current GPU device.");
}
ShaderResult SceneGuideEncoder::prepare(){@autoreleasepool{try{
    std::lock_guard<std::mutex> guard(preparation);
    if(ready.load(std::memory_order_acquire))return {true,{}};
    NSString *source=[NSString stringWithUTF8String:R"metal(
#include <metal_stdlib>
using namespace metal;
struct Uniforms {uint2 origin,extent;float2 scale,bias,offset;};
uint2 location(uint2 p,uint2 target,constant Uniforms& u){
    return u.origin+uint2(clamp(floor((float2(p)+0.5f)*float2(u.extent)/float2(target)+u.offset),float2(0),float2(u.extent-1)));
}
kernel void guides_color(texture2d<float,access::read> input [[texture(0)]],
                         texture2d<float,access::write> output [[texture(1)]],
                         constant Uniforms& u [[buffer(0)]],uint2 p [[thread_position_in_grid]]){
    uint2 target(output.get_width(),output.get_height());if(any(p>=target))return;
    float4 value=input.read(location(p,target,u));value.xy=value.xy*u.scale+u.bias;output.write(value,p);
}
kernel void guides_depth(depth2d<float,access::sample> input [[texture(0)]],
                         texture2d<float,access::write> output [[texture(1)]],
                         constant Uniforms& u [[buffer(0)]],uint2 p [[thread_position_in_grid]]){
    uint2 target(output.get_width(),output.get_height());if(any(p>=target))return;
    constexpr sampler nearest(coord::pixel,address::clamp_to_edge,filter::nearest);
    output.write(float4(input.sample(nearest,float2(location(p,target,u))+0.5f)),p);
}
)metal"];
    NSError *error=nil;auto library=cachedMetalLibrary(device,std::string(source.UTF8String),&error);
    if(!library)return {false,error.localizedDescription.UTF8String?:"The scene guide shader could not be compiled."};
    auto nextColor=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"guides_color"] error:&error];
    auto nextDepth=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"guides_depth"] error:&error];
    if(!nextColor||!nextDepth)return {false,error.localizedDescription.UTF8String?:"The scene guide pipelines could not be prepared."};
    color=nextColor;depth=nextDepth;ready.store(true,std::memory_order_release);return {true,{}};
}catch(const std::exception& error){return {false,error.what()};}}}

ShaderResult SceneGuideEncoder::encode(id<MTLCommandBuffer> commands,const RSTemporalFrame& input,
                                       const SceneGuideTargets& target,RSTemporalFrame& normalized,float correctionX,float correctionY,bool removeMotionJitter,bool colorJittered){
    return encode(commands,input,target,normalized,correctionX,correctionY,removeMotionJitter,colorJittered,1);
}
ShaderResult SceneGuideEncoder::encode(id<MTLCommandBuffer> commands,const RSTemporalFrame& input,
                                       const SceneGuideTargets& target,RSTemporalFrame& normalized,float correctionX,float correctionY,bool removeMotionJitter,bool colorJittered,float exposureScale){
    if(!commands||!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted||
        commands.device.registryID!=device.registryID||input.version!=1||input.size<sizeof(RSTemporalFrame)||
        !input.renderWidth||!input.renderHeight||!std::isfinite(input.jitterX)||!std::isfinite(input.jitterY)||
        !std::isfinite(input.motionScaleX)||!std::isfinite(input.motionScaleY)||!std::isfinite(correctionX)||!std::isfinite(correctionY)||!std::isfinite(exposureScale)||exposureScale<=0)
        return {false,"Scene guides require a valid frame and retaining unsubmitted commands on the current GPU."};
    for(const auto& pair:std::array<std::pair<void*,id<MTLTexture>>,5>{{{input.depth,target.depth},{input.motion,target.motion},{input.exposure,target.exposure},{input.reactive,target.reactive},{input.transparency,target.transparency}}})
        if(bool(pair.first)!=bool(pair.second))return {false,"Each supplied scene guide needs its matching caller-owned target."};
    const auto anchor=target.depth?:target.motion?:target.reactive?:target.transparency;
    const auto width=target.width?target.width:uint32_t(anchor.width),height=target.height?target.height:uint32_t(anchor.height);
    if(!width||!height||(target.depth&&(target.depth.pixelFormat!=MTLPixelFormatR32Float||target.depth.width!=width||target.depth.height!=height))||
       (target.motion&&(target.motion.pixelFormat!=MTLPixelFormatRG32Float||target.motion.width!=width||target.motion.height!=height)))
        return {false,"Supply a normalized extent and matching R32Float depth or RG32Float motion targets for the available guides."};
    const uint32_t motionWidth=input.flags&RS_TEMPORAL_OUTPUT_MOTION?input.outputWidth:input.renderWidth;
    const uint32_t motionHeight=input.flags&RS_TEMPORAL_OUTPUT_MOTION?input.outputHeight:input.renderHeight;
    if(input.motion&&(!motionWidth||!motionHeight))return {false,"The motion-vector coordinate extent is empty."};
    if((target.reactive||target.transparency)&&(normalized.colorX||normalized.colorY))
        return {false,"Normalized mask coordinates require the caller's normalized color origin at zero."};
    std::array<Job,5> jobs{};unsigned count=0;
    auto append=[&](void* raw,id<MTLTexture> output,uint32_t x,uint32_t y,uint32_t w,uint32_t h,float sx=1,float sy=1){
        jobs[count++]={(__bridge id<MTLTexture>)raw,output,{simd_make_uint2(x,y),simd_make_uint2(w,h),simd_make_float2(sx,sy)},false};
    };
    if(input.depth){append(input.depth,target.depth,input.depthX,input.depthY,input.renderWidth,input.renderHeight);jobs[count-1].kind=0;}
    if(input.motion){append(input.motion,target.motion,input.motionX,input.motionY,motionWidth,motionHeight,input.motionScaleX/motionWidth,input.motionScaleY/motionHeight);jobs[count-1].kind=1;jobs[count-1].uniforms.bias=simd_make_float2(correctionX,correctionY);}
    if(input.exposure){append(input.exposure,target.exposure,0,0,1,1,exposureScale);jobs[count-1].exposure=true;}
    if(input.reactive)append(input.reactive,target.reactive,input.colorX,input.colorY,input.renderWidth,input.renderHeight);
    if(input.transparency)append(input.transparency,target.transparency,input.colorX,input.colorY,input.renderWidth,input.renderHeight);
    for(unsigned n=0;n<count;++n){auto& job=jobs[n];const auto a=job.source,b=job.target;
        if(!a||!b||a.device.registryID!=device.registryID||b.device.registryID!=device.registryID||a.textureType!=MTLTextureType2D||b.textureType!=MTLTextureType2D||
            a.sampleCount!=1||b.sampleCount!=1||a.framebufferOnly||b.framebufferOnly||
            (a.usage!=MTLTextureUsageUnknown&&!(a.usage&MTLTextureUsageShaderRead))||
            (b.usage&(MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite))!=(MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite)||
            !region(a,job.uniforms.origin.x,job.uniforms.origin.y,job.uniforms.extent.x,job.uniforms.extent.y))
            return {false,"Scene guide regions and readable/writable textures must match the current GPU."};
        if(job.kind==0){job.depth=depthFormat(a.pixelFormat);if(!job.depth&&!scalarFormat(a.pixelFormat))return {false,"The scene depth texture needs a numeric scalar format."};}
        else if(job.kind==1){if(!vectorFormat(a.pixelFormat))return {false,"The scene motion texture needs a numeric vector format."};}
        else{
            if(!scalarFormat(a.pixelFormat)||!scalarFormat(b.pixelFormat))return {false,"Optional scene guides need numeric scalar formats."};
            if(job.exposure?(a.width!=1||a.height!=1||b.width!=1||b.height!=1):(b.width!=width||b.height!=height))
                return {false,"Exposure must remain one numeric pixel; masks follow the normalized render extent."};
        }
        for(unsigned k=0;k<count;++k)if(b==jobs[k].source||(k!=n&&b==jobs[k].target))return {false,"Scene guide targets must be distinct from all source and target images."};
    }
    if(!colorJittered)for(unsigned n=0;n<count;++n)if(!jobs[n].exposure)jobs[n].uniforms.offset=simd_make_float2(-input.jitterX*jobs[n].uniforms.extent.x/input.renderWidth,-input.jitterY*jobs[n].uniforms.extent.y/input.renderHeight);
    const float jitterX=colorJittered?input.jitterX*float(width)/input.renderWidth:0,jitterY=colorJittered?input.jitterY*float(height)/input.renderHeight:0;
    if(count&&!ready.load(std::memory_order_acquire))return {false,"Prepare scene guide pipelines before encoding."};
    auto encoder=count?[commands computeCommandEncoder]:nil;if(count&&!encoder)return {false,"The scene guide encoder could not be created."};
    for(unsigned n=0;n<count;++n){const auto& job=jobs[n];[encoder setComputePipelineState:job.depth?depth:color];
        [encoder setTexture:job.source atIndex:0];[encoder setTexture:job.target atIndex:1];[encoder setBytes:&job.uniforms length:sizeof(Uniforms) atIndex:0];
        [encoder dispatchThreads:MTLSizeMake(job.target.width,job.target.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];
    }
    [encoder endEncoding];
    normalized.depth=(__bridge void*)target.depth;normalized.motion=(__bridge void*)target.motion;
    normalized.exposure=(__bridge void*)target.exposure;normalized.reactive=(__bridge void*)target.reactive;normalized.transparency=(__bridge void*)target.transparency;
    normalized.depthX=normalized.depthY=normalized.motionX=normalized.motionY=0;
    // These caller-owned targets contain only the normalized current image,
    // rather than the producer's larger dynamic-resolution backing allocation.
    normalized.renderWidth=width;normalized.renderHeight=height;normalized.maxRenderWidth=width;normalized.maxRenderHeight=height;
    normalized.jitterX=jitterX;normalized.jitterY=jitterY;
    normalized.motionScaleX=float(width);normalized.motionScaleY=float(height);normalized.flags&=~uint32_t(RS_TEMPORAL_OUTPUT_MOTION);if(removeMotionJitter)normalized.flags&=~uint32_t(RS_TEMPORAL_JITTERED_MOTION);
    return {true,{}};
}
}
