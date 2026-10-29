// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-matrices.hpp"
#include "runtime-status.hpp"
#import <Metal/Metal.h>
#include <array>
#include <atomic>
#include <algorithm>
#include <cmath>
#include <deque>
#include <memory>
#include <mutex>
#include <unordered_map>
namespace {
constexpr unsigned maximumOwners=128,maximumFrames=32;
bool matrix(const float *input){
 double value[4][4];for(unsigned y=0;y<4;++y)for(unsigned x=0;x<4;++x){if(!std::isfinite(input[y*4+x]))return false;value[y][x]=input[y*4+x];}
 for(unsigned column=0;column<4;++column){unsigned pivot=column;for(unsigned row=column+1;row<4;++row)if(std::abs(value[row][column])>std::abs(value[pivot][column]))pivot=row;if(value[pivot][column]==0)return false;if(pivot!=column)for(unsigned x=column;x<4;++x)std::swap(value[pivot][x],value[column][x]);for(unsigned row=column+1;row<4;++row){const double scale=value[row][column]/value[column][column];for(unsigned x=column+1;x<4;++x)value[row][x]-=value[column][x]*scale;}}
 return true;
}
bool valid(const RSSceneMatrices *value){
 if(!value||value->size!=sizeof(*value)||value->version!=RS_SCENE_MATRICES_ABI_VERSION||!value->frameId||value->reserved||!value->flags||value->flags&~uint32_t(RS_SCENE_VIEW_VALID|RS_SCENE_PROJECTION_VALID|RS_SCENE_CLIP_ZERO_TO_ONE|RS_SCENE_CLIP_MINUS_ONE_TO_ONE|RS_SCENE_PROJECTION_JITTERED|RS_SCENE_PROJECTION_Y_DOWN))return false;
 const auto clip=value->flags&uint32_t(RS_SCENE_CLIP_ZERO_TO_ONE|RS_SCENE_CLIP_MINUS_ONE_TO_ONE);
 const auto projectionFlags=value->flags&uint32_t(RS_SCENE_CLIP_ZERO_TO_ONE|RS_SCENE_CLIP_MINUS_ONE_TO_ONE|RS_SCENE_PROJECTION_JITTERED|RS_SCENE_PROJECTION_Y_DOWN);
 return clip!=uint32_t(RS_SCENE_CLIP_ZERO_TO_ONE|RS_SCENE_CLIP_MINUS_ONE_TO_ONE)&&(!projectionFlags||(value->flags&RS_SCENE_PROJECTION_VALID))&&(!(value->flags&RS_SCENE_VIEW_VALID)||matrix(value->view))&&(!(value->flags&RS_SCENE_PROJECTION_VALID)||matrix(value->projection));
}
bool textures(id<MTLTexture>color,id<MTLTexture>depth,id<MTLTexture>motion){return color&&color.textureType==MTLTextureType2D&&(!depth||(color.device==depth.device&&depth.textureType==MTLTextureType2D))&&(!motion||(color.device==motion.device&&motion.textureType==MTLTextureType2D));}
struct Bound {
 RSTemporalFrame frame{};RSSceneMatrices matrices{};__weak id<MTLCommandBuffer>commands;
 id<MTLTexture>color,depth,motion;
};
std::mutex bindingLock;std::unordered_map<void*,std::deque<std::shared_ptr<Bound>>>bindings;
void prune(){for(auto owner=bindings.begin();owner!=bindings.end();){auto&frames=owner->second;frames.erase(std::remove_if(frames.begin(),frames.end(),[](const auto&value){return !value->commands;}),frames.end());if(frames.empty())owner=bindings.erase(owner);else++owner;}}
bool same(const Bound&value,const RSTemporalFrame&frame){const auto&f=value.frame;return value.commands==(__bridge id<MTLCommandBuffer>)frame.commandBuffer&&f.frameId==frame.frameId&&f.owner==frame.owner&&f.color==frame.color&&f.depth==frame.depth&&f.motion==frame.motion&&f.renderWidth==frame.renderWidth&&f.renderHeight==frame.renderHeight&&f.colorX==frame.colorX&&f.colorY==frame.colorY&&f.depthX==frame.depthX&&f.depthY==frame.depthY&&f.motionX==frame.motionX&&f.motionY==frame.motionY&&bool(f.flags&RS_TEMPORAL_OUTPUT_MOTION)==bool(frame.flags&RS_TEMPORAL_OUTPUT_MOTION);}
struct Pending {void*owner=nullptr;__weak id<MTLTexture>color,depth,motion;RSSceneMatrices matrices{};bool pending=false,blocked=false,hasDepth=false,hasMotion=false;};
std::mutex pendingLock;std::array<Pending,64>pending;std::atomic<unsigned>pendingCount{0};
void recount(){unsigned count=0;for(const auto&value:pending)count+=value.pending;pendingCount.store(count,std::memory_order_release);}
}
extern "C" int rsBindTemporalSceneMatrices(const RSTemporalFrame*frame,const RSSceneMatrices*value){
 if(!frame||frame->size<sizeof(*frame)||frame->version!=1||!frame->owner||!frame->commandBuffer||frame->commandBufferKind||!valid(value)||value->frameId!=frame->frameId)return RS_TEMPORAL_INVALID;
 auto commands=(__bridge id<MTLCommandBuffer>)frame->commandBuffer;auto color=(__bridge id<MTLTexture>)frame->color,depth=(__bridge id<MTLTexture>)frame->depth,motion=(__bridge id<MTLTexture>)frame->motion;
 if(!textures(color,depth,motion)||commands.device!=color.device||commands.status>=MTLCommandBufferStatusCommitted||!commands.retainedReferences)return RS_TEMPORAL_INVALID;
 auto record=std::make_shared<Bound>();record->frame=*frame;record->matrices=*value;record->commands=commands;record->color=color;record->depth=depth;record->motion=motion;
 {std::lock_guard guard(bindingLock);prune();auto existing=bindings.find(frame->owner);if(existing==bindings.end()&&bindings.size()>=maximumOwners)return RS_TEMPORAL_BUSY;auto&frames=bindings[frame->owner];for(const auto&prior:frames)if(same(*prior,*frame))return RS_TEMPORAL_BUSY;if(frames.size()>=maximumFrames)return RS_TEMPORAL_BUSY;frames.push_back(record);}
 const std::weak_ptr<Bound>weak=record;const auto owner=frame->owner;
 [commands addCompletedHandler:^(id<MTLCommandBuffer>){if(auto record=weak.lock()){std::lock_guard guard(bindingLock);auto found=bindings.find(owner);if(found!=bindings.end()){auto&frames=found->second;frames.erase(std::remove(frames.begin(),frames.end(),record),frames.end());if(frames.empty())bindings.erase(found);}}}];
 return RS_TEMPORAL_OK;
}
extern "C" void rsReleaseTemporalSceneMatrices(void*owner){rsClearTemporalMatricesTextures(owner);std::lock_guard guard(bindingLock);bindings.erase(owner);}
extern "C" void rsClearTemporalMatricesTextures(void*owner){if(!owner)return;std::lock_guard guard(pendingLock);for(auto&record:pending)if(record.owner==owner)record={};recount();}
extern "C" int rsSetTemporalMatricesForTextures(void*owner,void*color,void*depth,void*motion,const RSSceneMatrices*value){
 if(!owner)return RS_TEMPORAL_INVALID;if(!value){rsClearTemporalMatricesTextures(owner);return RS_TEMPORAL_OK;}
 auto c=(__bridge id<MTLTexture>)color,d=(__bridge id<MTLTexture>)depth,m=(__bridge id<MTLTexture>)motion;if(!valid(value)||!textures(c,d,m)){rsClearTemporalMatricesTextures(owner);return RS_TEMPORAL_INVALID;}
 std::lock_guard guard(pendingLock);Pending*free=nullptr;
 for(auto&record:pending){if(record.owner&&(!record.color||record.hasDepth&&!record.depth||record.hasMotion&&!record.motion))record={};if(!record.owner){if(!free)free=&record;continue;}if(record.color==c&&record.depth==d&&record.motion==m){record.pending=false;record.blocked=true;recount();return RS_TEMPORAL_BUSY;}}
 if(!free)return RS_TEMPORAL_BUSY;free->owner=owner;free->color=c;free->depth=d;free->motion=m;free->hasDepth=d!=nil;free->hasMotion=m!=nil;free->matrices=*value;free->pending=true;recount();return RS_TEMPORAL_OK;
}
namespace macfx {
std::optional<RSSceneMatrices>sceneMatricesForImage(const RSTemporalFrame&source,const std::optional<RSSceneMatrices>&value,bool colorJittered,bool bottomLeft){
 if(!value||value->frameId!=source.frameId)return {};auto result=*value;
 if(!colorJittered&&(result.flags&RS_SCENE_PROJECTION_JITTERED)){
  if(!source.renderWidth||!source.renderHeight||!std::isfinite(source.jitterX)||!std::isfinite(source.jitterY))return {};
  const double x=2.*source.jitterX/source.renderWidth;
  const double y=((result.flags&RS_SCENE_PROJECTION_Y_DOWN)?2.:-2.)*(bottomLeft?-1.:1.)*source.jitterY/source.renderHeight;
  for(unsigned row=0;row<4;++row){const auto w=result.projection[row*4+3];result.projection[row*4]=float(result.projection[row*4]-x*w);result.projection[row*4+1]=float(result.projection[row*4+1]-y*w);}
  result.flags&=~uint32_t(RS_SCENE_PROJECTION_JITTERED);if(!matrix(result.projection))return {};
 }
 return result;
}
uint32_t temporalSceneInputMask(const RSTemporalFrame&frame)noexcept{try{uint32_t result=0;if(frame.depth)result|=RuntimeInputDepth;if(frame.motion)result|=RuntimeInputMotion;if(frame.color&&std::isfinite(frame.jitterX)&&std::isfinite(frame.jitterY))result|=RuntimeInputJitter;if(frame.flags&RS_TEMPORAL_CAMERA_VALID)result|=RuntimeInputCamera;if(frame.exposure)result|=RuntimeInputExposure;const auto matrices=temporalSceneMatrices(frame);if(matrices&&matrices->flags&RS_SCENE_VIEW_VALID)result|=RuntimeInputViewMatrix;if(matrices&&matrices->flags&RS_SCENE_PROJECTION_VALID)result|=RuntimeInputProjectionMatrix;return result;}catch(...){return 0;}}
std::optional<RSSceneMatrices> temporalSceneMatrices(const RSTemporalFrame&frame){std::lock_guard guard(bindingLock);auto found=bindings.find(frame.owner);if(found==bindings.end())return {};for(const auto&record:found->second)if(same(*record,frame))return record->matrices;return {};}
std::optional<RSSceneMatrices>takeTemporalMatricesForTextures(const RSTemporalFrame&frame){
 if(!pendingCount.load(std::memory_order_acquire))return {};
 std::optional<RSSceneMatrices>value;
 {std::lock_guard guard(pendingLock);for(auto&record:pending){if(!record.pending)continue;if(!record.color||record.hasDepth&&!record.depth||record.hasMotion&&!record.motion){record={};continue;}if(record.color==(__bridge id<MTLTexture>)frame.color&&record.depth==(__bridge id<MTLTexture>)frame.depth&&record.motion==(__bridge id<MTLTexture>)frame.motion){if(value){record={};recount();return {};}value=record.matrices;record={};}}recount();}
 return value;
}
int bindTemporalMatricesForTextures(const RSTemporalFrame&frame){auto value=takeTemporalMatricesForTextures(frame);return value?rsBindTemporalSceneMatrices(&frame,&*value):RS_TEMPORAL_UNAVAILABLE;
}
}
