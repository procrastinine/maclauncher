// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-color-normalize.hpp"
#include "image-color.hpp"
#include "image-admission.hpp"
#include <algorithm>
#include <cmath>
namespace macfx {namespace {
bool radiance(unsigned role){return role==RS_SCENE_AOV_RESOLVED_RADIANCE||role==RS_SCENE_AOV_RESOLVED_SPECULAR||role==RS_SCENE_AOV_NOISY_DIFFUSE||role==RS_SCENE_AOV_NOISY_SPECULAR;}
bool reflectance(unsigned role){return role==RS_SCENE_AOV_DIFFUSE_ALBEDO||role==RS_SCENE_AOV_SPECULAR_ALBEDO;}
bool colorRole(unsigned role){return radiance(role)||reflectance(role)||role==RS_SCENE_AOV_TRANSPARENCY||role==RS_SCENE_AOV_HUDLESS_COLOR||role==RS_SCENE_AOV_UI_COLOR_ALPHA;}
ImageColorDescription description(const RSSceneAovs&p,unsigned role){return readImageColor(role==RS_SCENE_AOV_HUDLESS_COLOR?p.hudlessColor:role==RS_SCENE_AOV_UI_COLOR_ALPHA?p.uiColor:p.color);}
ShaderResult conversion(const RSSceneAovs&p,unsigned role,const ImageColorDescription&working,float exposure,ColorConversion&c){
 try{c.source=description(p,role);c.target=working;c.target.alpha=ColorAlpha::Straight;
  if(c.target.transfer!=ColorTransfer::Linear||c.target.range!=ColorRange::Full)return {false,"Named scene color requires a linear full-range working domain"};
  if(radiance(role)){
   if(!c.source.sceneReferred||!working.sceneReferred)return {false,"Scene radiance needs the original scene-referred color domain"};
   const auto pass=p.images[role].pass?:p.pass;if(!pass||pass!=p.colorPass)return {false,"Scene radiance does not cover the current color pass"};
   if(!std::isfinite(exposure)||exposure<=0||!std::isfinite(p.preExposure)||p.preExposure<=0)return {false,"Scene radiance needs its actual source and attachment pre-exposure"};
   const double gain=double(exposure)/p.preExposure,ev=std::log2(gain);if(!std::isfinite(ev)||std::abs(ev)>32)return {false,"Scene radiance pre-exposure conversion exceeds the supported finite range"};c.exposure=float(ev);
  }else if(reflectance(role)){c.source.referenceWhite=c.target.referenceWhite;c.source.peakLuminance=c.source.referenceWhite;c.source.blackLuminance=0;c.source.range=ColorRange::Full;}
  // Material/radiance alpha is auxiliary renderer storage, not association.
  // Actual UI/overlay alpha retains its independently declared association.
  if(!radiance(role)&&!reflectance(role)&&c.source.sceneReferred!=working.sceneReferred)return {false,"Scene and display color attachments need an explicitly matching working domain"};
  if(c.source.alpha==ColorAlpha::Opaque||radiance(role)||reflectance(role))c.source.alpha=ColorAlpha::Straight;
  c.frameId=p.frameId;return {true,{}};
 }catch(const std::exception&e){return {false,e.what()};}
}
bool identity(const ColorConversion&c){return c.source.primaries==c.target.primaries&&c.source.transfer==ColorTransfer::Linear&&c.source.range==ColorRange::Full&&c.source.alpha==ColorAlpha::Straight&&c.source.referenceWhite==c.target.referenceWhite&&c.exposure==0;}
}
struct SceneColorNormalizer::Impl {
 __weak id<MTLCommandQueue>queue=nil;ImageColorDescription working;
 struct Operation{unsigned role=0;ColorConversion conversion;bool radiance=false,identity=false;};
 std::shared_ptr<ColorEncoder>encoder;uint32_t mask=0;std::vector<Operation>operations;
 std::array<id<MTLTexture>,RS_SCENE_AOV_COUNT>images{};
 Impl(id<MTLCommandQueue>q,const ImageColorDescription&c):queue(q),working(c),encoder(std::make_shared<ColorEncoder>(q.device)){}
};
SceneColorNormalizer::SceneColorNormalizer(id<MTLCommandQueue>queue,const ImageColorDescription&working):impl(std::make_shared<Impl>(queue,working)){}
ShaderResult SceneColorNormalizer::prepare(const RSSceneAovs&p,uint32_t mask){try{
 auto previous=impl;auto queue=previous->queue;if(!queue||!previous->working.valid())return {false,"Scene color conversion needs its actual queue and working metadata"};
 if(!validatedSceneAovs(p,queue.device))return {false,"The scene color attachment packet is invalid"};
 auto state=std::make_shared<Impl>(queue,previous->working);state->images=previous->images;
 for(unsigned role=0;role<RS_SCENE_AOV_COUNT;++role)if((mask&(1u<<role))&&colorRole(role)){
  const auto&a=p.images[role];auto input=(__bridge id<MTLTexture>)a.texture;if(!input||a.x||a.y||a.width!=input.width||a.height!=input.height)return {false,"Normalize scene color attachment geometry before color conversion"};
  // Pre-exposure is a per-frame scalar, not a resource preparation identity.
  ColorConversion c;auto valid=conversion(p,role,state->working,p.preExposure,c);if(!valid.encoded)return valid;
  const auto format=MTLPixelFormatRGBA32Float;
  if(!state->images[role]||state->images[role].width!=input.width||state->images[role].height!=input.height||state->images[role].pixelFormat!=format){auto*d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format width:input.width height:input.height mipmapped:NO];d.storageMode=MTLStorageModePrivate;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;state->images[role]=newAdmittedTexture(queue.device,d,reinterpret_cast<uintptr_t>(this),"scene-color-normalized");}
  auto ready=state->encoder->prepare(format);if(!ready.encoded)return ready;state->mask|=1u<<role;state->operations.push_back({role,c,radiance(role),identity(c)});
 }
 impl=std::move(state);return {true,{}};
 }catch(const ImageBudgetExceeded&e){return {false,e.what(),true};}catch(const std::exception&e){return {false,e.what()};}}
