// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-aovs.hpp"
#include "effects-plan.hpp"
#include "image-color.hpp"
#include "temporal-controls.hpp"
#include "metalfx-denoised.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <deque>
#include <cstring>
#include <mutex>
#include <unordered_map>
namespace {
using macfx::SceneAovLease;
constexpr unsigned maximumOwners=128,maximumFrames=32,maximumPending=64;
bool readable(id<MTLTexture>image){return image&&image.textureType==MTLTextureType2D&&image.sampleCount==1&&!image.framebufferOnly&&(image.usage==MTLTextureUsageUnknown||image.usage&MTLTextureUsageShaderRead);}
unsigned components(MTLPixelFormat format){switch(format){
 case MTLPixelFormatR8Unorm:case MTLPixelFormatR8Snorm:case MTLPixelFormatR16Unorm:case MTLPixelFormatR16Float:case MTLPixelFormatR32Float:return 1;
 case MTLPixelFormatRG8Unorm:case MTLPixelFormatRG8Snorm:case MTLPixelFormatRG16Unorm:case MTLPixelFormatRG16Float:case MTLPixelFormatRG32Float:return 2;
 case MTLPixelFormatRG11B10Float:case MTLPixelFormatRGB9E5Float:return 3;
 case MTLPixelFormatRGBA8Unorm:case MTLPixelFormatRGBA8Unorm_sRGB:case MTLPixelFormatRGBA8Snorm:case MTLPixelFormatBGRA8Unorm:case MTLPixelFormatBGRA8Unorm_sRGB:case MTLPixelFormatRGBA16Unorm:case MTLPixelFormatRGBA16Float:case MTLPixelFormatRGBA32Float:case MTLPixelFormatRGB10A2Unorm:return 4;
 default:return 0;
}}
bool color(const RSImageColorDescription&c,bool encoded=false){try{return c.size==sizeof(c)&&(encoded||c.transfer==RS_COLOR_LINEAR)&&macfx::readImageColor(c).valid();}catch(...){return false;}}
bool tuple(id<MTLTexture>c,id<MTLTexture>d,id<MTLTexture>m){return c&&c.textureType==MTLTextureType2D&&(!d||d.device==c.device)&&(!m||m.device==c.device);}
RSSceneAovs sanitizeHud(const RSSceneAovs&input,id<MTLDevice>device){
 auto v=input;const auto validImage=[&](const RSSceneAovImage&a){auto image=(__bridge id<MTLTexture>)a.texture;return readable(image)&&image.device==device&&a.width&&a.height&&uint64_t(a.x)+a.width<=image.width&&uint64_t(a.y)+a.height<=image.height&&a.origin<=RS_SCENE_AOV_BOTTOM_LEFT;};
 const auto&hud=v.images[RS_SCENE_AOV_HUDLESS_COLOR];const auto&ui=v.images[RS_SCENE_AOV_UI_COLOR_ALPHA];auto texture=(__bridge id<MTLTexture>)ui.texture;
 const auto format=texture.pixelFormat;const bool alpha=format==MTLPixelFormatRGBA8Unorm||format==MTLPixelFormatRGBA8Unorm_sRGB||format==MTLPixelFormatBGRA8Unorm||format==MTLPixelFormatBGRA8Unorm_sRGB||format==MTLPixelFormatRGBA16Float||format==MTLPixelFormatRGBA32Float||format==MTLPixelFormatRGB10A2Unorm;
 const auto hudPass=hud.pass?:v.pass,uiPass=ui.pass?:v.pass;
 if(!validImage(hud)||!validImage(ui)||hud.encoding!=RS_SCENE_AOV_COLOR||ui.encoding!=RS_SCENE_AOV_COLOR||!color(v.hudlessColor,true)||!color(v.uiColor,true)||v.uiColor.alpha==RS_COLOR_OPAQUE||!alpha||!hudPass||hudPass!=uiPass||hudPass!=v.colorPass){v.images[RS_SCENE_AOV_HUDLESS_COLOR]={};v.images[RS_SCENE_AOV_UI_COLOR_ALPHA]={};v.uiColor={};v.hudlessColor={};}
 return v;
}
bool valid(const RSSceneAovs&v,id<MTLDevice>device){
 if(v.size!=sizeof(v)||v.version!=RS_SCENE_AOV_ABI_VERSION||!v.frameId||!v.viewId||!v.epoch||v.reserved||v.reserved2||v.flags&~uint32_t(RS_SCENE_AOV_COLOR_NOISY|RS_SCENE_AOV_RADIANCE_INCLUDES_SPECULAR|RS_SCENE_AOV_COLOR_INCLUDES_SPECULAR|RS_SCENE_AOV_SPECULAR_MERGE_PENDING)||v.pass>RS_SCENE_AOV_TEMPORAL_INPUT||v.colorPass>RS_SCENE_AOV_TEMPORAL_INPUT||!color(v.color)||!std::isfinite(v.preExposure)||v.preExposure<=0)return false;
 if((v.flags&(RS_SCENE_AOV_COLOR_INCLUDES_SPECULAR|RS_SCENE_AOV_SPECULAR_MERGE_PENDING))==(RS_SCENE_AOV_COLOR_INCLUDES_SPECULAR|RS_SCENE_AOV_SPECULAR_MERGE_PENDING))return false;
 if(v.images[RS_SCENE_AOV_UI_COLOR_ALPHA].texture&&!color(v.uiColor,true))return false;
 unsigned count=0;for(unsigned slot=0;slot<RS_SCENE_AOV_COUNT;++slot){const auto&a=v.images[slot];if(!a.texture)continue;++count;auto image=(__bridge id<MTLTexture>)a.texture;
  if(!readable(image)||image.device!=device||!a.width||!a.height||uint64_t(a.x)+a.width>image.width||uint64_t(a.y)+a.height>image.height||a.channel>=components(image.pixelFormat)||a.origin>RS_SCENE_AOV_BOTTOM_LEFT||a.pass>RS_SCENE_AOV_TEMPORAL_INPUT||a.reserved||!std::isfinite(a.scale)||!std::isfinite(a.bias))return false;
  const bool scalar=slot==RS_SCENE_AOV_ROUGHNESS||slot==RS_SCENE_AOV_METALLIC||slot==RS_SCENE_AOV_SPECULAR_HIT_DISTANCE||slot==RS_SCENE_AOV_DENOISE_MASK;
  if(!scalar&&components(image.pixelFormat)<3)return false;
  if(slot==RS_SCENE_AOV_TRANSPARENCY&&components(image.pixelFormat)<4)return false;
  if(slot==RS_SCENE_AOV_NORMAL){if((a.encoding!=RS_SCENE_AOV_XYZ_SIGNED&&a.encoding!=RS_SCENE_AOV_XYZ_UNORM)||(a.space!=RS_SCENE_AOV_SPACE_VIEW&&a.space!=RS_SCENE_AOV_SPACE_WORLD))return false;}
  else if(a.space!=RS_SCENE_AOV_SPACE_NONE)return false;
  else if(slot==RS_SCENE_AOV_ROUGHNESS){if(a.encoding!=RS_SCENE_AOV_SCALAR&&a.encoding!=RS_SCENE_AOV_ROUGHNESS_FOLDED)return false;}
  else if(slot==RS_SCENE_AOV_SPECULAR_HIT_DISTANCE||slot==RS_SCENE_AOV_DENOISE_MASK||slot==RS_SCENE_AOV_METALLIC){if(a.encoding!=RS_SCENE_AOV_SCALAR)return false;}
  else if(slot==RS_SCENE_AOV_UI_COLOR_ALPHA||slot==RS_SCENE_AOV_HUDLESS_COLOR){if(a.encoding!=RS_SCENE_AOV_COLOR)return false;}
  else if(a.encoding!=RS_SCENE_AOV_LINEAR&&a.encoding!=RS_SCENE_AOV_COLOR)return false;
 }
 return true;
}
dispatch_queue_t retirementQueue(){static dispatch_queue_t queue=dispatch_queue_create("org.maclauncher.scene-aov.retirement",DISPATCH_QUEUE_SERIAL);return queue;}
std::shared_ptr<SceneAovLease>capture(const RSSceneAovs&v,id<MTLDevice>device){auto result=std::shared_ptr<SceneAovLease>(new SceneAovLease,[](SceneAovLease*value){dispatch_async(retirementQueue(),^{delete value;});});result->value=v;result->validatedDevice=device;for(unsigned i=0;i<RS_SCENE_AOV_COUNT;++i)result->textures[i]=(__bridge id<MTLTexture>)v.images[i].texture;return result;}
bool hudPair(const SceneAovLease&v){return v.value.images[RS_SCENE_AOV_HUDLESS_COLOR].texture||v.value.images[RS_SCENE_AOV_UI_COLOR_ALPHA].texture;}
void associate(SceneAovLease&v,const RSTemporalFrame&f){if(!hudPair(v))return;v.composedColor=(__bridge id<MTLTexture>)f.color;v.composedX=f.colorX;v.composedY=f.colorY;v.composedWidth=f.renderWidth;v.composedHeight=f.renderHeight;v.composedRegionKnown=true;}
std::shared_ptr<const SceneAovLease>imageAssociation(const RSTemporalFrame&f,const std::shared_ptr<const SceneAovLease>&source){
 if(!source||!hudPair(*source))return source;
 const bool exact=source->composedColor==(__bridge id<MTLTexture>)f.color&&(!source->composedRegionKnown||(source->composedX==f.colorX&&source->composedY==f.colorY&&source->composedWidth==f.renderWidth&&source->composedHeight==f.renderHeight));
 if(exact&&source->composedRegionKnown)return source;
 auto result=capture(source->value,source->validatedDevice);result->upstream=source;
 if(exact)associate(*result,f);
 else {for(unsigned slot:{RS_SCENE_AOV_HUDLESS_COLOR,RS_SCENE_AOV_UI_COLOR_ALPHA}){result->value.images[slot]={};result->textures[slot]=nil;}result->value.hudlessColor={};result->value.uiColor={};}
 return result;
}
bool sameLease(const std::shared_ptr<const SceneAovLease>&a,const std::shared_ptr<const SceneAovLease>&b){if(a==b)return true;auto x=a,y=b;while(x&&x->upstream)x=x->upstream;while(y&&y->upstream)y=y->upstream;return x==y&&!std::memcmp(&a->value,&b->value,sizeof(a->value));}
struct Bound {RSTemporalFrame frame{};__weak id<MTLCommandBuffer>commands;id<MTLTexture>color,depth,motion;std::shared_ptr<const SceneAovLease>lease;};
std::mutex boundLock;std::unordered_map<void*,std::deque<std::shared_ptr<Bound>>>bound;
bool same(const Bound&b,const RSTemporalFrame&f){const auto&v=b.frame;return b.commands==(__bridge id<MTLCommandBuffer>)f.commandBuffer&&v.owner==f.owner&&v.frameId==f.frameId&&v.color==f.color&&v.depth==f.depth&&v.motion==f.motion&&v.renderWidth==f.renderWidth&&v.renderHeight==f.renderHeight&&v.colorX==f.colorX&&v.colorY==f.colorY&&v.depthX==f.depthX&&v.depthY==f.depthY&&v.motionX==f.motionX&&v.motionY==f.motionY;}
void prune(){for(auto i=bound.begin();i!=bound.end();){auto&frames=i->second;frames.erase(std::remove_if(frames.begin(),frames.end(),[](const auto&r){return !r->commands;}),frames.end());if(frames.empty())i=bound.erase(i);else++i;}}
int bindExact(const RSTemporalFrame&f,const std::shared_ptr<const SceneAovLease>&lease){
 if(f.size<sizeof(f)||f.version!=1||!f.owner||!f.commandBuffer||f.commandBufferKind||!lease||lease->value.frameId!=f.frameId)return RS_TEMPORAL_INVALID;
 auto commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;auto c=(__bridge id<MTLTexture>)f.color,d=(__bridge id<MTLTexture>)f.depth,m=(__bridge id<MTLTexture>)f.motion;
 if(!tuple(c,d,m)||commands.device!=c.device||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences||lease->validatedDevice!=c.device)return RS_TEMPORAL_INVALID;
 auto record=std::make_shared<Bound>();record->frame=f;record->commands=commands;record->color=c;record->depth=d;record->motion=m;record->lease=lease;
 {std::lock_guard guard(boundLock);prune();if(!bound.count(f.owner)&&bound.size()>=maximumOwners)return RS_TEMPORAL_BUSY;auto&frames=bound[f.owner];for(const auto&r:frames)if(same(*r,f))return sameLease(r->lease,lease)?RS_TEMPORAL_OK:RS_TEMPORAL_BUSY;if(frames.size()>=maximumFrames)return RS_TEMPORAL_BUSY;frames.push_back(record);}
 const std::weak_ptr<Bound>weak=record;void*owner=f.owner;[commands addCompletedHandler:^(id<MTLCommandBuffer>){if(auto record=weak.lock()){std::lock_guard guard(boundLock);auto i=bound.find(owner);if(i!=bound.end()){auto&frames=i->second;frames.erase(std::remove(frames.begin(),frames.end(),record),frames.end());if(frames.empty())bound.erase(i);}}}];return RS_TEMPORAL_OK;
}
struct Pending {void*owner=nullptr;__weak id<MTLTexture>color,depth,motion;bool hasDepth=false,hasMotion=false,blocked=false;std::shared_ptr<const SceneAovLease>lease;};
std::mutex pendingLock;std::array<Pending,maximumPending>pending;std::atomic<unsigned>pendingCount{0};
void recount(){unsigned n=0;for(const auto&r:pending)n+=r.lease&&!r.blocked;pendingCount.store(n,std::memory_order_release);}
}
extern "C" uint32_t rsSceneAovAPI(void){return 1;}
// A plan states its own attachment demand, including a denoised temporal row's
// operation inputs; the legacy temporal selection applies only without one.
extern "C" uint32_t rsGetSceneAovDemand(uint32_t version){if(version!=1)return 0;if(macfx::effectPlanRequested())return macfx::effectPlanSceneAovDemand();return macfx::temporalControls().method==RS_TEMPORAL_METALFX_DENOISED?macfx::metalFxDenoisedAovDemand():0u;}
extern "C" int rsBindTemporalSceneAovs(const RSTemporalFrame*f,const RSSceneAovs*v){try{if(!f||f->size<sizeof(*f)||!v||v->size!=sizeof(*v)||v->version!=1||!f->color)return RS_TEMPORAL_INVALID;auto image=(__bridge id<MTLTexture>)f->color;const auto value=sanitizeHud(*v,image.device);if(!valid(value,image.device))return RS_TEMPORAL_INVALID;auto lease=capture(value,image.device);associate(*lease,*f);return bindExact(*f,lease);}catch(...){return RS_TEMPORAL_INVALID;}}
extern "C" void rsClearTemporalAovsTextures(void*owner){if(!owner)return;std::lock_guard guard(pendingLock);for(auto&r:pending)if(r.owner==owner)r={};recount();}
extern "C" void rsReleaseTemporalSceneAovs(void*owner){rsClearTemporalAovsTextures(owner);std::lock_guard guard(boundLock);bound.erase(owner);}
extern "C" int rsSetTemporalAovsForTextures(void*owner,void*color,void*depth,void*motion,const RSSceneAovs*v){return rsSetTemporalAovsForTexturesObserved(owner,color,depth,motion,v,nullptr);}
extern "C" int rsSetTemporalAovsForTexturesObserved(void*owner,void*color,void*depth,void*motion,const RSSceneAovs*v,const RSSceneAovRetirement*observer){try{
 if(observer&&(observer->size!=sizeof(*observer)||observer->version!=1||!observer->retired))return RS_TEMPORAL_INVALID;
 if(!owner)return RS_TEMPORAL_INVALID;if(!v){rsClearTemporalAovsTextures(owner);return RS_TEMPORAL_OK;}if(v->size!=sizeof(*v)||v->version!=1)return RS_TEMPORAL_INVALID;auto c=(__bridge id<MTLTexture>)color,d=(__bridge id<MTLTexture>)depth,m=(__bridge id<MTLTexture>)motion;
 if(!tuple(c,d,m)){rsClearTemporalAovsTextures(owner);return RS_TEMPORAL_INVALID;}const auto value=sanitizeHud(*v,c.device);if(!valid(value,c.device)){rsClearTemporalAovsTextures(owner);return RS_TEMPORAL_INVALID;}auto lease=capture(value,c.device);std::lock_guard guard(pendingLock);Pending*free=nullptr;
 for(auto&r:pending){if(r.owner&&(!r.color||r.hasDepth&&!r.depth||r.hasMotion&&!r.motion))r={};if(!r.owner){if(!free)free=&r;continue;}if(r.color==c&&r.depth==d&&r.motion==m){r.blocked=true;recount();return RS_TEMPORAL_BUSY;}}
 if(!free)return RS_TEMPORAL_BUSY;if(observer)lease->retirement=*observer;if(hudPair(*lease))lease->composedColor=c;free->owner=owner;free->color=c;free->depth=d;free->motion=m;free->hasDepth=bool(d);free->hasMotion=bool(m);free->lease=std::move(lease);recount();return RS_TEMPORAL_OK;
 }catch(...){return RS_TEMPORAL_INVALID;}}
