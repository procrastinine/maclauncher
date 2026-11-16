#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// The final and HUD-less images determine a signed additive correction. This
// does not recover the UI's opacity and is not a UI_COLOR_ALPHA attachment.
#include "generation-provider.hpp"
#include "scene-aovs.hpp"
#include "image-color.hpp"
#include "image-admission.hpp"
#include <algorithm>
#include <atomic>
#include <array>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#include <dispatch/dispatch.h>
namespace macfx {
inline constexpr const char*hudDifferenceReason="UI derived from final and HUD-less color";
#define MACFX_HUD_DIFFERENCE_SHARED(...) __VA_ARGS__ inline constexpr const char*hudDifferenceScalarSource=#__VA_ARGS__;
MACFX_HUD_DIFFERENCE_SHARED(
inline float hudDifferenceChannel(float finalColor,float hudlessColor){return finalColor-hudlessColor;}
inline float hudComposeDifference(float generatedColor,float difference){return generatedColor+difference;}
)
inline bool hudDifferenceDomain(const ImageColorDescription&a,const ImageColorDescription&b)noexcept{
 return a.valid()&&b.valid()&&a.range==ColorRange::Full&&b.range==ColorRange::Full&&a.alpha==ColorAlpha::Opaque&&b.alpha==ColorAlpha::Opaque&&a.primaries==b.primaries&&a.transfer==b.transfer&&a.referenceWhite==b.referenceWhite&&a.peakLuminance==b.peakLuminance&&a.blackLuminance==b.blackLuminance&&a.hlgSystemGamma==b.hlgSystemGamma&&a.sceneReferred==b.sceneReferred;
}
inline std::string hudDifferenceKernelSource(){return std::string("#include <metal_stdlib>\nusing namespace metal;\n")+hudDifferenceScalarSource+R"MSL(
struct DifferenceParameters {uint width,height,finalSrgb,hudlessSrgb,generatedSrgb,outputSrgb;};
float3 differenceEncode(float3 v){return select(1.055f*pow(max(v,0.0f),float3(1.0f/2.4f))-.055f,v*12.92f,v<=.0031308f);}
float3 differenceDecode(float3 v){return select(pow(max((v+.055f)/1.055f,0.0f),float3(2.4f)),v/12.92f,v<=.04045f);}
kernel void hudDifferenceCompose(texture2d<float,access::read>finalColor[[texture(0)]],texture2d<float,access::read>hudless[[texture(1)]],texture2d<float,access::read>generated[[texture(2)]],texture2d<float,access::write>output[[texture(3)]],constant DifferenceParameters&p[[buffer(0)]],uint2 xy[[thread_position_in_grid]]){
 if(xy.x>=p.width||xy.y>=p.height)return;
 float3 f=finalColor.read(xy).rgb,h=hudless.read(xy).rgb,g=generated.read(xy).rgb;
 if(p.finalSrgb)f=differenceEncode(f);if(p.hudlessSrgb)h=differenceEncode(h);if(p.generatedSrgb)g=differenceEncode(g);
 float3 v=float3(hudComposeDifference(g.r,hudDifferenceChannel(f.r,h.r)),hudComposeDifference(g.g,hudDifferenceChannel(f.g,h.g)),hudComposeDifference(g.b,hudDifferenceChannel(f.b,h.b)));
 if(p.outputSrgb)v=differenceDecode(v);output.write(float4(v,1.0f),xy);
}
)MSL";}
inline bool hudDifferenceSrgb(MTLPixelFormat f){return f==MTLPixelFormatRGBA8Unorm_sRGB||f==MTLPixelFormatBGRA8Unorm_sRGB;}
inline bool hudDifferenceFormat(MTLPixelFormat f){return f==MTLPixelFormatRGBA8Unorm||f==MTLPixelFormatBGRA8Unorm||hudDifferenceSrgb(f)||f==MTLPixelFormatRGBA16Float||f==MTLPixelFormatRGBA32Float;}
inline bool hudDifferenceOutput(id<MTLTexture>image,id<MTLTexture>finalColor,const ImageColorDescription&color){
  return image&&finalColor&&image.device==finalColor.device&&image.width==finalColor.width&&image.height==finalColor.height&&image.textureType==MTLTextureType2D&&image.sampleCount==1&&!image.framebufferOnly&&hudDifferenceFormat(image.pixelFormat)&&(!hudDifferenceSrgb(image.pixelFormat)||color.transfer==ColorTransfer::SRGB||color.transfer==ColorTransfer::Linear)&&image!=finalColor;
}
inline bool hudDifferenceFrame(const SceneAovLease&aovs,const RSTemporalFrame&scene,id<MTLDevice>device,id<MTLTexture>finalColor,const ImageColorDescription&color,FrameOrigin origin){
  if(!finalColor||finalColor.device!=device||finalColor.textureType!=MTLTextureType2D||finalColor.sampleCount!=1||finalColor.framebufferOnly||finalColor.storageMode==MTLStorageModeMemoryless||!scene.frameId||aovs.value.images[RS_SCENE_AOV_UI_COLOR_ALPHA].texture)return false;
  const auto&p=aovs.value;const auto&r=p.images[RS_SCENE_AOV_HUDLESS_COLOR];auto hudless=aovs.textures[RS_SCENE_AOV_HUDLESS_COLOR];
  ImageColorDescription finalDomain,hudDomain;try{finalDomain=readImageColor(p.color);hudDomain=readImageColor(p.hudlessColor);}catch(...){return false;}
  if(!hudDifferenceDomain(finalDomain,hudDomain)||!hudDifferenceDomain(color,finalDomain)||p.frameId!=scene.frameId||!p.colorPass||(r.pass?:p.pass)!=p.colorPass||!rsSceneAovConventionsKnown(&p,RS_SCENE_AOV_HUDLESS_COLOR)||!aovs.composedRegionKnown||aovs.composedColor!=finalColor||aovs.composedX||aovs.composedY||aovs.composedWidth!=finalColor.width||aovs.composedHeight!=finalColor.height||!hudless||hudless.device!=device||hudless.textureType!=MTLTextureType2D||hudless.sampleCount!=1||hudless.framebufferOnly||hudless.storageMode==MTLStorageModeMemoryless||hudless.width!=finalColor.width||hudless.height!=finalColor.height||r.x||r.y||r.width!=finalColor.width||r.height!=finalColor.height||r.origin!=unsigned(origin)||r.encoding!=RS_SCENE_AOV_COLOR||!hudDifferenceFormat(hudless.pixelFormat)||!hudDifferenceFormat(finalColor.pixelFormat))return false;
  return true;
}
class HudDifferenceKernel {
 id<MTLComputePipelineState>pipeline=nil;
public:
 ShaderResult prepare(id<MTLDevice>device){if(pipeline)return {true,{}};NSError*error=nil;auto library=[device newLibraryWithSource:@(hudDifferenceKernelSource().c_str()) options:nil error:&error];auto function=library?[library newFunctionWithName:@"hudDifferenceCompose"]:nil;pipeline=function?[device newComputePipelineStateWithFunction:function error:&error]:nil;return {bool(pipeline),pipeline?"":error.localizedDescription.UTF8String?:"Cannot prepare the HUD difference composition"};}
 ShaderResult encode(id<MTLCommandBuffer>commands,id<MTLTexture>finalColor,id<MTLTexture>hudless,id<MTLTexture>generated,id<MTLTexture>output,const ImageColorDescription&color)const{
  if(!pipeline)return {false,hudDifferenceReason,true};
  if(!commands||!commands.retainedReferences||commands.status>=MTLCommandBufferStatusCommitted)return {false,"HUD difference needs retaining unsubmitted commands"};
  for(auto image:{finalColor,hudless,generated,output})if(!image||image.device!=commands.device||image.width!=output.width||image.height!=output.height||image.textureType!=MTLTextureType2D||image.sampleCount!=1||image.framebufferOnly||!hudDifferenceFormat(image.pixelFormat)||hudDifferenceSrgb(image.pixelFormat)&&color.transfer!=ColorTransfer::SRGB&&color.transfer!=ColorTransfer::Linear)return {false,"HUD difference images do not share a supported declared color domain and extent"};
  if(output==generated||output==finalColor||output==hudless)return {false,"HUD difference output must have distinct storage"};
  auto encoder=[commands computeCommandEncoder];if(!encoder)return {false,"Cannot encode HUD difference composition"};
  const bool encoded=color.transfer==ColorTransfer::SRGB;const struct{uint32_t width,height,finalSrgb,hudlessSrgb,generatedSrgb,outputSrgb;}parameters{uint32_t(output.width),uint32_t(output.height),encoded&&hudDifferenceSrgb(finalColor.pixelFormat),encoded&&hudDifferenceSrgb(hudless.pixelFormat),encoded&&hudDifferenceSrgb(generated.pixelFormat),encoded&&hudDifferenceSrgb(output.pixelFormat)};
  [encoder setComputePipelineState:pipeline];[encoder setTexture:finalColor atIndex:0];[encoder setTexture:hudless atIndex:1];[encoder setTexture:generated atIndex:2];[encoder setTexture:output atIndex:3];[encoder setBytes:&parameters length:sizeof(parameters) atIndex:0];[encoder dispatchThreads:MTLSizeMake(output.width,output.height,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder endEncoding];return {true,{}};
 }
};
// The decorator lives outside the existing color island: both subtraction and
// composition use the original declared domain. Providers remain unchanged.
class HudDifferenceGeneration final:public GenerationEncoder,public std::enable_shared_from_this<HudDifferenceGeneration>{
 std::shared_ptr<GenerationEncoder>provider;id<MTLDevice>device;dispatch_queue_t queue;unsigned phases;
 mutable std::mutex mutex;ImageColorDescription color;std::shared_ptr<HudDifferenceKernel>kernel;PreparedImageLease outputs;unsigned width=0,height=0;MTLPixelFormat format=MTLPixelFormatInvalid;std::atomic<bool>warming{false};
 struct Frame {__weak id<MTLCommandBuffer>commands=nil;id<MTLTexture>finalColor=nil,hudless=nil;std::shared_ptr<const SceneAovLease>aovs;bool active=false;};Frame frame;bool previousDerived=false;
 void warm(unsigned w,unsigned h,MTLPixelFormat f){std::shared_ptr<HudDifferenceKernel>next;{std::lock_guard lock(mutex);next=kernel;}if(!next)next=std::make_shared<HudDifferenceKernel>();auto ready=next->prepare(device);if(!ready.encoded)throw std::runtime_error(ready.reason);{std::lock_guard lock(mutex);kernel=next;}auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:f width:w height:h mipmapped:NO];descriptor.storageMode=MTLStorageModePrivate;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;ImagePoolClient client(device);auto prepared=client.prepare(descriptor,"hud-difference-generated",4*phases);while(prepared.counts().images<4*phases)if(!prepared.grow())throw TransientBusy(hudDifferenceReason);std::lock_guard lock(mutex);kernel=std::move(next);outputs=std::move(prepared);width=w;height=h;format=f;}
public:
 HudDifferenceGeneration(id<MTLDevice>d,std::shared_ptr<GenerationEncoder>p,unsigned count,dispatch_queue_t q):provider(std::move(p)),device(d),queue(q),phases(count){}
 const char*method()const noexcept override{return provider->method();}const char*activeMethod()const noexcept override{return provider->activeMethod();}std::string activeReason()const override{return provider->activeReason();}
 bool requiresScene()const noexcept override{return provider->requiresScene();}bool acceptsSynthetic()const noexcept override{return provider->acceptsSynthetic();}bool requiresOpaque()const noexcept override{return provider->requiresOpaque();}bool acceptsExplicitIntervals()const noexcept override{return provider->acceptsExplicitIntervals();}bool acceptsUnspecifiedColor()const noexcept override{return provider->acceptsUnspecifiedColor();}bool usesExplicitPreviousImage()const noexcept override{return provider->usesExplicitPreviousImage();}
 void setColorDescription(const ImageColorDescription&v)override{std::lock_guard lock(mutex);color=v;provider->setColorDescription(v);}ShaderResult setIntervalUI(id<MTLTexture>v,bool p,float a)override{return provider->setIntervalUI(v,p,a);}void setSceneColorJitter(bool v)override{provider->setSceneColorJitter(v);}void setSceneOrigin(FrameOrigin v)override{provider->setSceneOrigin(v);}ShaderResult preparationStatus()const override{return provider->preparationStatus();}bool outputDisplayMapped(bool v)const noexcept override{return provider->outputDisplayMapped(v);}bool gpuTimingAvailable()const override{return provider->gpuTimingAvailable();}
 GenerationResult prepare(id<MTLCommandBuffer>c,id<MTLTexture>source,const RSTemporalFrame*s)override{return provider->prepare(c,source,s);}
 ShaderResult bindDifference(id<MTLCommandBuffer>commands,id<MTLTexture>finalColor,const std::shared_ptr<const SceneAovLease>&aovs,const RSTemporalFrame&scene,FrameOrigin origin){
  std::lock_guard lock(mutex);frame={};if(!aovs||!aovs->value.images[RS_SCENE_AOV_HUDLESS_COLOR].texture||aovs->value.images[RS_SCENE_AOV_UI_COLOR_ALPHA].texture)return {true,{}};
  // The difference is optional. A frame it does not apply to generates from
  // the final image, with the HUD interpolated along with the scene.
  if(provider->outputDisplayMapped(false)||!hudDifferenceFrame(*aovs,scene,device,finalColor,color,origin))return {true,{}};
  auto hudless=aovs->textures[RS_SCENE_AOV_HUDLESS_COLOR];
  if(!kernel||width!=finalColor.width||height!=finalColor.height||format!=finalColor.pixelFormat){if(!warming.exchange(true)){auto self=shared_from_this();const auto w=unsigned(finalColor.width),h=unsigned(finalColor.height);const auto f=finalColor.pixelFormat;dispatch_async(queue,^{@autoreleasepool{try{self->warm(w,h,f);}catch(...){}self->warming.store(false);}});}return {true,{}};}
  frame={commands,finalColor,hudless,aovs,true};return {true,{}};
 }
 void setScene(const RSTemporalFrame&s)override{std::lock_guard lock(mutex);auto actual=s;if(frame.active!=previousDerived)actual.flags|=RS_TEMPORAL_RESET;previousDerived=frame.active;if(frame.active){actual.color=(__bridge void*)frame.hudless;actual.output=(__bridge void*)frame.hudless;}provider->setScene(actual);}
 GenerationResult encode(id<MTLCommandBuffer>c,id<MTLTexture>s,const std::vector<id<MTLTexture>>&o,uint64_t n,const InterpolationPlan&p)override{return encodeColorTimed(c,s,o,n,p,false,false);}
 GenerationResult encodeColor(id<MTLCommandBuffer>c,id<MTLTexture>s,const std::vector<id<MTLTexture>>&o,uint64_t n,const InterpolationPlan&p,bool mapped)override{return encodeColorTimed(c,s,o,n,p,mapped,false);}
 GenerationResult encodeColorTimed(id<MTLCommandBuffer>commands,id<MTLTexture>source,const std::vector<id<MTLTexture>>&out,uint64_t sequence,const InterpolationPlan&plan,bool mapped,bool measure)override{
  Frame current;PreparedImageLease prepared;std::shared_ptr<HudDifferenceKernel>encoder;ImageColorDescription domain;{std::lock_guard lock(mutex);current=frame;frame={};prepared=outputs;encoder=kernel;domain=color;}
  if(!current.active)return provider->encodeColorTimed(commands,source,out,sequence,plan,mapped,measure);
  // Anything the composition cannot take generates from the final image, HUD included.
  const auto ordinary=[&]{return provider->encodeColorTimed(commands,source,out,sequence,plan,mapped,measure);};
  if(current.commands!=commands||current.finalColor!=source||out.size()>phases||!encoder)return ordinary();
  for(auto image:out)if(!hudDifferenceOutput(image,current.finalColor,domain))return ordinary();
  auto holds=std::make_shared<std::vector<PooledImage>>();std::vector<id<MTLTexture>>raw;holds->reserve(out.size());raw.reserve(out.size());for(size_t i=0;i<out.size();++i){auto image=prepared.acquire();if(!image)return ordinary();raw.push_back(image.texture());holds->push_back(std::move(image));}
  GenerationResult result;
  [commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)holds;(void)current;}];
  result=provider->encodeColorTimed(commands,current.hudless,raw,sequence,plan,mapped,measure);if(result.encoded&&result.ready)for(unsigned i=0;i<result.generated&&i<out.size();++i){const auto composed=encoder->encode(commands,current.finalColor,current.hudless,raw[i],out[i],domain);if(!composed.encoded){result.encoded=false;result.reason=composed.reason;return result;}}return result;
 }
 GenerationResult encodeInterval(id<MTLCommandBuffer>c,id<MTLTexture>previous,id<MTLTexture>source,const std::vector<id<MTLTexture>>&out,uint64_t sequence,const InterpolationPlan&p)override{
  {std::lock_guard lock(mutex);frame={};}return provider->encodeInterval(c,previous,source,out,sequence,p);
 }
 uint64_t imageBytes(unsigned w,unsigned h,const GenerationMeasure&measure)const override{const auto base=provider->imageBytes(w,h,measure);std::lock_guard lock(mutex);if(!outputs)return base;const auto unit=measure(w,h,format==MTLPixelFormatRGBA16Float||format==MTLPixelFormatRGBA32Float?8:4),count=uint64_t(4)*phases*(format==MTLPixelFormatRGBA32Float?2:1);if(count&&unit>UINT64_MAX/count)return UINT64_MAX;const auto extra=unit*count;return base>UINT64_MAX-extra?UINT64_MAX:base+extra;}
};
inline std::shared_ptr<GenerationEncoder>makeHudDifferenceGenerationEncoder(id<MTLDevice>d,std::shared_ptr<GenerationEncoder>provider,unsigned phases,dispatch_queue_t queue){if(!provider->requiresScene())return provider;return std::make_shared<HudDifferenceGeneration>(d,std::move(provider),phases,queue);}
inline ShaderResult bindHudDifference(const std::shared_ptr<GenerationEncoder>&encoder,id<MTLCommandBuffer>commands,id<MTLTexture>color,const std::shared_ptr<const SceneAovLease>&aovs,const RSTemporalFrame&scene,FrameOrigin origin){if(auto difference=std::dynamic_pointer_cast<HudDifferenceGeneration>(encoder))return difference->bindDifference(commands,color,aovs,scene,origin);return {true,{}};}
}
