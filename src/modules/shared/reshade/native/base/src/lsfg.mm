// SPDX-License-Identifier: GPL-3.0-or-later
// Owned Metal host for the pinned, unchanged MAKO temporal shader graph.
#include "lsfg.hpp"
#include "completion.hpp"
#include "metal-vk.hpp"
#include "extraction/dll_reader.hpp"
#include "extraction/model_resources.hpp"
#include "extraction/model_resource_validation.hpp"
#include "helpers/utils.hpp"
#include "helpers/temporal_phases.hpp"
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
using namespace mako::backend;
namespace {
struct Model {
 vk::Vulkan vk;ShaderRegistry shaders;std::string hash;id<MTLComputePipelineState> copy,resolve;
 Model(id<MTLDevice> device,const macfx::LsfgConfig&config):vk(device){
  const auto archive=loadDllResourceArchive(config.modelPath);hash=archive->fileSha256;
  const auto selection=resolveLsfgModelResources(*archive,config.fp16,config.performance);
  std::map<uint32_t,vk::Shader> cache;
  auto shader=[&](unsigned logical,bool performance=false){const auto canonical=detail::lsfgResourceId(logical,config.fp16,performance);auto found=cache.find(canonical);if(found!=cache.end())return found->second;const auto specs=detail::lsfgShaderSpecs(performance);const auto spec=std::find_if(specs.begin(),specs.end(),[&](const auto&item){return item.logicalId==logical;});if(spec==specs.end())throw std::runtime_error("Unknown model stage");const auto&contract=spec->contract;auto value=vk::Shader(vk,selection.resource(*archive,canonical),selection.resourceId(canonical),contract.sampledImages,contract.storageImages,contract.uniformBuffers,contract.samplers);cache.emplace(canonical,value);return value;};
  shaders.mipmaps=shader(255);shaders.generate=shader(256);shaders.is_fp16=config.fp16;
  auto&s=config.performance?shaders.performance:shaders.quality;
  const unsigned alpha[]={267,268,269,270},beta[]={275,276,277,278,279},gamma[]={257,259,260,261,262},delta[]={257,263,264,265,266,258,271,272,273,274};
  for(unsigned i=0;i<4;++i)s.alpha[i]=shader(alpha[i],config.performance);for(unsigned i=0;i<5;++i){s.beta[i]=shader(beta[i],config.performance);s.gamma[i]=shader(gamma[i],config.performance);}for(unsigned i=0;i<10;++i)s.delta[i]=shader(delta[i],config.performance);
  const char*source=R"METAL(
   #include <metal_stdlib>
   using namespace metal;
   kernel void source_copy(texture2d<float,access::read> source[[texture(0)]],texture2d<float,access::write> target[[texture(1)]],uint2 p[[thread_position_in_grid]]){
    if(p.x<target.get_width()&&p.y<target.get_height())target.write(float4(source.read(p).rgb,1.0f),p);
   }
   kernel void opaque_resolve(texture2d<float,access::read> generated[[texture(0)]],texture2d<float,access::read> previous[[texture(1)]],texture2d<float,access::read> current[[texture(2)]],texture2d<float,access::write> output[[texture(3)]],constant float& timestamp[[buffer(0)]],uint2 p[[thread_position_in_grid]]){
    if(p.x>=output.get_width()||p.y>=output.get_height())return;
    float4 value=generated.read(p);float3 colour=value.a>0.00001f?value.rgb/value.a:mix(previous.read(p).rgb,current.read(p).rgb,timestamp);
    output.write(float4(clamp(colour,0.0f,1.0f),1.0f),p);
   })METAL";
  NSError*error=nil;auto library=[device newLibraryWithSource:@(source) options:nil error:&error];
  copy=library?[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"source_copy"] error:&error]:nil;
  resolve=library?[device newComputePipelineStateWithFunction:[library newFunctionWithName:@"opaque_resolve"] error:&error]:nil;
  if(!copy||!resolve)throw std::runtime_error(error.localizedDescription.UTF8String?:"Cannot create frame-generation image conversion");
 }
};
struct Branch {std::vector<Gamma0>g0;std::vector<Gamma1>g1;std::vector<Delta0>d0;std::vector<Delta1>d1;std::optional<Generate>generate;vk::Image generated;
 Branch(const Ctx&ctx,unsigned index,const std::pair<vk::Image,vk::Image>&source,const std::vector<Alpha0>&a0,const std::vector<Alpha1>&a1,const Beta1&b1,const vk::Image&black):generated(ctx.vk,ctx.sourceExtent,ctx.imageMemoryPool,VK_FORMAT_R16G16B16A16_SFLOAT){
  g0.reserve(7);g1.reserve(7);d0.reserve(3);d1.reserve(3);
  for(unsigned j=0;j<7;++j){g0.emplace_back(ctx,index,a1[6-j].getImages(),j?g1[j-1].getImage():black);g1.emplace_back(ctx,index,g0[j].getImages(),a0[6-j].getImages(),j?g1[j-1].getImage():black,b1.getImages()[j?6-j:5]);
   if(j>=4){d0.emplace_back(ctx,index,a1[6-j].getImages(),g0[j].getImages(),g1[j].getTempImages0(),j==4?black:d1[j-5].getImage0(),g1[j-1].getImage());d1.emplace_back(ctx,index,g0[j].getImages(),g1[j].getTempImages0(),g1[j].getTempImages1(),j==4?black:d1[j-5].getImage0(),b1.getImages()[6-j],j==4?black:d1[j-5].getImage1());}}
  generate.emplace(ctx,index,source,g1[6].getImage(),d1[2].getImage0(),d1[2].getImage1(),generated);
 }
 void encode(const vk::Vulkan&vk,const vk::CommandBuffer&cmd,unsigned frame){for(unsigned j=0;j<7;++j){g0[j].render(vk,cmd,frame);g1[j].render(vk,cmd);if(j>=4){d0[j-4].render(vk,cmd,frame);d1[j-4].render(vk,cmd);}}generate->render(vk,cmd,frame);}
};
struct Graph {
 std::shared_ptr<Model>model;std::shared_ptr<vk::ImageMemoryPool>pool=std::make_shared<vk::ImageMemoryPool>();Ctx ctx;
 std::pair<vk::Image,vk::Image>source;vk::Image black;Mipmaps mipmaps;std::vector<Alpha0>a0;std::vector<Alpha1>a1;std::optional<Beta0>b0;std::optional<Beta1>b1;std::vector<std::unique_ptr<Branch>>branches;
 std::atomic<bool>busy{false},failed{false};unsigned frames=0;uint64_t lastFrame=0;
 static std::vector<vk::Buffer> constants(const vk::Vulkan&vk,const macfx::LsfgConfig&config){std::vector<vk::Buffer>result;for(unsigned i=0;i<config.multiplier-1;++i)result.emplace_back(vk,getDefaultConstantBuffer(i,config.multiplier-1,false,1/config.flowScale));return result;}
 Graph(std::shared_ptr<Model>value,const macfx::LsfgConfig&config,unsigned width,unsigned height):model(value),ctx{std::cref(model->vk),std::cref(model->shaders),pool,{},vk::Buffer(model->vk,getDefaultConstantBuffer(0,1,false,1/config.flowScale)),constants(model->vk,config),vk::Sampler(model->vk,0),vk::Sampler(model->vk,1),vk::Sampler(model->vk,2),{width,height},{std::max(1u,unsigned(width*config.flowScale)),std::max(1u,unsigned(height*config.flowScale))},false,false,1/config.flowScale,config.performance,config.multiplier-1},source(vk::Image(model->vk,{width,height},pool),vk::Image(model->vk,{width,height},pool)),black(model->vk,{1,1},pool),mipmaps(ctx,source){
  a0.reserve(7);a1.reserve(7);for(unsigned i=0;i<7;++i){a0.emplace_back(ctx,mipmaps.getImages()[i]);a1.emplace_back(ctx,alphaHistoryCounts[i],a0[i].getImages());}
  b0.emplace(ctx,a1[0].getImages());b1.emplace(ctx,b0->getImages());for(unsigned i=0;i<config.multiplier-1;++i)branches.emplace_back(std::make_unique<Branch>(ctx,i,source,a0,a1,*b1,black));
 }
 unsigned encode(id<MTLCommandBuffer>cb,id<MTLTexture>input,const std::vector<id<MTLTexture>>&outputs,const macfx::InterpolationPlan&plan){
  const unsigned frame=frames;auto current=frame%2?source.second.texture:source.first.texture;auto previous=frame%2?source.first.texture:source.second.texture;
  auto copy=[cb computeCommandEncoder];[copy setComputePipelineState:model->copy];[copy setTexture:input atIndex:0];[copy setTexture:current atIndex:1];[copy dispatchThreads:MTLSizeMake(input.width,input.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[copy endEncoding];
  vk::CommandBuffer cmd(cb);mipmaps.render(model->vk,cmd,frame);for(unsigned i=0;i<7;++i){a0[6-i].render(model->vk,cmd);a1[6-i].render(model->vk,cmd,frame);}b0->render(model->vk,cmd,frame);b1->render(model->vk,cmd);
  for(unsigned i=0;i<plan.count;++i){auto constants=getDefaultConstantBuffer(i,branches.size(),false,ctx.flow);constants.timestamp=plan.timestamps[i];ctx.constantBuffers[i].write(model->vk,constants);auto&branch=*branches[i];branch.encode(model->vk,cmd,frame);auto resolve=[cb computeCommandEncoder];[resolve setComputePipelineState:model->resolve];[resolve setTexture:branch.generated.texture atIndex:0];[resolve setTexture:previous atIndex:1];[resolve setTexture:current atIndex:2];[resolve setTexture:outputs[i] atIndex:3];const float timestamp=plan.timestamps[i];[resolve setBytes:&timestamp length:sizeof(timestamp) atIndex:0];[resolve dispatchThreads:MTLSizeMake(input.width,input.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[resolve endEncoding];}
  return cmd.dispatchCount+1+plan.count;
 }
};
bool supported(id<MTLTexture>t){return t.pixelFormat==MTLPixelFormatRGBA8Unorm||t.pixelFormat==MTLPixelFormatBGRA8Unorm;}
}
struct macfx::LsfgEncoder::Impl {LsfgConfig config;std::shared_ptr<Model>model;std::shared_ptr<Graph>graph;unsigned graphBuilds=0;std::mutex mutex;Impl(id<MTLDevice>device,const LsfgConfig&value):config(value){if(!device||config.modelPath.empty()||config.multiplier<2||config.multiplier>5||!std::isfinite(config.flowScale)||config.flowScale<.25f||config.flowScale>1)throw std::runtime_error("Invalid frame-generation model, multiplier or flow scale");model=std::make_shared<Model>(device,config);}};
macfx::LsfgEncoder::LsfgEncoder(id<MTLDevice>device,const LsfgConfig&config):impl(std::make_unique<Impl>(device,config)){}
macfx::LsfgEncoder::~LsfgEncoder()=default;
macfx::LsfgResult macfx::LsfgEncoder::encode(id<MTLCommandBuffer>cb,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t frameId){InterpolationPlan plan;plan.count=impl->config.multiplier-1;for(unsigned i=0;i<plan.count;++i)plan.timestamps[i]=float(i+1)/impl->config.multiplier;return encode(cb,source,outputs,frameId,plan);}
macfx::LsfgResult macfx::LsfgEncoder::encode(id<MTLCommandBuffer>cb,id<MTLTexture>source,const std::vector<id<MTLTexture>>&outputs,uint64_t frameId,const InterpolationPlan&plan){@autoreleasepool{
 LsfgResult result;result.frameId=frameId;result.modelHash=impl->model->hash;
 if(!cb||!source||!cb.retainedReferences||cb.status>=MTLCommandBufferStatusCommitted){result.reason="Frame generation requires an unsubmitted retained command buffer and source";return result;}
 if(plan.count>impl->config.multiplier-1||outputs.size()!=plan.count){result.reason="Generated output count exceeds the graph capacity or does not match its phase plan";return result;}
 float preceding=0;for(unsigned i=0;i<plan.count;++i){const float phase=plan.timestamps[i];if(!std::isfinite(phase)||phase<=preceding||phase>=1){result.reason="Interpolation phases must increase strictly between zero and one";return result;}preceding=phase;}
 if(source.device!=impl->model->vk.device||cb.device!=source.device||source.textureType!=MTLTextureType2D||source.sampleCount!=1||source.framebufferOnly||!supported(source)||(source.usage&MTLTextureUsageShaderRead)==0){result.reason="Frame generation requires a readable, resolved SDR texture on its device";return result;}
 for(size_t index=0;index<outputs.size();++index){auto output=outputs[index];bool duplicate=false;for(size_t previous=0;previous<index;++previous)duplicate=duplicate||outputs[previous]==output;if(!output||output==source||duplicate||output.device!=source.device||output.width!=source.width||output.height!=source.height||output.textureType!=MTLTextureType2D||output.sampleCount!=1||output.framebufferOnly||!supported(output)||(output.usage&MTLTextureUsageShaderWrite)==0){result.reason="Generated outputs must be distinct writable SDR textures matching the source";return result;}}
 std::lock_guard<std::mutex>lock(impl->mutex);auto graph=impl->graph;
 if(graph&&graph->busy.load()){result.busy=true;result.reason="The preceding frame-generation buffer is still in flight";return result;}
 try{@try{
  if(!graph||graph->failed.load()||(graph->frames && frameId>graph->lastFrame+1)||graph->ctx.sourceExtent.width!=source.width||graph->ctx.sourceExtent.height!=source.height){graph=std::make_shared<Graph>(impl->model,impl->config,source.width,source.height);impl->graph=graph;++impl->graphBuilds;}
  result.graphBuilds=impl->graphBuilds;
  if(graph->frames&&frameId<=graph->lastFrame){result.reason="Frame IDs must increase for temporal history";return result;}
  graph->busy.store(true);auto lease=std::make_shared<CompletionLease>([graph](bool success){if(!success)graph->failed.store(true);graph->busy.store(false);});
  [cb addCompletedHandler:^(id<MTLCommandBuffer>completed){lease->finish(completed.status==MTLCommandBufferStatusCompleted);}];
  result.dispatches=graph->encode(cb,source,outputs,plan);result.encoded=true;result.ready=graph->frames>=2;result.generated=result.ready?outputs.size():0;result.historyFrames=++graph->frames;graph->lastFrame=frameId;
  if(!result.ready)result.reason="Temporal history is warming up; present the real source frame";
 }@catch(NSException*error){if(graph)graph->failed.store(true);result.reason=error.reason.UTF8String?:"Frame generation failed";result.encoded=false;}}
 catch(const std::exception&error){if(graph)graph->failed.store(true);result.reason=error.what();result.encoded=false;}
 return result;
}}
