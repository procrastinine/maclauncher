#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "color-conversion.hpp"
#include "color-formats.hpp"
#include "color-island.hpp"
#include "gpu-completion.hpp"
#include "image-admission.hpp"
#include "metal-library-cache.hpp"
#include <atomic>
#include <array>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
#include <stdexcept>

namespace macfx::ffx_image {
inline ImageColorDescription inputColor(const ShaderFrame&f,bool declared,const ImageColorDescription&value){
 auto color=declared?value:describeImageColor(f.color==SpatialColor::HDR?ImageColorSpace::ExtendedSRGB:f.color==SpatialColor::Linear?ImageColorSpace::LinearSRGB:ImageColorSpace::SRGB);
 if(f.opaqueDisplay)color.alpha=ColorAlpha::Opaque;return color;
}
inline std::string validate(const ShaderFrame&f){
 if(!f.commands||!f.source||!f.target||f.source==f.target||f.commands.status>=MTLCommandBufferStatusCommitted||!f.commands.retainedReferences)return "FidelityFX image filters require separate images and retaining unsubmitted commands";
 if(f.source.device!=f.commands.device||f.target.device!=f.commands.device||f.source.textureType!=MTLTextureType2D||f.target.textureType!=MTLTextureType2D||f.source.sampleCount!=1||f.target.sampleCount!=1||f.source.width!=f.target.width||f.source.height!=f.target.height||!f.source.width||!f.source.height||!imageRGBFormat(f.source.pixelFormat)||!imageRGBFormat(f.target.pixelFormat))return "FidelityFX image filters require same-extent resolved RGB images on the caller's device";
 if(f.source.framebufferOnly||(f.source.usage!=MTLTextureUsageUnknown&&!(f.source.usage&MTLTextureUsageShaderRead))||(f.target.usage!=MTLTextureUsageUnknown&&!(f.target.usage&MTLTextureUsageRenderTarget)))return "FidelityFX image filters require readable RGB input and a renderable output";return {};
}
// The input, result and encoded images are rewritten before they are read in
// each frame, so filters with the same extent and queue share one device copy.
inline PooledImage texture(id<MTLDevice>device,id<MTLCommandQueue>queue,const char*role,unsigned width,unsigned height,MTLPixelFormat format,bool compute){
 auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget|(compute?MTLTextureUsageShaderWrite:0);
 return shareWorkingImage(device,descriptor,role,queue);
}
inline const char*finishSource=R"FFX_BOUNDARY(
#include <metal_stdlib>
using namespace metal;
struct FfxImageVertex {float4 p[[position]];};
vertex FfxImageVertex ffx_image_vertex(uint i[[vertex_id]]){float2 q=float2((i<<1)&2,i&2);return{float4(q*2-1,0,1)};}
fragment float4 ffx_image_finish(FfxImageVertex v[[stage_in]],texture2d<float,access::read>rgb[[texture(0)]],texture2d<float,access::read>source[[texture(1)]]){
 uint2 p=uint2(v.p.xy);return float4(rgb.read(p).rgb,source.read(p).a);
}
)FFX_BOUNDARY";
struct Resources {
 id<MTLDevice>device;id<MTLCommandQueue>queue;unsigned width=0,height=0;MTLPixelFormat format=MTLPixelFormatInvalid;
 std::string variant;ImageColorDescription color,linear;id<MTLTexture>input,result,encoded;PooledImage pooledInput,pooledResult,pooledEncoded;
 id<MTLComputePipelineState>pipeline;id<MTLRenderPipelineState>finish;id<MTLSamplerState>sampler;
 std::unique_ptr<ColorEncoder>incoming,outgoing;std::atomic<bool>failed{false};
 bool matches(const ShaderFrame&f,const ImageColorDescription&c,const std::string&name)const{return !failed.load()&&device==f.commands.device&&queue==f.commands.commandQueue&&width==f.source.width&&height==f.source.height&&format==f.target.pixelFormat&&variant==name&&sameImageColorDescription(color,c);}
 template<class Shader>void prepare(const ShaderFrame&f,const ImageColorDescription&c,const Shader&shader){
  device=f.commands.device;queue=f.commands.commandQueue;width=unsigned(f.source.width);height=unsigned(f.source.height);format=f.target.pixelFormat;variant=shader.name;color=c;linear=c;linear.transfer=ColorTransfer::Linear;linear.range=ColorRange::Full;linear.alpha=ColorAlpha::Straight;
  NSError*error=nil;auto library=cachedMetalLibrary(device,shader.source,&error);if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot compile the original FidelityFX image kernel");auto function=[library newFunctionWithName:[NSString stringWithUTF8String:shader.entry]];if(function)pipeline=[device newComputePipelineStateWithFunction:function error:&error];if(!pipeline||shader.x*shader.y*shader.z>pipeline.maxTotalThreadsPerThreadgroup)throw std::runtime_error(error.localizedDescription.UTF8String?:"The FidelityFX image workgroup is unsupported");
  auto boundary=cachedMetalLibrary(device,finishSource,&error);if(!boundary)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot compile the FidelityFX alpha boundary");auto descriptor=[MTLRenderPipelineDescriptor new];descriptor.vertexFunction=[boundary newFunctionWithName:@"ffx_image_vertex"];descriptor.fragmentFunction=[boundary newFunctionWithName:@"ffx_image_finish"];descriptor.colorAttachments[0].pixelFormat=format;finish=[device newRenderPipelineStateWithDescriptor:descriptor error:&error];if(!finish)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot prepare the FidelityFX alpha boundary");
  auto sampling=[MTLSamplerDescriptor new];sampling.minFilter=MTLSamplerMinMagFilterLinear;sampling.magFilter=MTLSamplerMinMagFilterLinear;sampling.mipFilter=MTLSamplerMipFilterNotMipmapped;sampling.sAddressMode=MTLSamplerAddressModeClampToEdge;sampling.tAddressMode=MTLSamplerAddressModeClampToEdge;sampler=[device newSamplerStateWithDescriptor:sampling];if(!sampler)throw std::runtime_error("Cannot prepare FidelityFX image sampling");
  pooledInput=texture(device,queue,"ffx-image.input",width,height,MTLPixelFormatRGBA32Float,false);pooledResult=texture(device,queue,"ffx-image.result",width,height,MTLPixelFormatRGBA32Float,true);pooledEncoded=texture(device,queue,"ffx-image.encoded",width,height,format,false);
  input=pooledInput.texture();result=pooledResult.texture();encoded=pooledEncoded.texture();
  incoming=std::make_unique<ColorEncoder>(device);outgoing=std::make_unique<ColorEncoder>(device);auto a=incoming->prepare(MTLPixelFormatRGBA32Float),b=outgoing->prepare(format);if(!a.encoded||!b.encoded)throw std::runtime_error(!a.encoded?a.reason:b.reason);
 }
 ShaderResult enter(const ShaderFrame&f){ColorConversion c;c.source=color;c.target=linear;c.frameId=f.frameId;c.flipY=f.origin==FrameOrigin::BottomLeft;return incoming->encode(f.commands,f.source,input,c);}
 ShaderResult leave(const ShaderFrame&f,bool identity=false){
  ColorConversion c;c.source=identity?color:linear;c.target=color;c.frameId=f.frameId;c.flipY=!identity&&f.origin==FrameOrigin::BottomLeft;c.alphaSource=identity?f.source:input;
  auto converted=outgoing->encode(f.commands,identity?f.source:result,encoded,c);if(!converted.encoded)return converted;
  // Restore storage alpha independently of its semantic opaque declaration.
  // Only this final successful pass writes the caller's composed output.
  auto pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=f.target;pass.colorAttachments[0].loadAction=MTLLoadActionDontCare;pass.colorAttachments[0].storeAction=MTLStoreActionStore;auto encoder=[f.commands renderCommandEncoderWithDescriptor:pass];if(!encoder)return{false,"Cannot encode the FidelityFX alpha boundary",false};[encoder setRenderPipelineState:finish];[encoder setFragmentTexture:encoded atIndex:0];[encoder setFragmentTexture:f.source atIndex:1];[encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];[encoder endEncoding];return{true,{}};
 }
};
inline std::shared_ptr<Resources>resources(){static auto retirement=dispatch_queue_create("MacLauncher FidelityFX image retirement",DISPATCH_QUEUE_SERIAL);return std::shared_ptr<Resources>(new Resources,[](Resources*p){dispatch_async(retirement,^{delete p;});});}
struct Flight {
 std::shared_ptr<Resources>resources;GPUCompletionFence fence;
 ShaderResult completion()const{if(fence.completed())return{true,{}};if(fence.failed())return{false,"The FidelityFX image command buffer failed",false};return{false,"The FidelityFX image command buffer is pending",true};}
};
// The completion reaches the resources through its flight: a block captures
// the reference parameter `r` by reference, and the caller's pointer is gone.
inline std::shared_ptr<Flight>begin(const ShaderFrame&f,const std::shared_ptr<Resources>&r){
 auto flight=std::make_shared<Flight>();flight->resources=r;flight->fence.bind(f.commands);auto source=f.source,target=f.target;
 [f.commands addCompletedHandler:^(id<MTLCommandBuffer>commands){flight->fence.observe(commands);if(commands.status!=MTLCommandBufferStatusCompleted)flight->resources->failed=true;(void)source;(void)target;}];return flight;
}
template<class Shader,class Constants>void dispatch(const ShaderFrame&f,const std::shared_ptr<Resources>&r,const Shader&shader,const Constants&constants,const std::array<unsigned,3>&groups,const char*sourceName,const char*targetName){
 auto encoder=[f.commands computeCommandEncoder];if(!encoder)throw std::runtime_error("Cannot encode the FidelityFX image kernel");[encoder setComputePipelineState:r->pipeline];
 for(size_t i=0;i<shader.count;++i){const auto&b=shader.bindings[i];if(!std::strcmp(b.kind,"texture")){if(!std::strcmp(b.name,sourceName))[encoder setTexture:r->input atIndex:b.index];else if(!std::strcmp(b.name,targetName))[encoder setTexture:r->result atIndex:b.index];else throw std::runtime_error("Unknown FidelityFX image texture binding");}else if(!std::strcmp(b.kind,"buffer"))[encoder setBytes:&constants length:sizeof(constants)atIndex:b.index];else if(!std::strcmp(b.kind,"sampler"))[encoder setSamplerState:r->sampler atIndex:b.index];else throw std::runtime_error("Unknown FidelityFX image resource binding");}
 [encoder dispatchThreadgroups:MTLSizeMake(groups[0],groups[1],groups[2])threadsPerThreadgroup:MTLSizeMake(shader.x,shader.y,shader.z)];[encoder endEncoding];
}
}
