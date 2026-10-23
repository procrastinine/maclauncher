// SPDX-License-Identifier: GPL-3.0-or-later
#include "ls1.hpp"
#include "image-admission.hpp"
#include "metal-vk.hpp"
#include "mako-backend/ls1.hpp"
#include <algorithm>
#include <cstring>
#include <cmath>
#include <mutex>
#include <initializer_list>

namespace {
constexpr unsigned border=3;
struct alignas(16) Parameters {
 uint32_t sourceWidth,sourceHeight,capturedWidth,capturedHeight;
 uint32_t sourceOffsetX=0,sourceOffsetY=0,gammaPreprocess=0,reserved=0;
 uint32_t outputWidth,outputHeight,outputOffsetX=0,outputOffsetY=0;
};
static_assert(sizeof(Parameters)==48);
id<MTLTexture> image(id<MTLDevice>d,unsigned width,unsigned height,MTLPixelFormat format){
 auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;auto texture=macfx::newAdmittedTexture(d,descriptor,0,"ls1-memory");if(!texture)throw std::runtime_error("Cannot allocate LS1 image");return texture;
}
struct Batch {
 unsigned width,height;
 id<MTLTexture>padded,features,cropped,first,second;
 id<MTLBuffer>parameters,reconstruction;
 Batch(id<MTLDevice>d,unsigned w,unsigned h,bool performance):width(w),height(h){const auto nw=w+border*2,nh=h+border*2;padded=image(d,nw,nh,MTLPixelFormatRGBA8Unorm);features=image(d,nw*2,nh*2,MTLPixelFormatR8Snorm);cropped=image(d,w*2,h*2,MTLPixelFormatR8Snorm);if(!performance){first=image(d,nw,nh,MTLPixelFormatRGBA8Unorm);second=image(d,nw,nh,MTLPixelFormatRGBA8Unorm);}parameters=[d newBufferWithLength:sizeof(Parameters) options:MTLResourceStorageModeShared];reconstruction=[d newBufferWithLength:sizeof(Parameters) options:MTLResourceStorageModeShared];if(!parameters||!reconstruction)throw std::runtime_error("Cannot allocate LS1 parameters");}
};
id<MTLComputePipelineState> makeBorder(id<MTLDevice>d){const char*text=R"MSL(#include <metal_stdlib>
using namespace metal;
kernel void edge_pad(texture2d<float,access::read>source [[texture(0)]],texture2d<float,access::write>output [[texture(1)]],uint2 p [[thread_position_in_grid]]) {
 if(p.x>=output.get_width()||p.y>=output.get_height())return;
 const uint2 position=uint2(clamp(int2(p)-3,int2(0),int2(source.get_width()-1,source.get_height()-1)));
 output.write(source.read(position),p);
})MSL";NSError*error=nil;auto library=[d newLibraryWithSource:@(text) options:nil error:&error];auto pipeline=library?[d newComputePipelineStateWithFunction:[library newFunctionWithName:@"edge_pad"] error:&error]:nil;if(!pipeline)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot create LS1 border processing");return pipeline;}
void dispatch(id<MTLCommandBuffer>commands,const vk::Shader&shader,std::initializer_list<id<MTLTexture>>textures,id<MTLBuffer>parameters,id<MTLSamplerState>sampler,unsigned width,unsigned height){auto encoder=[commands computeCommandEncoder];if(!encoder)throw std::runtime_error("Cannot create LS1 encoder");[encoder setComputePipelineState:shader.pipeline];unsigned index=0;for(auto texture:textures)[encoder setTexture:texture atIndex:index++];if(parameters)[encoder setBuffer:parameters offset:0 atIndex:0];if(sampler)[encoder setSamplerState:sampler atIndex:0];[encoder dispatchThreadgroups:MTLSizeMake((width+15)/16,(height+15)/16,1) threadsPerThreadgroup:shader.group];[encoder endEncoding];}
}
struct macfx::Ls1Encoder::Impl {
 id<MTLDevice>device;bool performance;unsigned variant;std::string hash;
 vk::Shader first,reconstruction;std::unique_ptr<vk::Shader>second,third;vk::Sampler sampler;id<MTLComputePipelineState>padding;
 std::mutex mutex;std::vector<std::shared_ptr<Batch>>pool;
 Impl(id<MTLDevice>d,const Ls1Config&config):device(d),performance(config.performance){
  if(!device||config.modelPath.empty()||!std::isfinite(config.sharpness)||config.sharpness<0||config.sharpness>1)throw std::runtime_error("Invalid LS1 device, model or sharpness");
  const auto shaders=mako::backend::loadLs1ShaderSet(config.modelPath,performance?mako::backend::Ls1Mode::Performance:mako::backend::Ls1Mode::Quality,config.sharpness);hash=shaders.dllSha256;variant=shaders.modelVariant;vk::Vulkan host(device);first=vk::Shader(host,shaders.stage1,1,1,1,1,0);reconstruction=vk::Shader(host,shaders.reconstruction,4,2,1,1,1);if(!performance){second=std::make_unique<vk::Shader>(host,shaders.stage2,2,1,1,0,0);third=std::make_unique<vk::Shader>(host,shaders.stage3,3,1,1,1,0);}sampler=vk::Sampler(host,2);padding=makeBorder(device);
 }
 std::shared_ptr<Batch>acquire(unsigned w,unsigned h){for(auto&batch:pool)if(batch.use_count()==1&&batch->width==w&&batch->height==h)return batch;pool.erase(std::remove_if(pool.begin(),pool.end(),[](const auto&batch){return batch.use_count()==1;}),pool.end());if(pool.size()>=4)return {};auto batch=std::make_shared<Batch>(device,w,h,performance);pool.push_back(batch);return batch;}
};
macfx::Ls1Encoder::Ls1Encoder(id<MTLDevice>d,const Ls1Config&c):impl(std::make_shared<Impl>(d,c)){}
macfx::Ls1Encoder::~Ls1Encoder()=default;
const std::string&macfx::Ls1Encoder::modelHash()const{return impl->hash;}
unsigned macfx::Ls1Encoder::modelVariant()const{return impl->variant;}
macfx::SpatialStatus macfx::Ls1Encoder::encode(id<MTLCommandBuffer>commands,const SpatialFrame&frame){
 SpatialStatus result;result.requested=result.active=SpatialMethod::LS1;result.frameId=frame.frameId;result.inputWidth=frame.source.width;result.inputHeight=frame.source.height;result.outputWidth=frame.output.width;result.outputHeight=frame.output.height;auto reject=[&](const char*reason){result.reason=reason;return result;};
 if(!commands||!frame.source||!frame.output||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences)return reject("LS1 requires an unsubmitted retaining command buffer and images");
 if(commands.device!=impl->device||frame.source.device!=impl->device||frame.output.device!=impl->device||frame.source==frame.output)return reject("LS1 requires distinct images on the same device");
 auto format=[](MTLPixelFormat f){return f==MTLPixelFormatRGBA8Unorm||f==MTLPixelFormatBGRA8Unorm;};
 if(!format(frame.source.pixelFormat)||!format(frame.output.pixelFormat)||frame.color!=SpatialColor::Perceptual||frame.source.textureType!=MTLTextureType2D||frame.output.textureType!=MTLTextureType2D||frame.source.sampleCount!=1||frame.output.sampleCount!=1)return reject("LS1 requires opaque SDR resolved RGBA8 or BGRA8 images");
 if(!frame.source.width||!frame.source.height||frame.source.width>8192-border*2||frame.source.height>8192-border*2||frame.output.width<frame.source.width||frame.output.height<frame.source.height||frame.output.width>frame.source.width*2||frame.output.height>frame.source.height*2)return reject("LS1 output dimensions must be between one and two times the source");
 if(!(frame.source.usage&MTLTextureUsageShaderRead)||!(frame.output.usage&MTLTextureUsageShaderWrite)||frame.source.framebufferOnly||frame.output.framebufferOnly)return reject("LS1 images need shader read/write access");
 try{std::lock_guard<std::mutex>lock(impl->mutex);auto batch=impl->acquire(frame.source.width,frame.source.height);if(!batch)return reject("LS1 image queue is full");auto lease=std::make_shared<std::shared_ptr<Batch>>(batch);[commands addCompletedHandler:^(id<MTLCommandBuffer>){lease->reset();}];const unsigned w=frame.source.width,h=frame.source.height,nw=w+2*border,nh=h+2*border;Parameters neural{nw,nh,nw,nh,0,0,0,0,unsigned(frame.output.width),unsigned(frame.output.height)},reconstruction{w,h,w,h,0,0,0,0,unsigned(frame.output.width),unsigned(frame.output.height)};memcpy(batch->parameters.contents,&neural,sizeof(neural));memcpy(batch->reconstruction.contents,&reconstruction,sizeof(reconstruction));
  auto padding=[commands computeCommandEncoder];if(!padding)throw std::runtime_error("Cannot encode LS1 border processing");[padding setComputePipelineState:impl->padding];[padding setTexture:frame.source atIndex:0];[padding setTexture:batch->padded atIndex:1];[padding dispatchThreads:MTLSizeMake(nw,nh,1) threadsPerThreadgroup:MTLSizeMake(16,16,1)];[padding endEncoding];
  dispatch(commands,impl->first,{batch->padded,impl->performance?batch->features:batch->first},batch->parameters,nil,nw,nh);if(!impl->performance){dispatch(commands,*impl->second,{batch->first,batch->second},nil,nil,nw,nh);dispatch(commands,*impl->third,{batch->second,batch->features},batch->parameters,nil,nw,nh);}
  auto crop=[commands blitCommandEncoder];if(!crop)throw std::runtime_error("Cannot encode LS1 feature crop");[crop copyFromTexture:batch->features sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(border*2,border*2,0) sourceSize:MTLSizeMake(w*2,h*2,1) toTexture:batch->cropped destinationSlice:0 destinationLevel:0 destinationOrigin:MTLOriginMake(0,0,0)];[crop endEncoding];dispatch(commands,impl->reconstruction,{batch->cropped,frame.source,frame.output},batch->reconstruction,impl->sampler.object,frame.output.width,frame.output.height);
  result.encoded=true;
 }catch(const std::exception&e){result.reason=e.what();}return result;
}
