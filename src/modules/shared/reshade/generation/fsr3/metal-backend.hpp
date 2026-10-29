#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <FidelityFX/host/ffx_opticalflow.h>
#include <FidelityFX/host/ffx_frameinterpolation.h>
#include "generation-provider.h"
#include <algorithm>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <cwchar>
#include <string>
#include <vector>
namespace fsr3metal {
struct MemoryBusy final:std::runtime_error {MemoryBusy():std::runtime_error("Graphics resource memory is occupied"){};};
struct Resource {id<MTLTexture>texture=nil;id<MTLBuffer>buffer=nil;std::vector<id<MTLTexture>>mips;FfxResourceDescription description{};std::shared_ptr<void>admission;bool external=false;};
struct Atomic {unsigned slot=0,resource=0;std::string name;};
struct Pipeline {id<MTLComputePipelineState>state=nil;MTLSize threads{};std::vector<Atomic>atomics;std::vector<std::pair<unsigned,bool>>samplers;};
inline MTLPixelFormat pixel(FfxSurfaceFormat format){switch(format){
 case FFX_SURFACE_FORMAT_R32G32B32A32_TYPELESS:case FFX_SURFACE_FORMAT_R32G32B32A32_FLOAT:return MTLPixelFormatRGBA32Float;
 case FFX_SURFACE_FORMAT_R32G32B32A32_UINT:return MTLPixelFormatRGBA32Uint;
 case FFX_SURFACE_FORMAT_R16G16B16A16_FLOAT:return MTLPixelFormatRGBA16Float;
 case FFX_SURFACE_FORMAT_R32G32_FLOAT:return MTLPixelFormatRG32Float;
 case FFX_SURFACE_FORMAT_R32_UINT:return MTLPixelFormatR32Uint;
 case FFX_SURFACE_FORMAT_R8G8B8A8_TYPELESS:case FFX_SURFACE_FORMAT_R8G8B8A8_UNORM:return MTLPixelFormatRGBA8Unorm;
 case FFX_SURFACE_FORMAT_B8G8R8A8_TYPELESS:case FFX_SURFACE_FORMAT_B8G8R8A8_UNORM:return MTLPixelFormatBGRA8Unorm;
 case FFX_SURFACE_FORMAT_R8G8B8A8_SRGB:return MTLPixelFormatRGBA8Unorm_sRGB;
 case FFX_SURFACE_FORMAT_B8G8R8A8_SRGB:return MTLPixelFormatBGRA8Unorm_sRGB;
 case FFX_SURFACE_FORMAT_R11G11B10_FLOAT:return MTLPixelFormatRG11B10Float;
 case FFX_SURFACE_FORMAT_R16G16_FLOAT:return MTLPixelFormatRG16Float;
 case FFX_SURFACE_FORMAT_R16G16_UINT:return MTLPixelFormatRG16Uint;
 case FFX_SURFACE_FORMAT_R16G16_SINT:return MTLPixelFormatRG16Sint;
 case FFX_SURFACE_FORMAT_R16_FLOAT:return MTLPixelFormatR16Float;
 case FFX_SURFACE_FORMAT_R16_UINT:return MTLPixelFormatR16Uint;
 case FFX_SURFACE_FORMAT_R16_UNORM:return MTLPixelFormatR16Unorm;
 case FFX_SURFACE_FORMAT_R16_SNORM:return MTLPixelFormatR16Snorm;
 case FFX_SURFACE_FORMAT_R8_UNORM:return MTLPixelFormatR8Unorm;
 case FFX_SURFACE_FORMAT_R8_UINT:return MTLPixelFormatR8Uint;
 case FFX_SURFACE_FORMAT_R8G8_UNORM:return MTLPixelFormatRG8Unorm;
 case FFX_SURFACE_FORMAT_R8G8_UINT:return MTLPixelFormatRG8Uint;
 case FFX_SURFACE_FORMAT_R32_FLOAT:return MTLPixelFormatR32Float;
 default:return MTLPixelFormatInvalid;
}}
inline FfxSurfaceFormat surface(MTLPixelFormat format){for(unsigned i=1;i<=FFX_SURFACE_FORMAT_R32_FLOAT;++i)if(pixel(FfxSurfaceFormat(i))==format)return FfxSurfaceFormat(i);if(format==MTLPixelFormatDepth32Float||format==MTLPixelFormatDepth32Float_Stencil8)return FFX_SURFACE_FORMAT_R32_FLOAT;return FFX_SURFACE_FORMAT_UNKNOWN;}
inline FfxResource imported(id<MTLTexture>texture){FfxResource value{};if(texture){value.resource=(__bridge void*)texture;value.state=FFX_RESOURCE_STATE_COMPUTE_READ;value.description={FFX_RESOURCE_TYPE_TEXTURE2D,surface(texture.pixelFormat),uint32_t(texture.width),uint32_t(texture.height),1,uint32_t(texture.mipmapLevelCount),FFX_RESOURCE_FLAGS_NONE,FFX_RESOURCE_USAGE_READ_ONLY};}return value;}
class Backend {
 RSGenerationOptions host;std::vector<Resource>resources{1};std::vector<std::unique_ptr<Pipeline>>pipelines;std::vector<FfxGpuJobDescription>jobs;std::vector<std::vector<uint32_t>>constants;size_t constantCursor=0;
 id<MTLSamplerState>point=nil,linear=nil;id<MTLComputePipelineState>clearFloat=nil,clearUint=nil,clearSint=nil,clearBuffer=nil;
 static Backend&get(FfxInterface*api){return *static_cast<Backend*>(api->scratchBuffer);}
 FfxErrorCode fail(std::string value){error=std::move(value);return FFX_ERROR_BACKEND_API_ERROR;}
 std::shared_ptr<void>reserve(uint64_t bytes){if(!host.reserve)return {};void*value=host.reserve(host.allocationContext,bytes);if(!value){memoryBusy=true;throw MemoryBusy();}return {value,host.release};}
 Resource*resource(FfxResourceInternal index){return index.internalIndex>0&&size_t(index.internalIndex)<resources.size()?&resources[index.internalIndex]:nullptr;}
 static void binding(FfxResourceBinding&value,const std::string&name,unsigned slot){value.slotIndex=slot;for(size_t n=0;n<name.size()&&n<FFX_RESOURCE_NAME_SIZE-1;++n)value.name[n]=wchar_t(uint8_t(name[n]));}
 FfxErrorCode create(const FfxCreateResourceDescription&description,FfxResourceInternal&output){try{
  Resource value;value.description=description.resourceDescription;const auto&d=value.description;
  const bool initialized=description.initData.type!=FFX_RESOURCE_INIT_DATA_TYPE_UNINITIALIZED;
  if(d.type==FFX_RESOURCE_TYPE_BUFFER){const auto options=initialized?MTLResourceStorageModeShared:MTLResourceStorageModePrivate;const auto bytes=[device heapBufferSizeAndAlignWithLength:d.size options:options].size;value.admission=reserve(bytes);value.buffer=[device newBufferWithLength:d.size options:options];if(!value.buffer)return fail("Metal could not create an SDK buffer");if(initialized){if(description.initData.type==FFX_RESOURCE_INIT_DATA_TYPE_BUFFER)std::memcpy(value.buffer.contents,description.initData.buffer,std::min(size_t(d.size),description.initData.size));else std::memset(value.buffer.contents,description.initData.value,d.size);}}
  else{
   if(d.type!=FFX_RESOURCE_TYPE_TEXTURE2D||!d.width||!d.height||pixel(d.format)==MTLPixelFormatInvalid)return fail("The SDK requested an unsupported texture description");
   auto td=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:pixel(d.format) width:d.width height:d.height mipmapped:d.mipCount!=1];if(d.mipCount)td.mipmapLevelCount=d.mipCount;td.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsagePixelFormatView;td.storageMode=initialized?MTLStorageModeShared:MTLStorageModePrivate;
   if(td.pixelFormat==MTLPixelFormatR32Uint){const auto alignment=[device minimumLinearTextureAlignmentForPixelFormat:td.pixelFormat],row=(d.width*4+alignment-1)&~(alignment-1);td.storageMode=MTLStorageModeShared;value.admission=reserve([device heapBufferSizeAndAlignWithLength:row*d.height options:MTLResourceStorageModeShared].size);value.buffer=[device newBufferWithLength:row*d.height options:MTLResourceStorageModeShared];value.texture=[value.buffer newTextureWithDescriptor:td offset:0 bytesPerRow:row];}
   else{value.admission=reserve([device heapTextureSizeAndAlignWithDescriptor:td].size);value.texture=[device newTextureWithDescriptor:td];}
   if(!value.texture)return fail("Metal could not create an SDK texture");
   if(initialized){std::vector<uint8_t>fill;const void*bytes=description.initData.buffer;if(description.initData.type==FFX_RESOURCE_INIT_DATA_TYPE_VALUE){fill.assign(description.initData.size,description.initData.value);bytes=fill.data();}[value.texture replaceRegion:MTLRegionMake2D(0,0,d.width,d.height) mipmapLevel:0 withBytes:bytes bytesPerRow:description.initData.size/d.height];}
   value.description.mipCount=value.texture.mipmapLevelCount;for(unsigned mip=0;mip<value.texture.mipmapLevelCount;++mip)value.mips.push_back(value.texture.mipmapLevelCount==1?value.texture:[value.texture newTextureViewWithPixelFormat:td.pixelFormat textureType:MTLTextureType2D levels:NSMakeRange(mip,1) slices:NSMakeRange(0,1)]);
  }
  output.internalIndex=int(resources.size());resources.push_back(std::move(value));return FFX_OK;
 }catch(const std::exception&issue){return fail(issue.what());}}
 FfxErrorCode pipeline(FfxEffect effect,FfxPass pass,uint32_t permutation,FfxPipelineState&output){
  const bool optical=effect==FFX_EFFECT_OPTICALFLOW;if(!optical&&effect!=FFX_EFFECT_FRAMEINTERPOLATION)return fail("The shader belongs to another FidelityFX effect");
  const unsigned variant=optical?(permutation>>2)&1:permutation&7;
  NSString*base=[NSString stringWithFormat:@"%s/%s/%u/%u",directory.c_str(),optical?"opticalflow":"frameinterpolation",variant,unsigned(pass)];NSError*issue=nil;
  NSString*source=[NSString stringWithContentsOfFile:[base stringByAppendingString:@".metal"] encoding:NSUTF8StringEncoding error:&issue];NSData*data=[NSData dataWithContentsOfFile:[base stringByAppendingString:@".json"]];NSDictionary*metadata=data?[NSJSONSerialization JSONObjectWithData:data options:0 error:&issue]:nil;if(!source||!metadata)return fail("The FidelityFX shader resources are missing");
  MTLCompileOptions*options=[MTLCompileOptions new];options.languageVersion=MTLLanguageVersion2_3;auto library=[device newLibraryWithSource:source options:options error:&issue];if(!library)return fail(issue.localizedDescription.UTF8String?:"Metal shader compilation failed");
  auto values=[MTLFunctionConstantValues new];const uint32_t alignment=[device minimumLinearTextureAlignmentForPixelFormat:MTLPixelFormatR32Uint];[values setConstantValue:&alignment type:MTLDataTypeUInt atIndex:65535];auto function=[library newFunctionWithName:metadata[@"entry"] constantValues:values error:&issue];if(!function)return fail(issue.localizedDescription.UTF8String?:"Metal shader specialization failed");
  auto value=std::make_unique<Pipeline>();value->state=[device newComputePipelineStateWithFunction:function error:&issue];if(!value->state)return fail(issue.localizedDescription.UTF8String?:"Metal pipeline creation failed");NSArray*threads=metadata[@"threads"];value->threads=MTLSizeMake([threads[0] unsignedIntegerValue],[threads[1] unsignedIntegerValue],[threads[2] unsignedIntegerValue]);if(value->threads.width*value->threads.height*value->threads.depth>value->state.maxTotalThreadsPerThreadgroup)return fail("The SDK thread group exceeds this device's capacity");
  output={};for(NSDictionary*entry in metadata[@"bindings"]){const std::string name=[entry[@"name"] UTF8String],kind=[entry[@"kind"] UTF8String];const unsigned slot=[entry[@"index"] unsignedIntValue];
   if(kind=="sampler")value->samplers.emplace_back(slot,name.find("Linear")!=std::string::npos||name.find("linear")!=std::string::npos);
   else if(kind=="texture"){const bool write=name.rfind("rw_",0)==0;auto&count=write?output.uavTextureCount:output.srvTextureCount;if(count>=(write?FFX_MAX_NUM_UAVS:FFX_MAX_NUM_SRVS))return fail("The SDK texture binding limit was exceeded");binding(write?output.uavTextureBindings[count++]:output.srvTextureBindings[count++],name,slot);}
   else if(name.size()>7&&name.compare(name.size()-7,7,"_atomic")==0)value->atomics.push_back({slot,0,name.substr(0,name.size()-7)});
   else if(name.rfind("rw_",0)==0){if(output.uavBufferCount>=FFX_MAX_NUM_UAVS)return fail("Too many SDK writable buffers");binding(output.uavBufferBindings[output.uavBufferCount++],name,slot);}
   else if(name.rfind("r_",0)==0){if(output.srvBufferCount>=FFX_MAX_NUM_SRVS)return fail("Too many SDK readable buffers");binding(output.srvBufferBindings[output.srvBufferCount++],name,slot);}
   else{if(output.constCount>=FFX_MAX_NUM_CONST_BUFFERS)return fail("Too many SDK constants");binding(output.constantBufferBindings[output.constCount++],name,slot);}
  }
  for(auto&atomic:value->atomics){bool found=false;const std::wstring name(atomic.name.begin(),atomic.name.end());for(unsigned n=0;n<output.uavTextureCount;++n)if(name==output.uavTextureBindings[n].name){atomic.resource=n;found=true;break;}if(!found)return fail("An SDK image-atomic binding is missing its texture");}
  output.pipeline=value.get();pipelines.push_back(std::move(value));return FFX_OK;
 }
 FfxErrorCode execute(FfxCommandList commandList){auto commands=(__bridge id<MTLCommandBuffer>)commandList;
  for(const auto&job:jobs){
   if(job.jobType==FFX_GPU_JOB_COMPUTE){const auto&j=job.computeJobDescriptor;const auto&p=*static_cast<Pipeline*>(j.pipeline.pipeline);auto encoder=[commands computeCommandEncoder];if(!encoder)return fail("A compute encoder could not be created");[encoder setComputePipelineState:p.state];
    for(unsigned i=0;i<j.pipeline.srvTextureCount;++i){auto r=resource(j.srvTextures[i].resource);if(!r||!r->texture){[encoder endEncoding];return fail("An SDK input texture is missing");}[encoder setTexture:r->texture atIndex:j.pipeline.srvTextureBindings[i].slotIndex];}
    for(unsigned i=0;i<j.pipeline.uavTextureCount;++i){auto r=resource(j.uavTextures[i].resource);const unsigned mip=j.uavTextures[i].mip;id<MTLTexture>target=nil;
     if(r&&r->texture){if(r->external){if(!mip)target=r->texture;}else if(mip<r->mips.size())target=r->mips[mip];else{
      // SPD exposes a fixed twelve-UAV interface. Its exact CPU mip count
      // proves the higher bindings unused for smaller images; Metal still
      // requires a valid texture at those inactive argument positions.
      unsigned active=0;for(unsigned cb=0;cb<j.pipeline.constCount;++cb)if(std::wcscmp(j.pipeline.constantBufferBindings[cb].name,L"cbInpaintingPyramid")==0&&j.cbs[cb].num32BitEntries>=4)active=j.cbs[cb].data[0];
      if(active&&active<=r->mips.size()&&mip>=active)target=r->mips.back();
     }}
     if(!target){[encoder endEncoding];return fail("An active SDK output texture mip is missing: index="+std::to_string(mip)+" levels="+std::to_string(r?r->mips.size():0));}[encoder setTexture:target atIndex:j.pipeline.uavTextureBindings[i].slotIndex];}
    for(unsigned i=0;i<j.pipeline.srvBufferCount;++i){auto r=resource(j.srvBuffers[i].resource);if(!r||!r->buffer){[encoder endEncoding];return fail("An SDK input buffer is missing");}[encoder setBuffer:r->buffer offset:j.srvBuffers[i].offset atIndex:j.pipeline.srvBufferBindings[i].slotIndex];}
    for(unsigned i=0;i<j.pipeline.uavBufferCount;++i){auto r=resource(j.uavBuffers[i].resource);if(!r||!r->buffer){[encoder endEncoding];return fail("An SDK output buffer is missing");}[encoder setBuffer:r->buffer offset:j.uavBuffers[i].offset atIndex:j.pipeline.uavBufferBindings[i].slotIndex];}
    for(const auto&atomic:p.atomics){auto r=resource(j.uavTextures[atomic.resource].resource);if(!r||!r->buffer){[encoder endEncoding];return fail("An SDK atomic backing buffer is missing");}[encoder setBuffer:r->buffer offset:0 atIndex:atomic.slot];}
    for(unsigned i=0;i<j.pipeline.constCount;++i)[encoder setBytes:j.cbs[i].data length:j.cbs[i].num32BitEntries*4 atIndex:j.pipeline.constantBufferBindings[i].slotIndex];for(const auto&sampler:p.samplers)[encoder setSamplerState:sampler.second?linear:point atIndex:sampler.first];
    if(j.cmdArgument.internalIndex){auto r=resource(j.cmdArgument);if(!r||!r->buffer){[encoder endEncoding];return fail("An SDK indirect dispatch buffer is missing");}[encoder dispatchThreadgroupsWithIndirectBuffer:r->buffer indirectBufferOffset:j.cmdArgumentOffset threadsPerThreadgroup:p.threads];}
    else [encoder dispatchThreadgroups:MTLSizeMake(j.dimensions[0],j.dimensions[1],j.dimensions[2]) threadsPerThreadgroup:p.threads];[encoder endEncoding];
   }else if(job.jobType==FFX_GPU_JOB_CLEAR_FLOAT){auto r=resource(job.clearJobDescriptor.target);if(!r)return fail("An SDK clear resource is missing");
    if(r->description.type==FFX_RESOURCE_TYPE_BUFFER){auto encoder=[commands computeCommandEncoder];[encoder setComputePipelineState:clearBuffer];[encoder setBuffer:r->buffer offset:0 atIndex:0];[encoder setBytes:job.clearJobDescriptor.color length:16 atIndex:1];const uint32_t count=(r->description.size+3)/4;[encoder setBytes:&count length:4 atIndex:2];[encoder dispatchThreads:MTLSizeMake(count,1,1) threadsPerThreadgroup:MTLSizeMake(64,1,1)];[encoder endEncoding];}
    else for(auto texture:r->mips){auto encoder=[commands computeCommandEncoder];const auto format=texture.pixelFormat;const bool sint=format==MTLPixelFormatRG16Sint;const bool uint=format==MTLPixelFormatR32Uint||format==MTLPixelFormatR16Uint||format==MTLPixelFormatRG16Uint||format==MTLPixelFormatR8Uint||format==MTLPixelFormatRG8Uint;[encoder setComputePipelineState:sint?clearSint:uint?clearUint:clearFloat];[encoder setTexture:texture atIndex:0];[encoder setBytes:job.clearJobDescriptor.color length:16 atIndex:0];[encoder dispatchThreads:MTLSizeMake(texture.width,texture.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];}
   }else if(job.jobType==FFX_GPU_JOB_COPY){const auto&j=job.copyJobDescriptor;auto src=resource(j.src),dst=resource(j.dst);if(!src||!dst)return fail("An SDK copy resource is missing");auto encoder=[commands blitCommandEncoder];if(src->texture&&dst->texture)[encoder copyFromTexture:src->texture toTexture:dst->texture];else if(src->buffer&&dst->buffer)[encoder copyFromBuffer:src->buffer sourceOffset:j.srcOffset toBuffer:dst->buffer destinationOffset:j.dstOffset size:j.size?j.size:std::min(src->buffer.length-j.srcOffset,dst->buffer.length-j.dstOffset)];else{[encoder endEncoding];return fail("An SDK copy has incompatible resource types");}[encoder endEncoding];
   }else if(job.jobType==FFX_GPU_JOB_BARRIER){/* Encoders end at every SDK job. Tracked Metal resources provide the declared device visibility between these ordered encoders. */}
   else if(job.jobType!=FFX_GPU_JOB_DISCARD)return fail("The SDK issued an unsupported GPU job");
  }
  jobs.clear();constantCursor=0;return FFX_OK;
 }
public:
 id<MTLDevice>device;std::string directory,error;bool memoryBusy=false;FfxInterface api{};
 Backend(const RSGenerationOptions&options):host(options),device((__bridge id<MTLDevice>)options.device),directory(options.shaderDirectory?:""){
  MTLSamplerDescriptor*sampler=[MTLSamplerDescriptor new];sampler.sAddressMode=sampler.tAddressMode=sampler.rAddressMode=MTLSamplerAddressModeClampToEdge;sampler.minFilter=sampler.magFilter=MTLSamplerMinMagFilterNearest;point=[device newSamplerStateWithDescriptor:sampler];sampler.minFilter=sampler.magFilter=MTLSamplerMinMagFilterLinear;linear=[device newSamplerStateWithDescriptor:sampler];
  NSString*source=@"#include <metal_stdlib>\nusing namespace metal;kernel void cf(texture2d<float,access::write>t[[texture(0)]],constant float4&v[[buffer(0)]],uint2 p[[thread_position_in_grid]]){if(all(p<uint2(t.get_width(),t.get_height())))t.write(v,p);}kernel void cu(texture2d<uint,access::write>t[[texture(0)]],constant float4&v[[buffer(0)]],uint2 p[[thread_position_in_grid]]){if(all(p<uint2(t.get_width(),t.get_height())))t.write(as_type<uint4>(v),p);}kernel void ci(texture2d<int,access::write>t[[texture(0)]],constant float4&v[[buffer(0)]],uint2 p[[thread_position_in_grid]]){if(all(p<uint2(t.get_width(),t.get_height())))t.write(as_type<int4>(v),p);}kernel void cb(device uint*t[[buffer(0)]],constant float4&v[[buffer(1)]],constant uint&n[[buffer(2)]],uint p[[thread_position_in_grid]]){if(p<n)t[p]=as_type<uint>(v.x);}";NSError*issue=nil;auto library=[device newLibraryWithSource:source options:nil error:&issue];if(!library)throw std::runtime_error(issue.localizedDescription.UTF8String?:"The SDK clear shaders could not compile");clearFloat=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"cf"] error:&issue];clearUint=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"cu"] error:&issue];clearSint=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"ci"] error:&issue];clearBuffer=[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"cb"] error:&issue];if(!clearFloat||!clearUint||!clearSint||!clearBuffer)throw std::runtime_error("The SDK clear pipelines could not initialize");
  resources.reserve(128);jobs.reserve(64);pipelines.reserve(24);api.device=options.device;api.scratchBuffer=this;api.scratchBufferSize=sizeof(*this);
  api.fpGetSDKVersion=[](FfxInterface*)->FfxVersionNumber{return FFX_SDK_MAKE_VERSION(1,1,4);};api.fpCreateBackendContext=[](FfxInterface*,FfxEffect,FfxEffectBindlessConfig*,FfxUInt32*id)->FfxErrorCode{*id=0;return FFX_OK;};api.fpDestroyBackendContext=[](FfxInterface*,FfxUInt32)->FfxErrorCode{return FFX_OK;};
  api.fpGetDeviceCapabilities=[](FfxInterface*,FfxDeviceCapabilities*c)->FfxErrorCode{*c={};c->maximumSupportedShaderModel=FFX_SHADER_MODEL_6_0;c->waveLaneCountMin=c->waveLaneCountMax=32;return FFX_OK;};
  api.fpCreateResource=[](FfxInterface*a,const FfxCreateResourceDescription*d,FfxUInt32,FfxResourceInternal*r){return get(a).create(*d,*r);};
  api.fpRegisterResource=[](FfxInterface*a,const FfxResource*r,FfxUInt32,FfxResourceInternal*out)->FfxErrorCode{auto&b=get(a);if(!r->resource){out->internalIndex=0;return FFX_OK;}for(size_t n=1;n<b.resources.size();++n)if((__bridge void*)b.resources[n].texture==r->resource||(__bridge void*)b.resources[n].buffer==r->resource){out->internalIndex=int(n);return FFX_OK;}Resource value;value.external=true;value.description=r->description;if(r->description.type==FFX_RESOURCE_TYPE_BUFFER)value.buffer=(__bridge id<MTLBuffer>)r->resource;else value.texture=(__bridge id<MTLTexture>)r->resource;out->internalIndex=int(b.resources.size());b.resources.push_back(std::move(value));return FFX_OK;};
  api.fpUnregisterResources=[](FfxInterface*a,FfxCommandList,FfxUInt32)->FfxErrorCode{auto&resources=get(a).resources;while(resources.size()>1&&resources.back().external)resources.pop_back();return FFX_OK;};
  api.fpGetResourceDescription=[](FfxInterface*a,FfxResourceInternal r){auto value=get(a).resource(r);return value?value->description:FfxResourceDescription{};};api.fpDestroyResource=[](FfxInterface*a,FfxResourceInternal r,FfxUInt32)->FfxErrorCode{if(auto value=get(a).resource(r))*value={};return FFX_OK;};
  api.fpCreatePipeline=[](FfxInterface*a,FfxEffect e,FfxPass p,uint32_t permutation,const FfxPipelineDescription*,FfxUInt32,FfxPipelineState*out){return get(a).pipeline(e,p,permutation,*out);};api.fpDestroyPipeline=[](FfxInterface*,FfxPipelineState*,FfxUInt32)->FfxErrorCode{return FFX_OK;};api.fpScheduleGpuJob=[](FfxInterface*a,const FfxGpuJobDescription*j)->FfxErrorCode{get(a).jobs.push_back(*j);return FFX_OK;};api.fpExecuteGpuJobs=[](FfxInterface*a,FfxCommandList list,FfxUInt32){return get(a).execute(list);};
  api.fpStageConstantBufferDataFunc=[](FfxInterface*a,void*data,FfxUInt32 size,FfxConstantBuffer*out)->FfxErrorCode{auto&b=get(a);if(b.constantCursor==b.constants.size())b.constants.emplace_back();auto&value=b.constants[b.constantCursor++];value.resize((size+3)/4);std::memcpy(value.data(),data,size);out->data=value.data();out->num32BitEntries=(size+3)/4;return FFX_OK;};
 }
 FfxResource createShared(const FfxCreateResourceDescription&description){FfxResourceInternal index{};if(create(description,index)!=FFX_OK){if(memoryBusy)throw MemoryBusy();throw std::runtime_error(error);}const auto r=resource(index);FfxResource result{};result.resource=r->texture?(__bridge void*)r->texture:(__bridge void*)r->buffer;result.description=r->description;result.state=FFX_RESOURCE_STATE_COMPUTE_READ;return result;}
};
}
