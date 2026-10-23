// SPDX-License-Identifier: GPL-3.0-or-later
// Owned Metal execution adapter for the read-only MAKO shader graph.
#pragma once
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <vulkan/vulkan_core.h>
#include <functional>
#include "spirv_msl.hpp"
#include <algorithm>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>
namespace vk {
using Barrier=VkImageMemoryBarrier;
class Vulkan {public:id<MTLDevice> device; explicit Vulkan(id<MTLDevice> d):device(d){};};
class ImageMemoryPool{};
class DescriptorPool{};
class Image {
public:
 id<MTLTexture> texture;
 Image(const Vulkan& vk,VkExtent2D extent,std::shared_ptr<ImageMemoryPool>,VkFormat format=VK_FORMAT_R8G8B8A8_UNORM) {
   MTLPixelFormat pf;
   switch(format){case VK_FORMAT_R8_UNORM:pf=MTLPixelFormatR8Unorm;break;case VK_FORMAT_R16G16B16A16_SFLOAT:pf=MTLPixelFormatRGBA16Float;break;case VK_FORMAT_R8G8B8A8_UNORM:pf=MTLPixelFormatRGBA8Unorm;break;default:throw std::runtime_error("Unsupported graph image format");}
   auto desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:pf width:extent.width height:extent.height mipmapped:NO];
   desc.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;desc.storageMode=MTLStorageModeShared;texture=[vk.device newTextureWithDescriptor:desc];
   if(!texture)throw std::runtime_error("Cannot allocate graph image");
   // Stable, initialized history rather than undefined first-frame contents.
   const size_t stride=extent.width*(pf==MTLPixelFormatR8Unorm?1:pf==MTLPixelFormatRGBA16Float?8:4);
   std::vector<uint8_t> zeros(stride*extent.height);
   [texture replaceRegion:MTLRegionMake2D(0,0,extent.width,extent.height) mipmapLevel:0 withBytes:zeros.data() bytesPerRow:stride];
 }
 VkImage handle()const{return (VkImage)(__bridge void*)texture;}
 VkExtent2D getExtent()const{return {(uint32_t)texture.width,(uint32_t)texture.height};}
};
class Buffer {public:id<MTLBuffer> object;Buffer()=default;template<typename T>Buffer(const Vulkan& vk,const T& data){object=[vk.device newBufferWithBytes:&data length:sizeof(T) options:MTLResourceStorageModeShared];}template<typename T>void write(const Vulkan&,const T& data){memcpy(object.contents,&data,sizeof(T));}};
class Sampler {public:id<MTLSamplerState> object;Sampler()=default;Sampler(const Vulkan& vk,unsigned mode){auto d=[MTLSamplerDescriptor new];d.minFilter=d.magFilter=MTLSamplerMinMagFilterLinear;d.sAddressMode=d.tAddressMode=mode==2?MTLSamplerAddressModeClampToEdge:MTLSamplerAddressModeClampToBorderColor;d.borderColor=mode==1?MTLSamplerBorderColorOpaqueWhite:MTLSamplerBorderColorTransparentBlack;object=[vk.device newSamplerStateWithDescriptor:d];}};
class Shader {
public:id<MTLComputePipelineState> pipeline;MTLSize group={1,1,1};unsigned resource=0;size_t sampledCount=0,storageCount=0,samplerCount=0,bufferCount=0;
 Shader()=default;
 Shader(const Vulkan& vk,const std::vector<uint8_t>& bytes,unsigned id,size_t sampled,size_t storage,size_t buffers,size_t samplers):resource(id),sampledCount(sampled),storageCount(storage),samplerCount(samplers),bufferCount(buffers){
  if(bytes.size()<20||bytes.size()%4)throw std::runtime_error("Invalid compute shader payload");
  std::vector<uint32_t> words(bytes.size()/4);memcpy(words.data(),bytes.data(),bytes.size());
  bool localSize=false;for(size_t i=5;i<words.size();){unsigned wc=words[i]>>16,op=words[i]&65535;if(!wc||i+wc>words.size())throw std::runtime_error("Invalid SPIR-V instruction");if(op==16&&wc==6&&words[i+2]==17){group=MTLSizeMake(words[i+3],words[i+4],words[i+5]);localSize=true;}i+=wc;}if(!localSize||!group.width||!group.height||!group.depth)throw std::runtime_error("Missing shader local size");
  spirv_cross::CompilerMSL compiler(words);auto options=compiler.get_msl_options();options.set_msl_version(2,3);compiler.set_msl_options(options);
  const auto resources=compiler.get_shader_resources(compiler.get_active_interface_variables());
  auto bind=[&](const auto &values,unsigned kind,uint32_t base,size_t count){
   for(const auto&r:values){spirv_cross::MSLResourceBinding binding{};binding.stage=spv::ExecutionModelGLCompute;binding.desc_set=compiler.get_decoration(r.id,spv::DecorationDescriptorSet);binding.binding=compiler.get_decoration(r.id,spv::DecorationBinding);
    if(binding.desc_set!=0||binding.binding<base||binding.binding-base>=count)throw std::runtime_error("Unsupported active model binding");
    const auto index=binding.binding-base;if(kind==0)binding.msl_texture=index;if(kind==1)binding.msl_texture=sampledCount+index;if(kind==2)binding.msl_sampler=index;if(kind==3)binding.msl_buffer=index;compiler.add_msl_resource_binding(binding);}};
  bind(resources.separate_images,0,32,sampledCount);bind(resources.storage_images,1,48,storageCount);bind(resources.separate_samplers,2,16,samplerCount);bind(resources.uniform_buffers,3,0,bufferCount);
  if(!resources.sampled_images.empty()||!resources.storage_buffers.empty())throw std::runtime_error("Unsupported model resource interface");
  const auto msl=compiler.compile();NSError *error=nil;auto library=[vk.device newLibraryWithSource:@(msl.c_str()) options:nil error:&error];
  pipeline=library?[vk.device newComputePipelineStateWithFunction:[library newFunctionWithName:@"main0"] error:&error]:nil;
  if(!pipeline)throw std::runtime_error(std::string("Model resource ")+std::to_string(id)+": "+(error.localizedDescription.UTF8String?:"cannot compile"));
  if(group.width*group.height*group.depth>pipeline.maxTotalThreadsPerThreadgroup)throw std::runtime_error("Model workgroup exceeds device limits");
 }

};
class DescriptorSet {
public:std::vector<id<MTLTexture>> textures;std::vector<id<MTLSamplerState>> samplers;std::vector<id<MTLBuffer>> buffers;
 DescriptorSet(const Vulkan&,const DescriptorPool&,const Shader&shader,const std::vector<std::reference_wrapper<const Image>>& sampled,const std::vector<std::reference_wrapper<const Image>>& storage,const std::vector<std::reference_wrapper<const Sampler>>& sampler,const std::vector<std::reference_wrapper<const Buffer>>& buffer){if(sampled.size()!=shader.sampledCount||storage.size()!=shader.storageCount||sampler.size()!=shader.samplerCount||buffer.size()!=shader.bufferCount)throw std::runtime_error("Graph resource bindings do not match the validated model");for(const auto &i:sampled)textures.push_back(i.get().texture);for(const auto &i:storage)textures.push_back(i.get().texture);for(const auto &s:sampler)samplers.push_back(s.get().object);for(const auto &b:buffer)buffers.push_back(b.get().object);}
};
class CommandBuffer {
public:id<MTLCommandBuffer> object;mutable unsigned dispatchCount=0;
 explicit CommandBuffer(id<MTLCommandBuffer> cb):object(cb){}
 // Each dispatch ends its encoder. Tracked Metal resources establish the
 // producer/consumer dependencies between those encoders, including batches
 // which upstream's Vulkan implementation records behind one barrier.
 void insertComputeBarriers(const Vulkan&,const std::vector<Barrier>& barriers)const{
  for(const auto& barrier:barriers){
   id<MTLTexture> texture=(__bridge id<MTLTexture>)barrier.image;
   if(!texture||texture.hazardTrackingMode==MTLHazardTrackingModeUntracked)
    throw std::runtime_error("Model graph requires tracked Metal image resources");
  }
 }
 void dispatchAfterBarrier(const Vulkan& vk,const Shader& shader,const DescriptorSet& set,unsigned x,unsigned y,unsigned z)const{
  dispatch(vk,shader,set,{},x,y,z);
 }
 void dispatch(const Vulkan& vk,const Shader& shader,const DescriptorSet& set,const std::vector<Barrier>& barriers,unsigned x,unsigned y,unsigned z)const{
  insertComputeBarriers(vk,barriers);
  auto e=[object computeCommandEncoder];e.label=[NSString stringWithFormat:@"LSFG resource %u",shader.resource];[e setComputePipelineState:shader.pipeline];
  for(size_t i=0;i<set.textures.size();++i)[e setTexture:set.textures[i] atIndex:i];
  for(size_t i=0;i<set.samplers.size();++i)[e setSamplerState:set.samplers[i] atIndex:i];
  for(size_t i=0;i<set.buffers.size();++i)[e setBuffer:set.buffers[i] offset:0 atIndex:i];
  [e dispatchThreadgroups:MTLSizeMake(x,y,z) threadsPerThreadgroup:shader.group];[e endEncoding];++dispatchCount;
 }
};
}
