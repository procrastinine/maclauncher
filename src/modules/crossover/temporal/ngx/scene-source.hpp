#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "routing.hpp"
#include "../vulkan/scene-metadata-native.h"
namespace maclauncher::ngx {
// A cooperating interception scope supplies this EXISTING fixed-width packet
// for the exact scene, including its true frame identity and conventions.
// Unknown source metadata is not filled from resource formats or timestamps.
inline bool sourceEvaluation(const RSWineVulkanSceneRequestV2&packet,Evaluation&out){
 const auto&p=packet.base;const auto&m=packet.metadata;
 if(p.size!=sizeof(p)||p.version!=1||p.profile!=RS_WINE_VULKAN_SCENE_PROFILE||!p.frameId||
    p.flags!=RS_WINE_VULKAN_ORIGINAL_OUTPUT_RETAINED||p.colorKnown>1||
    (p.imageMask&7u)!=7u||!p.images[0].image||!p.images[1].image||!p.images[2].image)return false;
 RSSceneAovs aovs{};RSSceneMatrices matrices{};
 if(!rsWineSceneMetadataDecode(&p,&m,&aovs,&matrices))return false;
 Evaluation s;const auto&f=p.frame;
 s.frameId=p.frameId;s.sourceTimeSeconds=p.sourceTimeSeconds;s.destinationWindow=m.destinationWindow;
 s.width=f.renderWidth;s.height=f.renderHeight;s.outputWidth=f.outputWidth;s.outputHeight=f.outputHeight;
 s.maxRenderWidth=f.maxRenderWidth;s.maxRenderHeight=f.maxRenderHeight;
 s.jitterX=f.jitterX;s.jitterY=f.jitterY;s.motionScaleX=f.motionScaleX;s.motionScaleY=f.motionScaleY;
 s.preExposure=f.preExposure;s.frameTimeMs=f.frameTimeMs;
 s.cameraValid=f.flags&RS_TEMPORAL_CAMERA_VALID;s.nearPlane=f.nearPlane;s.farPlane=f.farPlane;s.verticalFov=f.verticalFov;
 s.color.x=f.colorX;s.color.y=f.colorY;s.depth.x=f.depthX;s.depth.y=f.depthY;
 s.motion.x=f.motionX;s.motion.y=f.motionY;s.output.x=f.outputX;s.output.y=f.outputY;
 // The supplied frame contract explicitly declares device depth and
 // current-pixel-to-previous-pixel motion. Linear input is never reinterpreted.
 s.deviceDepth=s.currentToPreviousMotion=true;
 s.reversedDepth=f.flags&RS_TEMPORAL_DEPTH_REVERSED;s.infiniteDepth=f.flags&RS_TEMPORAL_DEPTH_INFINITE;
 s.jitteredMotion=f.flags&RS_TEMPORAL_JITTERED_MOTION;s.outputMotion=f.flags&RS_TEMPORAL_OUTPUT_MOTION;
 s.reset=f.flags&RS_TEMPORAL_RESET;s.autoExposure=f.flags&RS_TEMPORAL_AUTO_EXPOSURE;
 for(unsigned i=0;i<RS_WINE_VULKAN_SCENE_IMAGE_COUNT;++i)s.expectedImages[i]=p.images[i];
 s.colorKnown=p.colorKnown;s.colorDescription=p.color;s.aovs=aovs;s.matrices=matrices;
 for(unsigned i=0;i<RS_SCENE_AOV_COUNT;++i){s.guides[i].x=aovs.images[i].x;s.guides[i].y=aovs.images[i].y;}
 out=s;return true;
}
}
