// Copyright (c) MacLauncher contributors. MIT license.
#include "metalfx-generation-resources.hpp"
#include "scene-aovs.hpp"
#import <MetalFX/MetalFX.h>
#import <objc/runtime.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <deque>
#include <mutex>
@interface RSMMetalFxGenerationAccess : NSObject { @public std::shared_ptr<void> value; } @end
@implementation RSMMetalFxGenerationAccess @end
@interface RSMMetalFxClassicObservation : NSObject { @public std::atomic<bool> hadField; } @end
@implementation RSMMetalFxClassicObservation
- (instancetype)init {self=[super init];if(self)std::atomic_init(&hadField,false);return self;}
@end
namespace macfx {
namespace {
struct Access {std::mutex mutex;bool writing=false;unsigned readers=0;uint64_t generation=0,identity=0;__weak id sdk=nil;};
std::mutex accessMutex;
std::shared_ptr<Access>access(id sdk){static char key;static std::atomic<uint64_t>sequence{1};std::lock_guard lock(accessMutex);RSMMetalFxGenerationAccess*box=objc_getAssociatedObject(sdk,&key);if(!box){box=[RSMMetalFxGenerationAccess new];auto result=std::make_shared<Access>();result->sdk=sdk;result->identity=sequence.fetch_add(1);box->value=result;objc_setAssociatedObject(sdk,&key,box,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}return std::static_pointer_cast<Access>(box->value);}
bool image(id<MTLTexture>v,id<MTLDevice>d){return v&&v.device==d&&v.textureType==MTLTextureType2D&&v.sampleCount==1&&!v.framebufferOnly&&v.storageMode!=MTLStorageModeMemoryless;}
bool region(id<MTLTexture>v,unsigned x,unsigned y,unsigned w,unsigned h){return v&&w&&h&&x<=v.width&&y<=v.height&&w<=v.width-x&&h<=v.height-y;}
bool validFrame(const RSTemporalFrame&f){if(f.size<sizeof(f)||f.version!=1||!f.owner||!f.frameId||f.commandBufferKind||!f.commandBuffer)return false;auto commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;return commands.retainedReferences&&commands.status<MTLCommandBufferStatusCommitted&&commands.device;}
struct Bound {
 void*owner=nullptr;uint64_t frame=0;
 __weak id<MTLCommandBuffer>commands=nil;
 id<MTLTexture>color=nil;unsigned x=0,y=0,width=0,height=0;
 std::shared_ptr<const MetalFxGenerationResources>value;
};
std::mutex bindingsMutex;std::deque<Bound>bindings;
dispatch_queue_t retirementQueue(){static auto queue=dispatch_queue_create("org.maclauncher.metalfx.generation-resources.retire",DISPATCH_QUEUE_SERIAL);return queue;}
template<class T>std::shared_ptr<T>retired(){return {new T,[](T*value){dispatch_async(retirementQueue(),^{delete value;});}};}
struct ClassicHook {Class cls=nullptr;IMP original=nullptr;};
std::array<ClassicHook,32>classicHooks{};std::atomic<unsigned>classicHookCount{0};std::mutex classicHookMutex;char classicObservation;
IMP classicOriginal(id sdk){for(Class cls=object_getClass(sdk);cls;cls=class_getSuperclass(cls))for(unsigned i=0,n=classicHookCount.load(std::memory_order_acquire);i<n;++i)if(classicHooks[i].cls==cls)return classicHooks[i].original;return nullptr;}
void classicEncode(id sdk,SEL selector,id commands){
 const auto original=classicOriginal(sdk);if(!original)return;
 // Preserve every native call, including when metadata is absent, stale or
 // not a real frame. Optional inspection never gates an application's SDK.
 reinterpret_cast<void(*)(id,SEL,id)>(original)(sdk,selector,commands);
 RSMMetalFxClassicObservation*observation=objc_getAssociatedObject(sdk,&classicObservation);if(!observation)return;
 if(@available(macOS 27.0,*)){@autoreleasepool{@try{try{
  for(SEL property:{@selector(colorTexture),@selector(depthTexture),@selector(motionTexture),@selector(distortionTexture)})if(![sdk respondsToSelector:property])return;
  if(![commands respondsToSelector:@selector(status)]||![commands respondsToSelector:@selector(retainedReferences)])return;
  id<MTLFXFrameInterpolatorBase>source=sdk;const bool field=source.distortionTexture!=nil;if(!observation->hadField.exchange(field)&&!field)return;
  RSTemporalFrame frame{};frame.size=sizeof(frame);frame.version=1;frame.commandBuffer=(__bridge void*)commands;frame.color=(__bridge void*)source.colorTexture;frame.depth=(__bridge void*)source.depthTexture;frame.motion=(__bridge void*)source.motionTexture;
  auto color=source.colorTexture;if(!color||color.width>UINT32_MAX||color.height>UINT32_MAX)return;frame.renderWidth=frame.outputWidth=uint32_t(color.width);frame.renderHeight=frame.outputHeight=uint32_t(color.height);
  std::shared_ptr<const SceneAovLease>metadata;void*owner=nullptr;
  if(peekTemporalAovsForTextures(frame,metadata,owner)!=RS_TEMPORAL_OK||!metadata||!owner)return;
  frame.owner=owner;frame.frameId=metadata->value.frameId;
  captureMetalFxGenerationDistortion(frame,sdk,metadata);
 }catch(...){} }@catch(NSException*){}}}
}
void prune(){bindings.erase(std::remove_if(bindings.begin(),bindings.end(),[](const auto&r){auto c=r.commands;return !c||c.status>=MTLCommandBufferStatusCompleted;}),bindings.end());}
bool same(const Bound&b,const RSTemporalFrame&f){return b.owner==f.owner&&b.frame==f.frameId&&b.commands==(__bridge id<MTLCommandBuffer>)f.commandBuffer&&b.color==(__bridge id<MTLTexture>)f.color&&b.x==f.colorX&&b.y==f.colorY&&b.width==f.renderWidth&&b.height==f.renderHeight;}
void clear(const RSTemporalFrame&f){std::lock_guard lock(bindingsMutex);bindings.erase(std::remove_if(bindings.begin(),bindings.end(),[&](const auto&r){return same(r,f);}),bindings.end());}
bool store(const RSTemporalFrame&f,id<MTLTexture>color,unsigned x,unsigned y,unsigned w,unsigned h,const std::shared_ptr<const MetalFxGenerationResources>&v){
 if(!validFrame(f)||!region(color,x,y,w,h))return false;
 Bound record;record.owner=f.owner;record.frame=f.frameId;record.commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;record.color=color;record.x=x;record.y=y;record.width=w;record.height=h;record.value=v;
 std::lock_guard lock(bindingsMutex);prune();for(auto&r:bindings)if(r.owner==record.owner&&r.frame==record.frame&&r.commands==record.commands&&r.color==color&&r.x==x&&r.y==y&&r.width==w&&r.height==h){r=std::move(record);return true;}if(bindings.size()>=128)return false;bindings.push_back(std::move(record));return true;
}
void clearDistortion(const RSTemporalFrame&f){auto previous=metalFxGenerationResources(f);if(!previous||!previous->distortion.texture)return;auto next=retired<MetalFxGenerationResources>();*next=*previous;next->distortion={};next->distortionResources.reset();store(f,(__bridge id<MTLTexture>)f.color,f.colorX,f.colorY,f.renderWidth,f.renderHeight,next);}
}
struct MetalFxScalerFrame::Control {
 std::shared_ptr<Access>access;
 __weak id scaler=nil;
 __weak id<MTLCommandBuffer>commands=nil;
 uint64_t generation=0;
};
struct MetalFxScalerClaim::Impl {std::shared_ptr<MetalFxScalerFrame::Control>control;std::atomic<bool>retired{false};void retire()noexcept{if(!retired.exchange(true)){std::lock_guard lock(control->access->mutex);--control->access->readers;}}~Impl(){retire();}};
MetalFxScalerClaim::MetalFxScalerClaim(std::shared_ptr<Impl>v):impl(std::move(v)){}
MetalFxScalerClaim::~MetalFxScalerClaim()=default;
id MetalFxScalerClaim::scaler()const{return impl&&!impl->retired.load()?impl->control->scaler:nil;}
void MetalFxScalerClaim::retire()noexcept{if(impl)impl->retire();}
std::shared_ptr<MetalFxScalerClaim>MetalFxScalerFrame::claim(const RSTemporalFrame&current)const{
 if(!control||!validFrame(current)||current.frameId!=frame.frameId||control->commands!=(__bridge id<MTLCommandBuffer>)current.commandBuffer)return {};
 std::unique_lock lock(control->access->mutex,std::try_to_lock);if(!lock||control->access->writing||control->access->generation!=control->generation||!control->scaler)return {};
 auto state=std::make_shared<MetalFxScalerClaim::Impl>();state->control=control;++control->access->readers;lock.unlock();return std::shared_ptr<MetalFxScalerClaim>(new MetalFxScalerClaim(std::move(state)));
}
std::shared_ptr<MetalFxScalerClaim>MetalFxScalerFrame::claimForPreparation()const{
 if(!control)return {};std::unique_lock lock(control->access->mutex,std::try_to_lock);if(!lock||control->access->writing||!control->scaler)return {};
 auto state=std::make_shared<MetalFxScalerClaim::Impl>();state->control=control;++control->access->readers;lock.unlock();return std::shared_ptr<MetalFxScalerClaim>(new MetalFxScalerClaim(std::move(state)));
}
struct MetalFxScalerMutation::Impl {id scaler=nil;std::shared_ptr<Access>access;uint64_t generation=0;bool active=false;~Impl(){if(active){std::lock_guard lock(access->mutex);access->writing=false;}}};
MetalFxScalerMutation::MetalFxScalerMutation(id sdk):impl(std::make_unique<Impl>()){
 if(!sdk)return;impl->access=access(sdk);std::unique_lock lock(impl->access->mutex,std::try_to_lock);if(!lock||impl->access->writing||impl->access->readers)return;impl->access->writing=true;impl->generation=++impl->access->generation;impl->scaler=sdk;impl->active=true;
}
MetalFxScalerMutation::~MetalFxScalerMutation()=default;
MetalFxScalerMutation::operator bool()const noexcept{return impl&&impl->active;}
bool MetalFxScalerMutation::publish(const RSTemporalFrame&f,MetalFxScalerProfile profile,const ImageColorDescription&color,id<MTLTexture>published,std::shared_ptr<const void>resources){
 if(!*this||!validFrame(f)||!color.valid()||(profile!=MetalFxScalerProfile::Temporal&&profile!=MetalFxScalerProfile::Denoised))return false;
 auto commands=(__bridge id<MTLCommandBuffer>)f.commandBuffer;id sdk=impl->scaler;
 if(@available(macOS 26.0,*)){
  if(![sdk conformsToProtocol:@protocol(MTLFXFrameInterpolatableScaler)])return false;
  id<MTLFXTemporalScalerBase>value=sdk;
  auto c=(__bridge id<MTLTexture>)f.color,d=(__bridge id<MTLTexture>)f.depth,m=(__bridge id<MTLTexture>)f.motion,o=(__bridge id<MTLTexture>)f.output;
  if(value.colorTexture!=c||value.depthTexture!=d||value.motionTexture!=m||value.outputTexture!=o||!image(c,commands.device)||!image(d,commands.device)||!image(m,commands.device)||!image(o,commands.device)||!region(o,f.outputX,f.outputY,f.outputWidth,f.outputHeight))return false;
  if(!published)published=o;
  if(!image(published,commands.device)||published.pixelFormat!=o.pixelFormat||published.width!=o.width||published.height!=o.height)return false;
  auto snapshot=retired<MetalFxScalerFrame>();snapshot->frame=f;snapshot->resourceId=impl->access->identity;snapshot->profile=profile;snapshot->color=color;snapshot->publishedColor=published;snapshot->x=f.outputX;snapshot->y=f.outputY;snapshot->width=f.outputWidth;snapshot->height=f.outputHeight;snapshot->resources=std::move(resources);
  for(auto texture:{c,d,m,o,published,(__bridge id<MTLTexture>)f.exposure,(__bridge id<MTLTexture>)f.reactive,(__bridge id<MTLTexture>)f.transparency})if(texture&&std::find(snapshot->retained.begin(),snapshot->retained.end(),texture)==snapshot->retained.end())snapshot->retained.push_back(texture);
  snapshot->control=std::make_shared<MetalFxScalerFrame::Control>();snapshot->control->access=impl->access;snapshot->control->scaler=sdk;snapshot->control->commands=commands;snapshot->control->generation=impl->generation;
  auto association=f;association.color=(__bridge void*)published;association.colorX=f.outputX;association.colorY=f.outputY;association.renderWidth=f.outputWidth;association.renderHeight=f.outputHeight;
  auto previous=metalFxGenerationResources(association);auto result=retired<MetalFxGenerationResources>();if(previous)*result=*previous;result->scaler=std::move(snapshot);
  return store(f,published,f.outputX,f.outputY,f.outputWidth,f.outputHeight,result);
 }
 return false;
}
std::shared_ptr<const MetalFxGenerationResources>metalFxGenerationResources(const RSTemporalFrame&f){if(!validFrame(f))return {};std::lock_guard lock(bindingsMutex);prune();for(const auto&r:bindings)if(same(r,f))return r.value;return {};}
bool publishMetalFxGenerationDistortion(const RSTemporalFrame&f,const MetalFxDistortionField&field,std::shared_ptr<const void>resources){
 if(!validFrame(f))return false;const auto decline=[&](){clearDistortion(f);return false;};if(field.units!=MetalFxDistortionUnits::NativeMetalFX)return decline();auto c=(__bridge id<MTLCommandBuffer>)f.commandBuffer;
 if(!image(field.texture,c.device)||!region(field.texture,field.x,field.y,field.width,field.height)||
    (field.texture.pixelFormat!=MTLPixelFormatRG16Float&&field.texture.pixelFormat!=MTLPixelFormatRG32Float))return decline();
 if((field.fence&&field.fence.device!=c.device)||(field.texture.hazardTrackingMode==MTLHazardTrackingModeUntracked&&!field.fence))return decline();
 auto previous=metalFxGenerationResources(f);auto next=retired<MetalFxGenerationResources>();if(previous)*next=*previous;next->distortion=field;next->distortionResources=std::move(resources);return store(f,(__bridge id<MTLTexture>)f.color,f.colorX,f.colorY,f.renderWidth,f.renderHeight,next);
}
bool captureMetalFxGenerationDistortion(const RSTemporalFrame&f,id object,std::shared_ptr<const void>resources){
 if(!validFrame(f))return false;const auto decline=[&](){clearDistortion(f);return false;};if(!object)return decline();
 if(@available(macOS 27.0,*)){@try{
  for(SEL selector:{@selector(colorTexture),@selector(distortionTexture),@selector(distortionOffsetX),@selector(distortionOffsetY),@selector(distortionWidth),@selector(distortionHeight),@selector(contentWidth),@selector(contentHeight),@selector(fence)})if(![object respondsToSelector:selector])return decline();
  id<MTLFXFrameInterpolatorBase>sdk=object;if(sdk.colorTexture!=(__bridge id<MTLTexture>)f.color||!sdk.distortionTexture)return decline();
  const NSUInteger x=sdk.distortionOffsetX,y=sdk.distortionOffsetY,w=sdk.distortionWidth?:sdk.contentWidth,h=sdk.distortionHeight?:sdk.contentHeight;
  if(x>UINT32_MAX||y>UINT32_MAX||w>UINT32_MAX||h>UINT32_MAX)return decline();
  return publishMetalFxGenerationDistortion(f,{sdk.distortionTexture,uint32_t(x),uint32_t(y),uint32_t(w),uint32_t(h),MetalFxDistortionUnits::NativeMetalFX,sdk.fence},std::move(resources));
 }@catch(NSException*){return decline();}}
 return decline();
}
void observeMetalFxClassicInterpolator(id sdk){
 if(!sdk||objc_getAssociatedObject(sdk,&classicObservation))return;std::lock_guard lock(classicHookMutex);Class cls=object_getClass(sdk);const auto selector=@selector(encodeToCommandBuffer:);
 for(unsigned i=0,n=classicHookCount.load();i<n;++i)if(classicHooks[i].cls==cls){objc_setAssociatedObject(sdk,&classicObservation,[RSMMetalFxClassicObservation new],OBJC_ASSOCIATION_RETAIN_NONATOMIC);return;}
 const auto count=classicHookCount.load();if(count>=classicHooks.size())return;auto method=class_getInstanceMethod(cls,selector);if(!method)return;auto original=method_getImplementation(method);if(original==reinterpret_cast<IMP>(classicEncode))original=classicOriginal(sdk);if(!original)return;
 classicHooks[count]={cls,original};classicHookCount.store(count+1,std::memory_order_release);
 if(!class_addMethod(cls,selector,reinterpret_cast<IMP>(classicEncode),method_getTypeEncoding(method)))method_setImplementation(class_getInstanceMethod(cls,selector),reinterpret_cast<IMP>(classicEncode));
 objc_setAssociatedObject(sdk,&classicObservation,[RSMMetalFxClassicObservation new],OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
bool bindMetalFxGenerationResources(const RSTemporalFrame&target,const RSTemporalFrame&source,id<MTLTexture>copiedFrom){
 const auto decline=[&](){clear(target);return false;};
 if(!validFrame(target)||target.commandBuffer!=source.commandBuffer||target.frameId!=source.frameId)return decline();auto origin=source;auto value=metalFxGenerationResources(origin);
 if(!value&&source.output){origin.color=source.output;origin.colorX=source.outputX;origin.colorY=source.outputY;origin.renderWidth=source.outputWidth;origin.renderHeight=source.outputHeight;value=metalFxGenerationResources(origin);}if(!value)return decline();
 auto from=(__bridge id<MTLTexture>)origin.color,to=(__bridge id<MTLTexture>)target.color;
 const bool exact=from==to&&origin.colorX==target.colorX&&origin.colorY==target.colorY&&origin.renderWidth==target.renderWidth&&origin.renderHeight==target.renderHeight;
 const bool copy=copiedFrom==from&&!origin.colorX&&!origin.colorY&&!target.colorX&&!target.colorY&&origin.renderWidth==from.width&&origin.renderHeight==from.height&&target.renderWidth==to.width&&target.renderHeight==to.height&&from.width==to.width&&from.height==to.height&&from.pixelFormat==to.pixelFormat;
 if(!exact&&!copy)return decline();if(!store(target,to,target.colorX,target.colorY,target.renderWidth,target.renderHeight,value))return decline();return true;
}
}
