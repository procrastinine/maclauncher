#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "routing.hpp"
namespace maclauncher::ngx {
// Reader adapts NGX's typed Get. readImage resolves actual translator resources
// and subresources; D3D addresses must never be interpreted as Vulkan images.
template<class Reader> bool readParameters(Reader&reader,Evaluation&out){
 auto value=out;
 if(value.feature==Feature::FrameGeneration)return false;
 if(!reader.readImage("Color",value.color)||!reader.readImage("Depth",value.depth)||
    !reader.readImage("MotionVectors",value.motion)||!reader.readImage("Output",value.output))return false;
 if(!reader.get("MV.Scale.X",value.motionScaleX)||!reader.get("MV.Scale.Y",value.motionScaleY)||
    !reader.get("Jitter.Offset.X",value.jitterX)||!reader.get("Jitter.Offset.Y",value.jitterY))return false;
 uint32_t reset=0;reader.get("Reset",reset);value.reset=reset!=0;
 reader.get("DLSS.Pre.Exposure",value.preExposure);reader.readImage("ExposureTexture",value.exposure);
 if(value.feature==Feature::RayReconstruction){
  uint32_t hardwareDepth=1;reader.get("DLSS.Use.HW.Depth",hardwareDepth);value.deviceDepth=value.deviceDepth&&hardwareDepth!=0;
  auto resolve=[&](unsigned slot,const char*name,const char*alternative=nullptr){
   return reader.readImage(name,value.guides[slot])||(alternative&&reader.readImage(alternative,value.guides[slot]));
  };
  if(!resolve(RS_SCENE_AOV_NORMAL,"GBuffer.Normals")||
     !resolve(RS_SCENE_AOV_DIFFUSE_ALBEDO,"DLSS.Input.DiffuseAlbedo","GBuffer.Albedo")||
     !resolve(RS_SCENE_AOV_SPECULAR_ALBEDO,"DLSS.Input.SpecularAlbedo","GBuffer.Specular")||
     !resolve(RS_SCENE_AOV_SPECULAR_HIT_DISTANCE,"DLSSD.SpecularHitDistance"))return false;
  uint32_t mode=0;reader.get("DLSS.Roughness.Mode",mode);
  if(mode==1){value.guides[RS_SCENE_AOV_ROUGHNESS]=value.guides[RS_SCENE_AOV_NORMAL];value.aovs.images[RS_SCENE_AOV_ROUGHNESS]=value.aovs.images[RS_SCENE_AOV_NORMAL];value.aovs.images[RS_SCENE_AOV_ROUGHNESS].encoding=RS_SCENE_AOV_SCALAR;value.aovs.images[RS_SCENE_AOV_ROUGHNESS].space=RS_SCENE_AOV_SPACE_NONE;value.aovs.images[RS_SCENE_AOV_ROUGHNESS].channel=3;}
  else if(mode!=0||!resolve(RS_SCENE_AOV_ROUGHNESS,"GBuffer.Roughness"))return false;
  if(!reader.readMatrix("WorldToViewMatrix",value.matrices.view)||!reader.readMatrix("ViewToClipMatrix",value.matrices.projection))return false;
 }
 out=value;return true;
}
}
