#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// A premultiplied interface layer composed over a HUD-less image gives
// final = ui + hudless * (1 - alpha), so hudless = (final - ui) / (1 - alpha).
// The division is used only up to hudSplitMaximumAlpha: above it, 8-bit
// rounding of final and ui is multiplied by more than 1 / (1 - 0.9) = 10,
// so those pixels are filled from nearby derived pixels instead. The same
// text is compiled into the Metal kernel and into the CPU check.
#include <string>
#define MACFX_HUD_SPLIT_SHARED(...) __VA_ARGS__ inline constexpr const char*hudSplitSharedSource=#__VA_ARGS__;
namespace macfx {
MACFX_HUD_SPLIT_SHARED(
inline float hudSplitMaximumAlpha(){return 0.9f;}
inline bool hudSplitDerivable(float alpha){return alpha<=hudSplitMaximumAlpha();}
inline float hudSplitChannel(float composed,float ui,float alpha){float value=(composed-ui)/(1.0f-alpha);return value<0.0f?0.0f:(value>1.0f?1.0f:value);}
)
// One pass over the composed image and the interface layer, both in the
// display encoding the interface was blended in. Where the interface is
// nearly opaque, the nearest ring of derivable pixels (radius 2 to 128, eight
// directions) supplies the HUD-less colour; with none in reach, the composed
// colour is kept. The overlay is final - hudless * (1 - alpha), so the real
// image is reproduced exactly by overlay + hudless * (1 - alpha).
inline std::string hudSplitKernelSource(){
 return std::string("#include <metal_stdlib>\nusing namespace metal;\n")+hudSplitSharedSource+R"MSL(
static float hudEncode(float x){x=max(x,0.0f);return x<=0.0031308f?x*12.92f:1.055f*pow(x,1.0f/2.4f)-0.055f;}
static float hudDecode(float x){return x<=0.04045f?x/12.92f:pow((x+0.055f)/1.055f,2.4f);}
static float3 hudEncoded(float3 v,uint srgb){return srgb?float3(hudEncode(v.r),hudEncode(v.g),hudEncode(v.b)):v;}
static float3 hudDecoded(float3 v,uint srgb){return srgb?float3(hudDecode(v.r),hudDecode(v.g),hudDecode(v.b)):v;}
struct HudSplitParameters {uint colourSRGB,uiSRGB;};
static float3 hudDerived(texture2d<float,access::read>colour,texture2d<float,access::read>ui,uint2 p,constant HudSplitParameters&k,thread float&alpha){
 const float4 u=ui.read(p);alpha=u.a;const float3 f=hudEncoded(colour.read(p).rgb,k.colourSRGB),o=hudEncoded(u.rgb,k.uiSRGB);
 return float3(hudSplitChannel(f.r,o.r,alpha),hudSplitChannel(f.g,o.g,alpha),hudSplitChannel(f.b,o.b,alpha));
}
kernel void hudSplit(texture2d<float,access::read>colour[[texture(0)]],texture2d<float,access::read>ui[[texture(1)]],texture2d<float,access::write>hudless[[texture(2)]],texture2d<float,access::write>overlay[[texture(3)]],constant HudSplitParameters&k[[buffer(0)]],uint2 p[[thread_position_in_grid]]){
 const uint w=colour.get_width(),h=colour.get_height();if(p.x>=w||p.y>=h)return;
 const float3 f=hudEncoded(colour.read(p).rgb,k.colourSRGB);float alpha=0;float3 hud=hudDerived(colour,ui,p,k,alpha);
 if(!hudSplitDerivable(alpha)){
  const int2 directions[8]={int2(1,0),int2(-1,0),int2(0,1),int2(0,-1),int2(1,1),int2(-1,1),int2(1,-1),int2(-1,-1)};
  float3 sum=float3(0);float count=0;
  for(int radius=2;radius<=128&&count==0;radius*=2)for(int d=0;d<8;++d){
   const int2 q=int2(p)+directions[d]*radius;if(q.x<0||q.y<0||q.x>=int(w)||q.y>=int(h))continue;
   float a=0;const float3 v=hudDerived(colour,ui,uint2(q),k,a);if(hudSplitDerivable(a)){sum+=v;count+=1;}
  }
  hud=count>0?sum/count:f;
 }
 hudless.write(float4(hudDecoded(hud,k.colourSRGB),1.0f),p);
 overlay.write(float4(hudDecoded(max(f-hud*(1.0f-alpha),float3(0)),k.colourSRGB),alpha),p);
}
)MSL";
}
}
#if defined(__OBJC__)
#import <Metal/Metal.h>
#include <algorithm>
#include <atomic>
#include <memory>
#include <mutex>
#include <vector>
namespace macfx {
// The images of one presented frame: the interface layer copied on the
// producer's own commands, and the HUD-less/overlay pair in the generation
// image's format. leased stays true while a scene attachment lease built from
// them lives; the set is reused only after that lease retires.
struct HudSplitImages {id<MTLTexture>snapshot=nil,hudless=nil,ui=nil;std::atomic<bool>leased{false};};
inline bool hudSplitFormat(MTLPixelFormat f){return f==MTLPixelFormatRGBA8Unorm||f==MTLPixelFormatRGBA8Unorm_sRGB||f==MTLPixelFormatBGRA8Unorm||f==MTLPixelFormatBGRA8Unorm_sRGB;}
inline bool hudSplitSRGB(MTLPixelFormat f){return f==MTLPixelFormatRGBA8Unorm_sRGB||f==MTLPixelFormatBGRA8Unorm_sRGB;}
class HudSplitEncoder {
 id<MTLDevice>device;id<MTLComputePipelineState>pipeline=nil;std::once_flag compiled;std::string failure;std::mutex lock;std::vector<std::shared_ptr<HudSplitImages>>pool;
 static id<MTLTexture>image(id<MTLDevice>device,NSUInteger width,NSUInteger height,MTLPixelFormat format,MTLTextureUsage usage){auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:width height:height mipmapped:NO];d.usage=usage;d.storageMode=MTLStorageModePrivate;return [device newTextureWithDescriptor:d];}
public:
 explicit HudSplitEncoder(id<MTLDevice>value):device(value){}
 static std::shared_ptr<HudSplitEncoder>forDevice(id<MTLDevice>device){static std::mutex mutex;static std::vector<std::shared_ptr<HudSplitEncoder>>encoders;std::lock_guard guard(mutex);for(const auto&e:encoders)if(e->device==device)return e;encoders.push_back(std::make_shared<HudSplitEncoder>(device));return encoders.back();}
 // On the producer's commands that present this frame, before the producer
 // draws its next interface layer into the same texture.
 std::shared_ptr<HudSplitImages>snapshot(id<MTLCommandBuffer>commands,id<MTLTexture>ui){
  if(!commands||!ui||ui.device!=device||commands.device!=device||!hudSplitFormat(ui.pixelFormat))return {};
  std::shared_ptr<HudSplitImages>set;{std::lock_guard guard(lock);
   for(const auto&candidate:pool)if(candidate.use_count()==1&&!candidate->leased.load(std::memory_order_acquire)){set=candidate;break;}
   if(!set){if(pool.size()>=4)return {};pool.push_back(std::make_shared<HudSplitImages>());set=pool.back();}}
  if(!set->snapshot||set->snapshot.width!=ui.width||set->snapshot.height!=ui.height||set->snapshot.pixelFormat!=ui.pixelFormat)set->snapshot=image(device,ui.width,ui.height,ui.pixelFormat,MTLTextureUsageShaderRead);
  auto blit=set->snapshot?[commands blitCommandEncoder]:nil;if(!blit)return {};
  blit.label=@"MacLauncher interface layer";[blit copyFromTexture:ui toTexture:set->snapshot];[blit endEncoding];return set;
 }
 bool split(id<MTLCommandBuffer>commands,id<MTLTexture>colour,HudSplitImages&set,std::string&reason){
  if(!commands||!colour||colour.device!=device||!hudSplitFormat(colour.pixelFormat)){reason="The interface layer split supports 8-bit RGBA and BGRA generation images";return false;}
  if(!set.snapshot||set.snapshot.width!=colour.width||set.snapshot.height!=colour.height){reason="The interface layer size differs from the generation image";return false;}
  if(set.leased.load(std::memory_order_acquire)){reason="The interface layer images are still in use";return false;}
  std::call_once(compiled,[&]{NSError*error=nil;auto library=[device newLibraryWithSource:@(hudSplitKernelSource().c_str()) options:nil error:&error];auto function=library?[library newFunctionWithName:@"hudSplit"]:nil;pipeline=function?[device newComputePipelineStateWithFunction:function error:&error]:nil;if(!pipeline)failure=error.localizedDescription.UTF8String?:"The interface layer split kernel did not compile";});
  if(!pipeline){reason=failure;return false;}
  if(!set.hudless||set.hudless.width!=colour.width||set.hudless.height!=colour.height||set.hudless.pixelFormat!=colour.pixelFormat){const auto usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;set.hudless=image(device,colour.width,colour.height,colour.pixelFormat,usage);set.ui=image(device,colour.width,colour.height,colour.pixelFormat,usage);}
  auto encoder=set.hudless&&set.ui?[commands computeCommandEncoder]:nil;if(!encoder){reason="The interface layer split images could not be allocated";return false;}
  const struct {uint32_t colour,ui;}parameters{hudSplitSRGB(colour.pixelFormat),hudSplitSRGB(set.snapshot.pixelFormat)};
  encoder.label=@"MacLauncher interface layer split";[encoder setComputePipelineState:pipeline];[encoder setTexture:colour atIndex:0];[encoder setTexture:set.snapshot atIndex:1];[encoder setTexture:set.hudless atIndex:2];[encoder setTexture:set.ui atIndex:3];[encoder setBytes:&parameters length:sizeof(parameters) atIndex:0];
  const NSUInteger width=pipeline.threadExecutionWidth,height=std::max<NSUInteger>(1,pipeline.maxTotalThreadsPerThreadgroup/width);
  [encoder dispatchThreads:MTLSizeMake(colour.width,colour.height,1) threadsPerThreadgroup:MTLSizeMake(width,height,1)];[encoder endEncoding];return true;
 }
};
}
#endif
