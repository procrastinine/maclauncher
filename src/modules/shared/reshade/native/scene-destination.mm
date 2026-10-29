// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-destination.hpp"
#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#import <objc/runtime.h>
#include <array>
#include <atomic>
#include <mutex>
#include <unordered_map>
#include "scene-matrices.hpp"
@interface RSMSceneWindowAuthority : NSObject { @public std::shared_ptr<const macfx::SceneWindowAuthority>value; }
@end
@implementation RSMSceneWindowAuthority
@end
namespace {
const char windowKey=0;std::atomic<uint64_t>windowSequence{0};
class WindowAuthority final:public macfx::SceneWindowAuthority{
 __weak NSWindow*window;uint64_t token;uint32_t number;
public:explicit WindowAuthority(NSWindow*w):window(w),token(++windowSequence),number(uint32_t(w.windowNumber)){}
 uint64_t identity()const noexcept override{return token;}
 uint32_t windowNumber()const noexcept override{return number;}
 bool alive()const noexcept override{return window!=nil;}
};
struct Pending{void*owner=nullptr;std::shared_ptr<const macfx::SceneWindowAuthority>window;uint64_t frameId=0;uint32_t flags=0;__weak id<MTLTexture>color,depth,motion;bool pending=false,blocked=false,hasDepth=false,hasMotion=false;};
std::array<Pending,64>pending;
std::mutex mutex;std::atomic<unsigned>count{0};
void recount(){unsigned value=0;for(const auto&record:pending)value+=record.pending;count.store(value,std::memory_order_release);}
class Continuation final:public macfx::TemporalSceneContinuation{
public:
 std::shared_ptr<const macfx::SceneWindowAuthority>window;void*destinationOwner=nullptr,*producerOwner=nullptr;uint64_t frame=0;uint32_t inputMask=0;bool mapped=false;
 std::shared_ptr<macfx::EffectExecution>effect;std::shared_ptr<const macfx::EffectSceneLease>lease;__weak id<MTLCommandBuffer>producer;id<MTLSharedEvent>event;uint64_t eventValue=1;id<MTLDevice>device;std::atomic<bool>failed{false};
 mutable std::mutex claimMutex;__weak id<MTLCommandBuffer>consumer;__weak id<MTLTexture>image;bool claimed=false;
 std::shared_ptr<macfx::EffectExecution>execution()const override{return effect;}
 std::shared_ptr<const macfx::EffectSceneLease>scene()const override{return lease;}
 uint64_t frameId()const noexcept override{return frame;}
 uint32_t inputs()const noexcept override{return inputMask;}
 bool displayMapped()const noexcept override{return mapped;}
 macfx::ShaderResult ready(id<MTLCommandBuffer>commands)const override{
  if(!window||!window->alive()||failed.load())return {false,"The renderer scene producer was retired"};auto source=producer;
  if(!commands||commands.status>=MTLCommandBufferStatusCommitted||commands.device!=device)return {false,"Scene continuation requires retaining commands on the producer GPU"};
  if(source==commands)return {true,{}};
  if(!source&&event.signaledValue<eventValue)return {false,"The renderer scene commands were abandoned"};
  if(source&&source.status<MTLCommandBufferStatusCommitted)return {false,"Waiting for the renderer scene command submission",true};
  if(source&&source.status==MTLCommandBufferStatusError)return {false,"The renderer scene command buffer failed"};
  {std::lock_guard lock(claimMutex);if(claimed&&(consumer!=commands||image==nil))return {false,"This final image needs a new matching renderer scene",true};}
  [commands encodeWaitForEvent:event value:eventValue];return {true,{}};
 }
 macfx::ShaderResult completion()const override{auto source=producer;if(failed.load()||source&&source.status==MTLCommandBufferStatusError)return {false,"The renderer scene producer failed"};if(event.signaledValue<eventValue||source&&source.status!=MTLCommandBufferStatusCompleted)return {false,"The renderer scene producer has not completed",true};return {true,{}};}
 bool claim(id<MTLCommandBuffer>commands,id<MTLTexture>texture)override{std::lock_guard lock(claimMutex);if(claimed)return consumer==commands&&image==texture;consumer=commands;image=texture;claimed=true;return true;}
};
std::mutex continuationMutex;std::unordered_map<uint64_t,std::shared_ptr<Continuation>>continuations;
bool textures(id<MTLTexture>c,id<MTLTexture>d,id<MTLTexture>m){return c&&c.textureType==MTLTextureType2D&&(!d||(c.device==d.device&&d.textureType==MTLTextureType2D))&&(!m||(c.device==m.device&&m.textureType==MTLTextureType2D));}
}
extern "C" void rsClearTemporalSceneDestinationTextures(void*owner){if(!owner)return;std::lock_guard lock(mutex);for(auto&record:pending)if(record.owner==owner)record={};recount();}
extern "C" int rsSetTemporalSceneDestinationFlagsForTextures(void*owner,void*nativeWindow,void*color,void*depth,void*motion,uint64_t frameId,uint32_t flags){
 if(!owner||flags&~uint32_t(RS_TEMPORAL_HDR))return RS_TEMPORAL_INVALID;if(!nativeWindow){rsClearTemporalSceneDestinationTextures(owner);return RS_TEMPORAL_OK;}
 NSWindow*window=(__bridge NSWindow*)nativeWindow;auto c=(__bridge id<MTLTexture>)color,d=(__bridge id<MTLTexture>)depth,m=(__bridge id<MTLTexture>)motion;
 if(![window isKindOfClass:NSWindow.class]||window.windowNumber<=0||!frameId||!textures(c,d,m)){rsClearTemporalSceneDestinationTextures(owner);return RS_TEMPORAL_INVALID;}
 const auto authority=macfx::temporalSceneWindow(nativeWindow);if(!authority)return RS_TEMPORAL_INVALID;std::lock_guard lock(mutex);Pending*available=nullptr;
 for(auto&record:pending){if(record.owner&&(!record.window||!record.window->alive()||!record.color||record.hasDepth&&!record.depth||record.hasMotion&&!record.motion))record={};if(!record.owner){if(!available)available=&record;continue;}if(record.window->identity()==authority->identity()||record.color==c&&record.depth==d&&record.motion==m){record.pending=false;record.blocked=true;recount();return RS_TEMPORAL_BUSY;}}
 if(!available)return RS_TEMPORAL_BUSY;available->owner=owner;available->window=authority;available->frameId=frameId;available->flags=flags;available->color=c;available->depth=d;available->motion=m;available->hasDepth=d!=nil;available->hasMotion=m!=nil;available->pending=true;recount();return RS_TEMPORAL_OK;
}
namespace macfx {
void publishTemporalSceneContinuation(id<MTLCommandBuffer>commands,const TemporalSceneDestination&destination,const RSTemporalFrame&frame,std::shared_ptr<EffectExecution>execution,bool displayMapped){
 auto lease=execution?execution->captureSceneLease(commands):nullptr;publishRetainedTemporalSceneContinuation(commands,destination,frame,std::move(execution),std::move(lease),displayMapped);
}
void publishRetainedTemporalSceneContinuation(id<MTLCommandBuffer>commands,const TemporalSceneDestination&destination,const RSTemporalFrame&frame,std::shared_ptr<EffectExecution>execution,std::shared_ptr<const EffectSceneLease>lease,bool displayMapped,id<MTLSharedEvent>readyEvent,uint64_t readyValue){
 if(!commands||!destination.window||!destination.window->alive()||!execution||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences)return;
 auto value=std::shared_ptr<Continuation>(new Continuation,[](Continuation*pointer){dispatch_async_f(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),pointer,[](void*value){delete static_cast<Continuation*>(value);});});
 value->mapped=displayMapped;value->window=destination.window;value->destinationOwner=destination.owner;value->producerOwner=frame.owner;value->frame=frame.frameId;value->inputMask=temporalSceneInputMask(frame);value->effect=std::move(execution);value->lease=std::move(lease);if(!value->lease)return;value->producer=commands;value->device=commands.device;value->event=readyEvent?:[commands.device newSharedEvent];value->eventValue=readyEvent?readyValue:1;if(!value->event||!value->eventValue)return;
 if(!readyEvent)[commands encodeSignalEvent:value->event value:value->eventValue];std::weak_ptr<Continuation>weak=value;[commands addCompletedHandler:^(id<MTLCommandBuffer>completed){if(completed.status!=MTLCommandBufferStatusCompleted)if(auto held=weak.lock()){held->failed.store(true);if(held->event.signaledValue<held->eventValue)held->event.signaledValue=held->eventValue;}}];
 std::lock_guard lock(continuationMutex);for(auto it=continuations.begin();it!=continuations.end();)if(!it->second->window->alive())it=continuations.erase(it);else ++it;const auto key=destination.window->identity();if(continuations.size()>=64&&!continuations.count(key))return;
 // Registration already rejected simultaneous ambiguous producers. A new
 // unambiguous camera may replace an earlier frame for this exact window.
 continuations[key]=std::move(value);
}
std::shared_ptr<TemporalSceneContinuation>temporalSceneContinuation(const std::shared_ptr<const SceneWindowAuthority>&window){if(!window||!window->alive())return {};std::lock_guard lock(continuationMutex);const auto it=continuations.find(window->identity());return it==continuations.end()?nullptr:it->second;}
void releaseTemporalSceneContinuations(void*owner){if(!owner)return;std::lock_guard lock(continuationMutex);for(auto it=continuations.begin();it!=continuations.end();)if(it->second->producerOwner==owner||it->second->destinationOwner==owner)it=continuations.erase(it);else ++it;}
std::shared_ptr<const SceneWindowAuthority>temporalSceneWindow(void*nativeWindow){NSWindow*window=(__bridge NSWindow*)nativeWindow;if(!window||![window isKindOfClass:NSWindow.class]||window.windowNumber<=0)return {};auto holder=(RSMSceneWindowAuthority*)objc_getAssociatedObject(window,&windowKey);if(holder)return holder->value;@synchronized(window){holder=(RSMSceneWindowAuthority*)objc_getAssociatedObject(window,&windowKey);if(!holder){holder=[RSMSceneWindowAuthority new];holder->value=std::make_shared<WindowAuthority>(window);objc_setAssociatedObject(window,&windowKey,holder,OBJC_ASSOCIATION_RETAIN_NONATOMIC);}return holder->value;}}
std::optional<TemporalSceneDestination>takeTemporalSceneDestination(const RSTemporalFrame&frame){
 if(!count.load(std::memory_order_acquire))return {};std::lock_guard lock(mutex);std::optional<TemporalSceneDestination>result;
 for(auto&record:pending){if(!record.pending)continue;if(!record.window||!record.window->alive()||!record.color||record.hasDepth&&!record.depth||record.hasMotion&&!record.motion){record={};continue;}if(record.color==(__bridge id<MTLTexture>)frame.color&&record.depth==(__bridge id<MTLTexture>)frame.depth&&record.motion==(__bridge id<MTLTexture>)frame.motion){if((!frame.frameId||record.frameId==frame.frameId)&&!result)result=TemporalSceneDestination{record.window,record.owner,record.frameId,record.flags};else result.reset();record={};}}
 recount();return result;
}
}
extern "C" uint32_t rsSceneWindowContinuationABI(void){return 1;}

extern "C" int rsSetTemporalSceneDestinationForTextures(void*owner,void*window,void*color,void*depth,void*motion,uint64_t frameId){return rsSetTemporalSceneDestinationFlagsForTextures(owner,window,color,depth,motion,frameId,0);}