ShaderResult SceneColorNormalizer::frame(id<MTLCommandBuffer>commands,const RSSceneAovs&p,float currentPreExposure,bool encode,RSSceneAovs&result){try{
 const auto state=impl;if(!commands||commands.commandQueue!=state->queue||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences)return {false,"Named scene color requires its prepared unsubmitted command queue"};
 std::array<ColorConversion,RS_SCENE_AOV_COUNT>conversions{};std::array<id<MTLTexture>,RS_SCENE_AOV_COUNT>inputs{};
 // Validate every requested value before any conversion is recorded.
 for(const auto&operation:state->operations){const auto role=operation.role;
  const auto&a=p.images[role];auto image=(__bridge id<MTLTexture>)a.texture;auto target=state->images[role];if(!image||!target||a.x||a.y||a.width!=target.width||a.height!=target.height||image.width!=target.width||image.height!=target.height)return {false,"Prepare scene color for the current attachment geometry",true};
  conversions[role]=operation.conversion;conversions[role].frameId=p.frameId;
  if(operation.radiance){if(!std::isfinite(currentPreExposure)||currentPreExposure<=0||!std::isfinite(p.preExposure)||p.preExposure<=0)return {false,"Scene radiance needs its actual source and attachment pre-exposure"};const double ev=std::log2(double(currentPreExposure)/p.preExposure);if(!std::isfinite(ev)||std::abs(ev)>32)return {false,"Scene radiance pre-exposure conversion exceeds the supported finite range"};conversions[role].exposure=float(ev);}inputs[role]=image;
 }
 result=p;
 for(const auto&operation:state->operations){const auto role=operation.role;
  const bool unchanged=operation.identity&&conversions[role].exposure==0;
  if(encode&&!unchanged){auto converted=state->encoder->encode(commands,inputs[role],state->images[role],conversions[role],true);if(!converted.encoded)return converted;}
  auto&out=result.images[role];out.texture=(__bridge void*)(unchanged?inputs[role]:state->images[role]);out.encoding=RS_SCENE_AOV_COLOR;
  if(role==RS_SCENE_AOV_HUDLESS_COLOR)result.hudlessColor=writeImageColor(conversions[role].target);
  else if(role==RS_SCENE_AOV_UI_COLOR_ALPHA)result.uiColor=writeImageColor(conversions[role].target);
 }
 auto color=state->working;color.alpha=ColorAlpha::Straight;result.color=writeImageColor(color);if(state->mask&((1u<<RS_SCENE_AOV_RESOLVED_RADIANCE)|(1u<<RS_SCENE_AOV_RESOLVED_SPECULAR)|(1u<<RS_SCENE_AOV_NOISY_DIFFUSE)|(1u<<RS_SCENE_AOV_NOISY_SPECULAR)))result.preExposure=currentPreExposure;
 if(encode)[commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)state;(void)inputs;}];return {true,{}};
 }catch(const std::exception&e){return {false,e.what()};}}
}
