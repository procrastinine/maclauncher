// SPDX-License-Identifier: GPL-3.0-or-later
// Owned Metal host for the pinned, unchanged MAKO temporal shader graph.
#include "lsfg.hpp"
#include "completion.hpp"
#include "generation-budget.hpp"
#include "image-admission.hpp"
#include "metal-vk.hpp"
#include "extraction/dll_reader.hpp"
#include "extraction/model_resources.hpp"
#include "extraction/model_resource_validation.hpp"
#include "extraction/spirv_image_format.hpp"
#include "helpers/utils.hpp"
#include "helpers/temporal_phases.hpp"
#include "helpers/timestamp_upload_cache.hpp"
#include "shaderchains/mipmaps.hpp"
#include "shaderchains/alpha0.hpp"
#include "shaderchains/alpha1.hpp"
#include "shaderchains/beta0.hpp"
#include "shaderchains/beta1.hpp"
#include "shaderchains/gamma0.hpp"
#include "shaderchains/gamma1.hpp"
#include "shaderchains/delta0.hpp"
#include "shaderchains/delta1.hpp"
#include "shaderchains/generate.hpp"
#include <atomic>
#include <cmath>
#include <map>
#include <mutex>
#include <tuple>
using namespace mako::backend;
namespace {
struct Model {
 vk::Vulkan vk;ShaderRegistry shaders;std::string hash;id<MTLComputePipelineState> copy,resolve,clear;
 Model(id<MTLDevice> device,const macfx::LsfgConfig&config,const std::shared_ptr<const DllResourceArchive>&archive):vk(device){
  hash=archive->fileSha256;
  const auto selection=resolveLsfgModelResources(*archive,config.fp16,config.performance);
  std::map<uint32_t,vk::Shader> cache;
  auto shader=[&](unsigned logical,bool performance=false){const auto canonical=detail::lsfgResourceId(logical,config.fp16,performance);auto found=cache.find(canonical);if(found!=cache.end())return found->second;const auto specs=detail::lsfgShaderSpecs(performance);const auto spec=std::find_if(specs.begin(),specs.end(),[&](const auto&item){return item.logicalId==logical;});if(spec==specs.end())throw std::runtime_error("Unknown model stage");const auto&contract=spec->contract;auto value=vk::Shader(vk,selection.resource(*archive,canonical),selection.resourceId(canonical),contract.sampledImages,contract.storageImages,contract.uniformBuffers,contract.samplers);cache.emplace(canonical,value);return value;};
  shaders.mipmaps=shader(255);shaders.is_fp16=config.fp16;
  const auto generateSpec=detail::lsfgShaderSpecs(false);const auto generateContract=std::find_if(generateSpec.begin(),generateSpec.end(),[](const auto&item){return item.logicalId==256;});
  if(generateContract==generateSpec.end())throw std::runtime_error("The model generation contract is unavailable");
  auto generateData=selection.resource(*archive,detail::lsfgResourceId(256,config.fp16,false));
  detail::patchStorageImageFormat(generateData,config.hdr?2:4);
  auto generation=vk::Shader(vk,generateData,selection.resourceId(detail::lsfgResourceId(256,config.fp16,false)),generateContract->contract.sampledImages,generateContract->contract.storageImages,generateContract->contract.uniformBuffers,generateContract->contract.samplers);
  if(config.hdr)shaders.generate_hdr=std::move(generation);else shaders.generate=std::move(generation);
  auto&s=config.performance?shaders.performance:shaders.quality;
  const unsigned alpha[]={267,268,269,270},beta[]={275,276,277,278,279},gamma[]={257,259,260,261,262},delta[]={257,263,264,265,266,258,271,272,273,274};
  for(unsigned i=0;i<4;++i)s.alpha[i]=shader(alpha[i],config.performance);for(unsigned i=0;i<5;++i){s.beta[i]=shader(beta[i],config.performance);s.gamma[i]=shader(gamma[i],config.performance);}for(unsigned i=0;i<10;++i)s.delta[i]=shader(delta[i],config.performance);
  const char*source=R"METAL(
   #include <metal_stdlib>
   using namespace metal;
   kernel void zero_image(texture2d<float,access::write> target[[texture(0)]],uint2 p[[thread_position_in_grid]]){
    if(p.x<target.get_width()&&p.y<target.get_height())target.write(float4(0),p);
   }
   kernel void source_copy(texture2d<float,access::read> source[[texture(0)]],texture2d<float,access::write> target[[texture(1)]],uint2 p[[thread_position_in_grid]]){
    if(p.x<target.get_width()&&p.y<target.get_height())target.write(float4(source.read(p).rgb,1.0f),p);
   }
   kernel void opaque_resolve(texture2d<float,access::read> generated[[texture(0)]],texture2d<float,access::read> previous[[texture(1)]],texture2d<float,access::read> current[[texture(2)]],texture2d<float,access::write> output[[texture(3)]],constant float& timestamp[[buffer(0)]],constant uint& hdr[[buffer(1)]],uint2 p[[thread_position_in_grid]]){
    if(p.x>=output.get_width()||p.y>=output.get_height())return;
    float4 value=generated.read(p);float3 colour=value.a>0.00001f?value.rgb/value.a:mix(previous.read(p).rgb,current.read(p).rgb,timestamp);
    output.write(float4(hdr?colour:clamp(colour,0.0f,1.0f),1.0f),p);
   })METAL";
  NSError*error=nil;auto library=[device newLibraryWithSource:@(source) options:nil error:&error];
  copy=library?[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"source_copy"] error:&error]:nil;
  resolve=library?[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"opaque_resolve"] error:&error]:nil;
  clear=library?[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"zero_image"] error:&error]:nil;
  if(!copy||!resolve||!clear)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot create frame-generation image conversion");
 }
};
std::shared_ptr<Model>sharedModel(id<MTLDevice>device,const macfx::LsfgConfig&config){
 // Archive selection rechecks file identity. Only immutable shader pipelines
 // and model resources are shared; every encoder retains separate history.
 const auto archive=loadDllResourceArchive(config.modelPath);
 using Key=std::tuple<uint64_t,std::string,bool,bool,bool>;
 static std::mutex mutex;static std::map<Key,std::weak_ptr<Model>>cache;
 const Key key{reinterpret_cast<uintptr_t>((__bridge void*)device),archive->fileSha256,config.fp16,config.performance,config.hdr};
 std::lock_guard guard(mutex);for(auto it=cache.begin();it!=cache.end();)if(it->second.expired())it=cache.erase(it);else ++it;auto&entry=cache[key];if(auto selected=entry.lock())return selected;
 auto selected=std::make_shared<Model>(device,config,archive);entry=selected;return selected;
}
struct Branch {std::vector<Gamma0>g0;std::vector<Gamma1>g1;std::vector<Delta0>d0;std::vector<Delta1>d1;std::optional<Generate>generate;vk::Image generated;
 Branch(const Ctx&ctx,unsigned index,const std::pair<vk::Image,vk::Image>&source,const std::vector<Alpha0>&a0,const std::vector<Alpha1>&a1,const Beta1&b1,const vk::Image&black,const Branch*sharedScratch):generated(ctx.vk,ctx.sourceExtent,ctx.imageMemoryPool,VK_FORMAT_R16G16B16A16_SFLOAT){
  g0.reserve(7);g1.reserve(7);d0.reserve(3);d1.reserve(3);
  for(unsigned j=0;j<7;++j){g0.emplace_back(ctx,index,a1[6-j].getImages(),j?g1[j-1].getImage():black,sharedScratch?&sharedScratch->g0[j]:nullptr);g1.emplace_back(ctx,index,g0[j].getImages(),a0[6-j].getImages(),j?g1[j-1].getImage():black,b1.getImages()[j?6-j:5],sharedScratch?&sharedScratch->g1[j]:nullptr);
   if(j>=4){d0.emplace_back(ctx,index,a1[6-j].getImages(),g0[j].getImages(),g1[j].getTempImages0(),j==4?black:d1[j-5].getImage0(),g1[j-1].getImage());d1.emplace_back(ctx,index,g0[j].getImages(),g1[j].getTempImages0(),g1[j].getTempImages1(),j==4?black:d1[j-5].getImage0(),b1.getImages()[6-j],j==4?black:d1[j-5].getImage1(),sharedScratch?&sharedScratch->d1[j-4]:nullptr);}}
  generate.emplace(ctx,index,source,g1[6].getImage(),d1[2].getImage0(),d1[2].getImage1(),generated);
 }
 void encode(const vk::Vulkan&vk,const vk::CommandBuffer&cmd,unsigned frame){for(unsigned j=0;j<7;++j){g0[j].render(vk,cmd,frame);g1[j].render(vk,cmd);if(j>=4){d0[j-4].render(vk,cmd,frame);d1[j-4].render(vk,cmd);}}generate->render(vk,cmd,frame);}
};
struct Graph {
 std::shared_ptr<macfx::ImageReservation>admission;std::shared_ptr<Model>model;std::shared_ptr<vk::ImageMemoryPool>pool=std::make_shared<vk::ImageMemoryPool>();Ctx ctx;
 std::pair<vk::Image,vk::Image>source;vk::Image black;Mipmaps mipmaps;std::vector<Alpha0>a0;std::vector<Alpha1>a1;std::optional<Beta0>b0;std::optional<Beta1>b1;std::vector<std::unique_ptr<Branch>>branches;std::vector<float>timestamps;
 std::atomic<bool>busy{false},failed{false};unsigned frames=0;uint64_t lastFrame=0;__weak id<MTLCommandBuffer>activeCommands=nil;
 static std::vector<vk::Buffer> constants(const vk::Vulkan&vk,const macfx::LsfgConfig&config){std::vector<vk::Buffer>result;for(unsigned i=0;i<config.multiplier-1;++i)result.emplace_back(vk,getDefaultConstantBuffer(i,config.multiplier-1,config.hdr,1/config.flowScale));return result;}
 static std::shared_ptr<macfx::ImageReservation>reserve(const std::shared_ptr<Model>&model,const macfx::LsfgConfig&config,unsigned width,unsigned height){
  const auto bytes=macfx::generationImageBytes(width,height,config.multiplier,config.flowScale,config.performance,[&](unsigned w,unsigned h,unsigned pixel){auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:pixel==1?MTLPixelFormatR8Unorm:pixel==8?MTLPixelFormatRGBA16Float:MTLPixelFormatRGBA8Unorm width:w height:h mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;return uint64_t([model->vk.device heapTextureSizeAndAlignWithDescriptor:descriptor].size);},config.hdr);
  return macfx::reserveImageBytes(model->vk.device,bytes,0,"lsfg-generation-memory");
 }
 Graph(std::shared_ptr<Model>value,const macfx::LsfgConfig&config,unsigned width,unsigned height):admission(reserve(value,config,width,height)),model(value),ctx{.vk=std::cref(model->vk),.shaders=std::cref(model->shaders),.imageMemoryPool=pool,.pool={},
  .constantBuffer=vk::Buffer(model->vk,getDefaultConstantBuffer(0,1,config.hdr,1/config.flowScale)),.constantBuffers=constants(model->vk,config),
  .bnbSampler=vk::Sampler(model->vk,0),.bnwSampler=vk::Sampler(model->vk,1),.eabSampler=vk::Sampler(model->vk,2),
  .sourceExtent={width,height},.flowExtent={std::max(1u,unsigned(width*config.flowScale)),std::max(1u,unsigned(height*config.flowScale))},
  .packedPqOutputShader=std::nullopt,.highPrecision=config.hdr,.hdr=config.hdr,.flow=1/config.flowScale,.perf=config.performance,.count=config.multiplier-1},source(vk::Image(model->vk,{width,height},pool,config.hdr?VK_FORMAT_R16G16B16A16_SFLOAT:VK_FORMAT_R8G8B8A8_UNORM),vk::Image(model->vk,{width,height},pool,config.hdr?VK_FORMAT_R16G16B16A16_SFLOAT:VK_FORMAT_R8G8B8A8_UNORM)),black(model->vk,{1,1},pool),mipmaps(ctx,source){
  a0.reserve(7);a1.reserve(7);for(unsigned i=0;i<7;++i){a0.emplace_back(ctx,mipmaps.getImages()[i]);a1.emplace_back(ctx,alphaHistoryCounts[i],a0[i].getImages());}
  b0.emplace(ctx,a1[0].getImages());b1.emplace(ctx,b0->getImages(),a0[0].getImages());
  // Branches execute serially in one command buffer. Their scratch is dead
  // after Generate; only generated images and per-phase constants survive.
  // Share within this graph, never across encoders or temporal histories.
  for(unsigned i=0;i<config.multiplier-1;++i){branches.emplace_back(std::make_unique<Branch>(ctx,i,source,a0,a1,*b1,black,branches.empty()?nullptr:branches.front().get()));timestamps.push_back(getDefaultConstantBuffer(i,config.multiplier-1,config.hdr,ctx.flow).timestamp);}
  admission->commit(pool->allocatedBytes());pool->initialize(model->vk,model->clear,admission);
 }
 unsigned encode(id<MTLCommandBuffer>cb,id<MTLTexture>input,const std::vector<id<MTLTexture>>&outputs,const macfx::InterpolationPlan&plan){
  const unsigned frame=frames;auto current=frame%2?source.second.texture:source.first.texture;auto previous=frame%2?source.first.texture:source.second.texture;
  auto copy=[cb computeCommandEncoder];[copy setComputePipelineState:model->copy];[copy setTexture:input atIndex:0];[copy setTexture:current atIndex:1];[copy dispatchThreads:MTLSizeMake(input.width,input.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[copy endEncoding];
  vk::CommandBuffer cmd(cb);mipmaps.render(model->vk,cmd,frame);
  std::vector<ManagedDispatch> batch;batch.reserve(7);
  for(unsigned stage=0;stage<3;++stage){batch.clear();for(unsigned i=0;i<7;++i)batch.push_back(a0[6-i].getDispatch(stage));ManagedShader::dispatchIndependent(model->vk,cmd,batch);}
  batch.clear();for(unsigned i=0;i<7;++i)batch.push_back(a1[6-i].getDispatch(frame));ManagedShader::dispatchIndependent(model->vk,cmd,batch);
  b0->render(model->vk,cmd,frame);b1->render(model->vk,cmd);
  for(unsigned i=0;i<plan.count;++i){uploadChangedTimestamp(timestamps,i,plan.timestamps[i],[&](float phase){auto constants=getDefaultConstantBuffer(i,branches.size(),ctx.hdr,ctx.flow);constants.timestamp=phase;ctx.constantBuffers[i].write(model->vk,constants);});auto&branch=*branches[i];branch.encode(model->vk,cmd,frame);auto resolve=[cb computeCommandEncoder];[resolve setComputePipelineState:model->resolve];[resolve setTexture:branch.generated.texture atIndex:0];[resolve setTexture:previous atIndex:1];[resolve setTexture:current atIndex:2];[resolve setTexture:outputs[i] atIndex:3];const float timestamp=plan.timestamps[i];const uint32_t hdr=ctx.hdr;[resolve setBytes:&timestamp length:sizeof(timestamp) atIndex:0];[resolve setBytes:&hdr length:sizeof(hdr) atIndex:1];[resolve dispatchThreads:MTLSizeMake(input.width,input.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[resolve endEncoding];}
  return cmd.dispatchCount+1+plan.count;
 }
};
bool supported(id<MTLTexture>t,bool hdr){return hdr?t.pixelFormat==MTLPixelFormatRGBA16Float:t.pixelFormat==MTLPixelFormatRGBA8Unorm||t.pixelFormat==MTLPixelFormatBGRA8Unorm;}
}
struct macfx::LsfgEncoder::Impl {LsfgConfig config;std::shared_ptr<Model>model;std::shared_ptr<Graph>graph;unsigned graphBuilds=0;bool preparedResources=false;mutable std::mutex mutex;Impl(id<MTLDevice>device,const LsfgConfig&value):config(value){if(!device||config.modelPath.empty()||config.multiplier<2||config.multiplier>5||!std::isfinite(config.flowScale)||config.flowScale<.25f||config.flowScale>1)throw std::runtime_error("Invalid frame-generation model, multiplier or flow scale");model=sharedModel(device,config);}};
uint32_t macfx::lsfgHDRAPI()noexcept{return 1;}
macfx::LsfgEncoder::LsfgEncoder(id<MTLDevice>device,const LsfgConfig&config):impl(std::make_unique<Impl>(device,config)){}
macfx::LsfgEncoder::~LsfgEncoder()=default;
macfx::LsfgResult macfx::LsfgEncoder::preparationStatus(unsigned width,unsigned height)const{
 LsfgResult result;std::unique_lock guard(impl->mutex,std::try_to_lock);if(!guard.owns_lock()){result.busy=true;result.reason="Preparing LSFG resources";return result;}
 const auto graph=impl->graph;if(!graph||graph->ctx.sourceExtent.width!=width||graph->ctx.sourceExtent.height!=height){result.busy=true;result.reason="LSFG image geometry requires preparation";return result;}
 if(graph->failed.load()||graph->pool->failed()){result.reason=graph->pool->failed()?graph->pool->failure():"LSFG GPU work failed";return result;}
 result.encoded=graph->pool->ready();result.busy=!result.encoded;if(result.busy)result.reason="Initializing LSFG image storage";return result;
}
bool macfx::LsfgEncoder::prepared(unsigned width,unsigned height)const{return preparationStatus(width,height).encoded;}
bool macfx::LsfgEncoder::canEncode(id<MTLCommandBuffer>commands)const{
 std::unique_lock guard(impl->mutex,std::try_to_lock);if(!guard)return false;const auto graph=impl->graph;if(!graph||graph->failed.load()||!graph->pool->ready())return false;
 return !graph->busy.load()||graph->activeCommands==commands;
}
macfx::LsfgResult macfx::LsfgEncoder::prepare(unsigned width,unsigned height){@autoreleasepool{
 LsfgResult result;result.modelHash=impl->model->hash;
 if(!width||!height||width>16384||height>16384){result.reason="Invalid frame-generation image extent";return result;}
 std::lock_guard guard(impl->mutex);auto graph=impl->graph;
 if(!graph||graph->failed.load()||graph->ctx.sourceExtent.width!=width||graph->ctx.sourceExtent.height!=height){impl->graph=std::make_shared<Graph>(impl->model,impl->config,width,height);++impl->graphBuilds;}
 impl->preparedResources=true;graph=impl->graph;result.graphBuilds=impl->graphBuilds;
 if(graph->pool->failed()){result.reason=graph->pool->failure();return result;}
 result.encoded=graph->pool->ready();result.busy=!result.encoded;if(result.busy)result.reason="Initializing LSFG image storage";return result;
}}
macfx::LsfgResult macfx::LsfgEncoder::encode(id<MTLCommandBuffer>cb,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t frameId){InterpolationPlan plan;plan.count=impl->config.multiplier-1;for(unsigned i=0;i<plan.count;++i)plan.timestamps[i]=float(i+1)/impl->config.multiplier;return encode(cb,source,outputs,frameId,plan);}
macfx::LsfgResult macfx::LsfgEncoder::encode(id<MTLCommandBuffer>cb,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t frameId,const InterpolationPlan&plan){@autoreleasepool{
 LsfgResult result;result.frameId=frameId;result.modelHash=impl->model->hash;
 if(!cb||!source||!cb.retainedReferences||cb.status>=MTLCommandBufferStatusCommitted){result.reason="Frame generation requires an unsubmitted retained command buffer and source";return result;}
 if(plan.count>impl->config.multiplier-1||outputs.size()!=plan.count){result.reason="Generated output count exceeds the graph capacity or does not match its phase plan";return result;}
 float preceding=0;for(unsigned i=0;i<plan.count;++i){const float phase=plan.timestamps[i];if(!std::isfinite(phase)||phase<=preceding||phase>=1){result.reason="Interpolation phases must increase strictly between zero and one";return result;}preceding=phase;}
 if(source.device!=impl->model->vk.device||cb.device!=source.device||source.textureType!=MTLTextureType2D||source.sampleCount!=1||source.framebufferOnly||!supported(source,impl->config.hdr)||(source.usage&MTLTextureUsageShaderRead)==0){result.reason="Frame generation requires a readable resolved texture matching its SDR or linear-scRGB profile";return result;}
 for(size_t index=0;index<outputs.size();++index){auto output=outputs[index];bool duplicate=false;for(size_t previous=0;previous<index;++previous)duplicate=duplicate||outputs[previous]==output;if(!output||output==source||duplicate||output.device!=source.device||output.width!=source.width||output.height!=source.height||output.textureType!=MTLTextureType2D||output.sampleCount!=1||output.framebufferOnly||!supported(output,impl->config.hdr)||(output.usage&MTLTextureUsageShaderWrite)==0){result.reason="Generated outputs must be distinct writable textures matching the source profile";return result;}}
 std::lock_guard<std::mutex>lock(impl->mutex);auto graph=impl->graph;
 if(graph&&graph->busy.load()&&graph->activeCommands!=cb){result.busy=true;result.reason="The preceding frame-generation buffer is still in flight";return result;}
 try{@try{
  if(impl->preparedResources&&(!graph||graph->failed.load()||graph->ctx.sourceExtent.width!=source.width||graph->ctx.sourceExtent.height!=source.height)){result.busy=true;result.reason="LSFG resources require preparation";return result;}
  if(impl->preparedResources&&graph->frames&&frameId>graph->lastFrame+1){graph->frames=0;graph->lastFrame=0;}
  if(!graph||graph->failed.load()||(graph->frames && frameId>graph->lastFrame+1)||graph->ctx.sourceExtent.width!=source.width||graph->ctx.sourceExtent.height!=source.height){graph=std::make_shared<Graph>(impl->model,impl->config,source.width,source.height);impl->graph=graph;++impl->graphBuilds;}
  if(!graph->pool->ready()){result.busy=!graph->pool->failed();result.reason=graph->pool->failed()?graph->pool->failure():"Initializing LSFG image storage";return result;}
  result.graphBuilds=impl->graphBuilds;
  if(graph->frames&&frameId<=graph->lastFrame){result.reason="Frame IDs must increase for temporal history";return result;}
  graph->busy.store(true);graph->activeCommands=cb;auto lease=std::make_shared<CompletionLease>([graph](bool success){if(!success)graph->failed.store(true);graph->busy.store(false);});
  [cb addCompletedHandler:^(id<MTLCommandBuffer>completed){lease->finish(completed.status==MTLCommandBufferStatusCompleted);}];
  result.dispatches=graph->encode(cb,source,outputs,plan);result.encoded=true;result.ready=graph->frames>=2;result.generated=result.ready?outputs.size():0;result.historyFrames=++graph->frames;graph->lastFrame=frameId;
  if(!result.ready)result.reason="Temporal history is warming up; present the real source frame";
 }@catch(NSException*error){if(graph)graph->failed.store(true);result.reason=error.reason.UTF8String?:"Frame generation failed";result.encoded=false;}}
 catch(const macfx::TransientBusy&error){result.reason=error.what();result.encoded=false;result.busy=!error.structurallyImpossible;}
 catch(const std::exception&error){if(graph)graph->failed.store(true);result.reason=error.what();result.encoded=false;}
 return result;
}}