namespace macfx {
std::optional<RSSceneAovs>validatedSceneAovs(const RSSceneAovs&input,id<MTLDevice>device){if(input.size!=sizeof(input)||input.version!=1)return {};const auto value=sanitizeHud(input,device);return valid(value,device)?std::optional<RSSceneAovs>(value):std::nullopt;}
std::shared_ptr<SceneAovLease>captureSceneAovs(const RSSceneAovs&input,id<MTLDevice>device){const auto value=validatedSceneAovs(input,device);return value?capture(*value,device):nullptr;}
SceneAovLease::~SceneAovLease(){if(retirement.retired){const auto observer=retirement;const auto frame=value.frameId,view=value.viewId,epoch=value.epoch;dispatch_async(retirementQueue(),^{observer.retired(observer.context,frame,view,epoch);});}}
std::shared_ptr<const SceneAovLease>temporalSceneAovs(const RSTemporalFrame&f){std::lock_guard guard(boundLock);auto i=bound.find(f.owner);if(i!=bound.end())for(const auto&r:i->second)if(same(*r,f))return r->lease;return {};}
int bindSceneAovLease(const RSTemporalFrame&f,const std::shared_ptr<const SceneAovLease>&lease){try{return lease?bindExact(f,imageAssociation(f,lease)):RS_TEMPORAL_UNAVAILABLE;}catch(...){return RS_TEMPORAL_INVALID;}}
std::shared_ptr<const SceneAovLease>copiedSceneAovLease(const std::shared_ptr<const SceneAovLease>&lease,id<MTLTexture>source,id<MTLTexture>target){
 if(!lease||!hudPair(*lease)||!source||!target||lease->composedColor!=source||!lease->composedRegionKnown||lease->composedX||lease->composedY||lease->composedWidth!=source.width||lease->composedHeight!=source.height||source.device!=target.device||source.width!=target.width||source.height!=target.height||source.pixelFormat!=target.pixelFormat)return lease;
 auto result=capture(lease->value,lease->validatedDevice);result->upstream=lease;result->composedColor=target;result->composedWidth=target.width;result->composedHeight=target.height;result->composedRegionKnown=true;return result;
}
int takeTemporalAovsForTextures(const RSTemporalFrame&f,std::shared_ptr<const SceneAovLease>&lease){
 if(!pendingCount.load(std::memory_order_acquire))return RS_TEMPORAL_UNAVAILABLE;
 {std::lock_guard guard(pendingLock);for(auto&r:pending){if(!r.owner)continue;if(!r.color||r.hasDepth&&!r.depth||r.hasMotion&&!r.motion){r={};continue;}if(r.color==(__bridge id<MTLTexture>)f.color&&r.depth==(__bridge id<MTLTexture>)f.depth&&r.motion==(__bridge id<MTLTexture>)f.motion){if(r.blocked||lease){recount();return RS_TEMPORAL_BUSY;}lease=r.lease;r={};}}recount();}
 return lease?RS_TEMPORAL_OK:RS_TEMPORAL_UNAVAILABLE;
}
int peekTemporalAovsForTextures(const RSTemporalFrame&f,std::shared_ptr<const SceneAovLease>&lease,void*&owner){
 lease.reset();owner=nullptr;if(!pendingCount.load(std::memory_order_acquire))return RS_TEMPORAL_UNAVAILABLE;
 auto commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;auto color=(__bridge id<MTLTexture>)f.color;
 if(f.size<sizeof(f)||f.version!=1||f.commandBufferKind||!commands||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences||!color||color.device!=commands.device)return RS_TEMPORAL_INVALID;
 std::lock_guard guard(pendingLock);for(const auto&r:pending){if(!r.owner||!r.lease||!r.color||r.hasDepth&&!r.depth||r.hasMotion&&!r.motion)continue;
  if(r.color==color&&r.depth==(__bridge id<MTLTexture>)f.depth&&r.motion==(__bridge id<MTLTexture>)f.motion){if(r.blocked||lease){lease.reset();owner=nullptr;return RS_TEMPORAL_BUSY;}lease=r.lease;owner=r.owner;}}
 return lease?RS_TEMPORAL_OK:RS_TEMPORAL_UNAVAILABLE;
}
int bindTemporalAovsForTextures(const RSTemporalFrame&f){std::shared_ptr<const SceneAovLease>lease;const auto status=takeTemporalAovsForTextures(f,lease);return status==RS_TEMPORAL_OK?bindSceneAovLease(f,lease):status;}
}
