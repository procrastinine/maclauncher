#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "../vulkan/scene-metadata.h"
#include "../../../shared/reshade/temporal/frame.h"
#include "../../../shared/reshade/temporal/scene-aovs.h"
#include "../../../shared/reshade/temporal/scene-matrices.h"
#include <cmath>
#include <cstring>
namespace maclauncher::ngx {
enum class Feature {SuperResolution,RayReconstruction,FrameGeneration};
enum class Status {Recorded,Unavailable,Invalid,Busy,Failed};
// The translator fills these from the actual resource/command recording. A D3D
// resource address is never a Vulkan image. Origins describe the actual ROI.
struct Image {
 RSWineVulkanSceneImageV1 binding{};
 uint32_t width=0,height=0,x=0,y=0;
 bool covers(uint32_t w,uint32_t h)const {
  return binding.image&&binding.aspect&&!binding.reserved&&x<=width&&y<=height&&w<=width-x&&h<=height-y;
 }
};
struct Evaluation {
 Feature feature=Feature::SuperResolution;
 uint64_t device=0,commands=0,generation=0,consumer=0,frameId=0;
 double sourceTimeSeconds=0;
 uint32_t width=0,height=0,outputWidth=0,outputHeight=0;
 Image color,depth,motion,output,exposure;
 Image guides[RS_SCENE_AOV_COUNT];
 RSSceneAovs aovs{};
 RSSceneMatrices matrices{};
 RSWineVulkanSceneColorV1 colorDescription{};
 bool colorKnown=false,deviceDepth=false,currentToPreviousMotion=false;
 bool reversedDepth=false,infiniteDepth=false,jitteredMotion=false,outputMotion=false,reset=false;
 float jitterX=0,jitterY=0,motionScaleX=0,motionScaleY=0,preExposure=1,frameTimeMs=0;
 // Method is assigned by the existing prepared graph, never by NGX feature ID.
 uint32_t method=0,profile=0;
};
inline bool finiteMatrix(const float*matrix){for(unsigned i=0;i<16;++i)if(!std::isfinite(matrix[i]))return false;return true;}
inline Status map(const Evaluation&s,RSWineVulkanSceneRequestV2&out){
 // The current recorded-scene consumer has no FG destination/pair contract.
 // Never authorize NGX output replacement or a second generation owner.
 if(s.feature==Feature::FrameGeneration)return Status::Unavailable;
 if(!s.device||!s.commands||!s.generation||!s.consumer||!s.frameId||!s.width||!s.height||!s.outputWidth||!s.outputHeight||
    !std::isfinite(s.sourceTimeSeconds)||s.sourceTimeSeconds<0||!std::isfinite(s.frameTimeMs)||s.frameTimeMs<=0||
    !std::isfinite(s.jitterX)||!std::isfinite(s.jitterY)||!std::isfinite(s.motionScaleX)||!std::isfinite(s.motionScaleY)||
    !std::isfinite(s.preExposure)||s.preExposure<0)return Status::Invalid;
 if(!s.deviceDepth||!s.currentToPreviousMotion)return Status::Unavailable;
 if(!s.color.covers(s.width,s.height)||!s.depth.covers(s.width,s.height)||
    !s.motion.covers(s.outputMotion?s.outputWidth:s.width,s.outputMotion?s.outputHeight:s.height)||
    !s.output.covers(s.outputWidth,s.outputHeight))return Status::Invalid;
 RSWineVulkanSceneRequestV2 result{};auto&r=result.base;auto&m=result.metadata;
 r.size=sizeof(r);r.version=1;r.profile=RS_WINE_VULKAN_SCENE_PROFILE;r.flags=RS_WINE_VULKAN_ORIGINAL_OUTPUT_RETAINED;
 r.device=s.device;r.commandBuffer=s.commands;r.ownerId=s.generation;r.consumerId=s.consumer;r.frameId=s.frameId;r.sourceTimeSeconds=s.sourceTimeSeconds;
 auto&f=r.frame;f.method=s.method;f.profile=s.profile;
 f.renderWidth=f.maxRenderWidth=s.width;f.renderHeight=f.maxRenderHeight=s.height;f.outputWidth=s.outputWidth;f.outputHeight=s.outputHeight;
 f.colorX=s.color.x;f.colorY=s.color.y;f.depthX=s.depth.x;f.depthY=s.depth.y;f.motionX=s.motion.x;f.motionY=s.motion.y;f.outputX=s.output.x;f.outputY=s.output.y;
 f.jitterX=s.jitterX;f.jitterY=s.jitterY;f.motionScaleX=s.motionScaleX;f.motionScaleY=s.motionScaleY;
 f.preExposure=s.preExposure==0?1:s.preExposure;f.frameTimeMs=s.frameTimeMs;
 f.flags=(s.reset?RS_TEMPORAL_RESET:0)|(s.reversedDepth?RS_TEMPORAL_DEPTH_REVERSED:0)|(s.infiniteDepth?RS_TEMPORAL_DEPTH_INFINITE:0)|
  (s.jitteredMotion?RS_TEMPORAL_JITTERED_MOTION:0)|(s.outputMotion?RS_TEMPORAL_OUTPUT_MOTION:0);
 const Image*images[]={&s.color,&s.depth,&s.motion,&s.output,&s.exposure};
 for(unsigned i=0;i<5;++i)if(images[i]->binding.image){r.images[i]=images[i]->binding;r.imageMask|=1u<<i;}
 r.colorKnown=s.colorKnown;r.color=s.colorDescription;
 m.size=sizeof(m);m.version=2;
 if(s.matrices.flags){
  const auto&v=s.matrices;
  if(v.size!=sizeof(v)||v.version!=1||v.frameId!=s.frameId||v.reserved||v.flags&~63u||
     (v.flags&12u)==12u||!finiteMatrix(v.view)||!finiteMatrix(v.projection))return Status::Invalid;
  m.matrixFlags=v.flags;std::memcpy(m.view,v.view,sizeof(m.view));std::memcpy(m.projection,v.projection,sizeof(m.projection));
 }
 const auto&a=s.aovs;
 for(unsigned i=0;i<RS_SCENE_AOV_COUNT;++i)if(s.guides[i].binding.image){
  const auto&g=s.guides[i];const auto&v=a.images[i];
  if(a.size!=sizeof(a)||a.version!=1||a.frameId!=s.frameId||a.reserved||a.reserved2||
     !g.covers(v.width,v.height)||v.texture||v.reserved||!v.width||!v.height||
     v.x!=g.x||v.y!=g.y||v.encoding>5||v.space>2||v.channel>3||v.origin>1||
     !std::isfinite(v.scale)||!std::isfinite(v.bias))return Status::Invalid;
  r.images[RS_WINE_SCENE_AOV_FIRST+i]=g.binding;r.imageMask|=1u<<(RS_WINE_SCENE_AOV_FIRST+i);m.aovMask|=1u<<i;
  m.images[i]={v.x,v.y,v.width,v.height,v.encoding,v.space,v.channel,v.origin,v.scale,v.bias,v.pass,0};
 }
 if(m.aovMask){
  if(!std::isfinite(a.preExposure)||a.preExposure<=0)return Status::Invalid;
  m.aovFlags=a.flags;m.viewId=a.viewId;m.epoch=a.epoch;m.imageRevision=a.imageRevision;m.preExposure=a.preExposure;m.pass=a.pass;m.colorPass=a.colorPass;
  std::memcpy(&m.color,&a.color,sizeof(m.color));std::memcpy(&m.uiColor,&a.uiColor,sizeof(m.uiColor));std::memcpy(&m.hudlessColor,&a.hudlessColor,sizeof(m.hudlessColor));
 }
 if(s.feature==Feature::RayReconstruction){
  constexpr uint32_t guides=(1u<<RS_SCENE_AOV_NORMAL)|(1u<<RS_SCENE_AOV_ROUGHNESS)|(1u<<RS_SCENE_AOV_DIFFUSE_ALBEDO)|(1u<<RS_SCENE_AOV_SPECULAR_ALBEDO)|(1u<<RS_SCENE_AOV_SPECULAR_HIT_DISTANCE);
  const auto&normal=m.images[RS_SCENE_AOV_NORMAL];
  if((normal.encoding!=RS_SCENE_AOV_XYZ_SIGNED&&normal.encoding!=RS_SCENE_AOV_XYZ_UNORM)||
     (normal.space!=RS_SCENE_AOV_SPACE_VIEW&&normal.space!=RS_SCENE_AOV_SPACE_WORLD))return Status::Unavailable;
  if((m.aovMask&guides)!=guides||(m.matrixFlags&3u)!=3u||!(m.matrixFlags&12u)||!(m.aovFlags&RS_SCENE_AOV_COLOR_NOISY))return Status::Unavailable;
 }
 out=result;return Status::Recorded;
}
// This calls the matched PE export only. The native side unwraps Wine handles
// and uses existing recorded-scene leases. Recorded is never NGX output success.
inline Status record(const Evaluation&source,RSWineVulkanSceneRecordCall2 sink,int32_t&nativeResult){
 if(!sink)return Status::Unavailable;
 RSWineVulkanSceneRequestV2 packet{};auto status=map(source,packet);if(status!=Status::Recorded)return status;
 nativeResult=sink(&packet);
 if(nativeResult==0)return Status::Recorded;
 if(nativeResult==1||nativeResult==2)return Status::Busy; // VK_NOT_READY / VK_TIMEOUT
 if(nativeResult==-8)return Status::Unavailable; // VK_ERROR_FEATURE_NOT_PRESENT
 return Status::Failed;
}
}
