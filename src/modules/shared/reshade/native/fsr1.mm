// SPDX-License-Identifier: BSD-3-Clause
#include "fsr1.hpp"
#include "metal-vk.hpp"
#include "fsr1-budget.hpp"
#include "fsr1-shaders.hpp"
#import <IOSurface/IOSurface.h>
#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#define A_CPU 1
#include "ffx_a.h"
#include "ffx_fsr1.h"
namespace {
template<typename T>std::vector<uint8_t> bytes(const T&words){const auto*begin=reinterpret_cast<const uint8_t*>(words.data());return {begin,begin+sizeof(uint32_t)*words.size()};}
bool supported(MTLPixelFormat f){return f==MTLPixelFormatRGBA8Unorm||f==MTLPixelFormatBGRA8Unorm||f==MTLPixelFormatRGBA16Float;}
id<MTLTexture>rootTexture(id<MTLTexture>texture){for(unsigned i=0;texture.parentTexture;++i){if(i==31)throw std::invalid_argument("Unsupported texture view nesting");texture=texture.parentTexture;}return texture;}
bool aliases(id<MTLTexture>a,id<MTLTexture>b){
 a=rootTexture(a);b=rootTexture(b);
 return a==b||(a.buffer&&a.buffer==b.buffer)||(a.iosurface&&b.iosurface&&IOSurfaceGetID(a.iosurface)==IOSurfaceGetID(b.iosurface));
}
struct Parameters {uint32_t c[4][4]{};};
void validate(id<MTLDevice>device,id<MTLCommandBuffer>commands,const macfx::SpatialFrame&frame,float sharpness){
 auto reject=[](const char*why){throw std::invalid_argument(why);};
 if(!commands||!frame.source||!frame.output)reject("Missing FSR command buffer or images");
 if(commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences)reject("FSR requires an unsubmitted retaining command buffer");
 if(aliases(frame.source,frame.output))reject("FSR images must use distinct storage");
 if(frame.color!=macfx::SpatialColor::Perceptual)reject("FSR1 currently requires perceptual SDR images");
 if(!std::isfinite(sharpness)||sharpness<0||sharpness>1)reject("FSR sharpening must be between zero and one");
 for(id<MTLTexture> t:{frame.source,frame.output})if(t.device!=device||commands.device!=device||t.textureType!=MTLTextureType2D||t.sampleCount!=1||!supported(t.pixelFormat)||t.framebufferOnly||t.hazardTrackingMode==MTLHazardTrackingModeUntracked)reject("FSR images require compatible tracked resolved 2D textures");
 if(frame.output.width<frame.source.width||frame.output.height<frame.source.height||frame.output.width>2*frame.source.width||frame.output.height>2*frame.source.height)reject("FSR reconstruction requires an upscale of at most two times");
 if(frame.output.width>16384||frame.output.height>16384)reject("FSR image dimensions exceed the supported limit");
 if(!(frame.source.usage&MTLTextureUsageShaderRead)||!(frame.output.usage&MTLTextureUsageShaderWrite))reject("FSR images require shader access");
}
struct Batch {
 macfx::fsr1::ScratchBudget budget;
 id<MTLTexture>texture;
 Batch(id<MTLDevice>device,MTLTextureDescriptor*descriptor,size_t bytes):budget(bytes){
  texture=[device newTextureWithDescriptor:descriptor];
  if(!texture)throw std::runtime_error("Cannot allocate FSR scratch image");
  if(texture.allocatedSize>bytes)throw std::runtime_error("FSR scratch allocation exceeded its reserved memory");
 }
};
// Scratch images are shared by every encoder on a device and keyed by size and
// format. A replacement chain with the same output reuses the idle images of
// the chain it replaces, rather than charging the process budget a second time
// during the change. An idle image is released once no live encoder's latest
// output uses its size and format, so a resize, a drawable change or a retired
// chain leaves no stale image charged; in-flight images end with their command
// buffers.
class ScratchPool {
 static constexpr size_t maximumInFlight=6;
 struct Extent {
  NSUInteger width=0,height=0;MTLPixelFormat format=MTLPixelFormatInvalid;
  bool operator==(const Extent&other)const{return width==other.width&&height==other.height&&format==other.format;}
 };
 std::mutex mutex;std::vector<std::shared_ptr<Batch>>batches;std::map<const void*,Extent>demand;
 static Extent extent(const Batch&batch){return {batch.texture.width,batch.texture.height,batch.texture.pixelFormat};}
 void trimLocked(){
  batches.erase(std::remove_if(batches.begin(),batches.end(),[&](const auto&batch){
   if(batch.use_count()!=1)return false;const auto value=extent(*batch);
   return std::none_of(demand.begin(),demand.end(),[&](const auto&entry){return entry.second==value;});
  }),batches.end());
 }
public:
 static ScratchPool&forDevice(id<MTLDevice>device){
  static auto*const lock=new std::mutex;static auto*const pools=new std::map<uint64_t,std::unique_ptr<ScratchPool>>;
  std::lock_guard guard(*lock);auto&pool=(*pools)[device.registryID];if(!pool)pool=std::make_unique<ScratchPool>();return *pool;
 }
 void detach(const void*owner){std::lock_guard guard(mutex);demand.erase(owner);trimLocked();}
 void trim(){std::lock_guard guard(mutex);trimLocked();}
 std::shared_ptr<Batch>acquire(const void*owner,id<MTLDevice>device,NSUInteger width,NSUInteger height,MTLPixelFormat format){
  std::lock_guard guard(mutex);const Extent wanted{width,height,format};demand[owner]=wanted;trimLocked();
  for(auto&batch:batches)if(batch.use_count()==1&&extent(*batch)==wanted)return batch;
  // Any idle image left has another live encoder's extent. Under pressure it
  // gives way; that encoder allocates again when it next needs one.
  const auto evictIdle=[&]{const auto count=batches.size();batches.erase(std::remove_if(batches.begin(),batches.end(),[](const auto&batch){return batch.use_count()==1;}),batches.end());return batches.size()!=count;};
  if(batches.size()>=maximumInFlight&&!evictIdle())return {};
  auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];
  descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;descriptor.hazardTrackingMode=MTLHazardTrackingModeTracked;
  const auto required=[device heapTextureSizeAndAlignWithDescriptor:descriptor];
  std::shared_ptr<Batch>batch;
  try{batch=std::make_shared<Batch>(device,descriptor,required.size);}
  catch(const macfx::fsr1::ScratchBudgetBusy&){if(!evictIdle())throw;batch=std::make_shared<Batch>(device,descriptor,required.size);}
  batches.push_back(batch);return batch;
 }
};
}
struct macfx::Fsr1Encoder::Impl {
 id<MTLDevice> device;std::unique_ptr<vk::Shader> easu,rcas8,rcas16;vk::Sampler sampler;std::mutex mutex;
 Impl(id<MTLDevice>d):device(d){
  if(!device)throw std::invalid_argument("FSR requires a Metal device");
  vk::Vulkan host(device);sampler=vk::Sampler(host,2);
  easu=std::make_unique<vk::Shader>(host,bytes(macfx::fsr1::embedded::easu),0,1,1,1,1);
  rcas8=std::make_unique<vk::Shader>(host,bytes(macfx::fsr1::embedded::rcas8),1,1,1,1,1);
  rcas16=std::make_unique<vk::Shader>(host,bytes(macfx::fsr1::embedded::rcas16),2,1,1,1,1);
 }
 ~Impl(){ScratchPool::forDevice(device).detach(this);}
};
macfx::Fsr1Encoder::Fsr1Encoder(id<MTLDevice>d):impl(std::make_unique<Impl>(d)){}
macfx::Fsr1Encoder::~Fsr1Encoder()=default;
void macfx::Fsr1Encoder::encode(id<MTLCommandBuffer>commands,const SpatialFrame&frame,id<MTLTexture>scratch,float sharpness){
 validate(impl->device,commands,frame,sharpness);
 auto reject=[](const char*why){throw std::invalid_argument(why);};
 if(!scratch)reject("Missing FSR scratch image");
 if(aliases(frame.source,scratch)||aliases(frame.output,scratch))reject("FSR images must use distinct storage");
 if(scratch.device!=impl->device||scratch.textureType!=MTLTextureType2D||scratch.sampleCount!=1)reject("FSR scratch requires a compatible resolved 2D texture");
 if(scratch.width!=frame.output.width||scratch.height!=frame.output.height||scratch.pixelFormat!=MTLPixelFormatRGBA16Float)reject("FSR scratch requires output dimensions and RGBA16Float");
 if(scratch.framebufferOnly||scratch.hazardTrackingMode==MTLHazardTrackingModeUntracked)reject("FSR scratch requires tracked shader access");
 if(!(frame.source.usage&MTLTextureUsageShaderRead)||!(frame.output.usage&MTLTextureUsageShaderWrite)||(scratch.usage&(MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite))!=(MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite))reject("FSR images require shader access");
 Parameters easu{},rcas{};FsrEasuCon(easu.c[0],easu.c[1],easu.c[2],easu.c[3],frame.source.width,frame.source.height,frame.source.width,frame.source.height,frame.output.width,frame.output.height);FsrRcasCon(rcas.c[0],sharpness>0?-std::log2(sharpness):0);if(sharpness==0)rcas.c[0][0]=rcas.c[0][1]=0;
 std::lock_guard lock(impl->mutex);
 auto encoder=[commands computeCommandEncoder];if(!encoder)throw std::runtime_error("Cannot create FSR compute encoder");
 encoder.label=@"FSR1 EASU and RCAS";
 [encoder setSamplerState:impl->sampler.object atIndex:0];
 auto dispatch=[&](vk::Shader&shader,id<MTLTexture>source,id<MTLTexture>output,const Parameters&constants){
  [encoder setComputePipelineState:shader.pipeline];[encoder setTexture:source atIndex:0];[encoder setTexture:output atIndex:1];[encoder setBytes:&constants length:sizeof(constants) atIndex:0];
  [encoder dispatchThreads:MTLSizeMake(output.width,output.height,1) threadsPerThreadgroup:shader.group];
 };
 dispatch(*impl->easu,frame.source,scratch,easu);
 // Tracked texture dependencies order the reconstruction before sharpening.
 [encoder memoryBarrierWithScope:MTLBarrierScopeTextures];
 dispatch(*(frame.output.pixelFormat==MTLPixelFormatRGBA16Float?impl->rcas16:impl->rcas8),scratch,frame.output,rcas);
 [encoder endEncoding];
}
bool macfx::Fsr1Encoder::encode(id<MTLCommandBuffer>commands,const SpatialFrame&frame,float sharpness,std::string&reason,bool*busy){
 if(busy)*busy=false;
 try {
  validate(impl->device,commands,frame,sharpness);
  auto&pool=ScratchPool::forDevice(impl->device);
  const auto batch=pool.acquire(impl.get(),impl->device,frame.output.width,frame.output.height,MTLPixelFormatRGBA16Float);
  if(!batch){if(busy)*busy=true;reason="FSR scratch image queue is full";return false;}
  // The block releases this exact batch on completion, or when an unsubmitted
  // command buffer discards its handlers, and then drops it from the pool if
  // no encoder still uses its extent. It never retains the encoder owner.
  auto lease=std::make_shared<std::shared_ptr<Batch>>(batch);ScratchPool*const owner=&pool;
  [commands addCompletedHandler:^(id<MTLCommandBuffer>){lease->reset();owner->trim();}];
  encode(commands,frame,batch->texture,sharpness);reason.clear();return true;
 }catch(const fsr1::ScratchBudgetBusy&error){if(busy)*busy=true;reason=error.what();return false;}
 catch(const std::exception&error){reason=error.what();return false;}
}
