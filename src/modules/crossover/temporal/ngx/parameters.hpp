#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "routing.hpp"
namespace maclauncher::ngx {
// Instantiated against the actual NGX parameter interface and the translator's
// D3D resource type. This introduces no guessed NGX vtable or COM interface.
// Translator::image must resolve on the actual recording command list and
// retain its ordinary resource/barrier ownership before the scene is recorded.
template<class Parameters,class Resource,class Translator> class ParameterReader {
 const Parameters&parameters;Translator&translator;
public:
 ParameterReader(const Parameters&p,Translator&t):parameters(p),translator(t){}
 bool get(const char*key,float&value){float next;if(parameters.Get(key,&next)!=1)return false;value=next;return true;}
 bool get(const char*key,uint32_t&value){unsigned next;if(parameters.Get(key,&next)!=1)return false;value=next;return true;}
 bool readImage(const char*key,Image&image){
  Resource*resource=nullptr;
  if(parameters.Get(key,&resource)!=1){void*opaque=nullptr;if(parameters.Get(key,&opaque)!=1)return false;resource=static_cast<Resource*>(opaque);}
  if(!resource)return false;
  Image resolved;if(!translator.image(resource,resolved))return false;
  resolved.x=image.x;resolved.y=image.y;image=resolved;return true;
 }
 bool readMatrix(const char*key,float*out){
  void*source=nullptr;if(parameters.Get(key,&source)!=1||!source)return false;
  float copied[16];std::memcpy(copied,source,sizeof(copied));if(!finiteMatrix(copied))return false;
  std::memcpy(out,copied,sizeof(copied));return true;
 }
};
// Creation dimensions are retained separately from dynamic Evaluate subrects.
// These bits are NGX input conventions, never a selected graphics provider.
template<class Reader> bool readCreation(Reader&reader,Evaluation&out){
 auto value=out;uint32_t flags=0;
 if(!reader.get("Width",value.width)||!reader.get("Height",value.height)||
    !reader.get("OutWidth",value.outputWidth)||!reader.get("OutHeight",value.outputHeight)||
    !value.width||!value.height||!value.outputWidth||!value.outputHeight)return false;
 reader.get("DLSS.Feature.Create.Flags",flags);
 value.maxRenderWidth=value.width;value.maxRenderHeight=value.height;
 value.outputMotion=(flags&(1u<<1))==0;value.jitteredMotion=(flags&(1u<<2))!=0;
 value.reversedDepth=(flags&(1u<<3))!=0;value.autoExposure=(flags&(1u<<6))!=0;
 out=value;return true;
}
// Reader adapts NGX's typed Get. readImage resolves actual translator resources
// and subresources; D3D addresses must never be interpreted as Vulkan images.
template<class Reader> bool readParameters(Reader&reader,Evaluation&out){
 auto value=out;
 // A supplied subregion is a pair. Keep the cooperating scene's explicit
 // origin when absent; a half-specified pair cannot describe an attachment.
 auto origin=[&](Image&image,const char*xKey,const char*yKey){
  uint32_t x=0,y=0;const bool hasX=reader.get(xKey,x),hasY=reader.get(yKey,y);
  if(hasX!=hasY)return false;if(hasX){image.x=x;image.y=y;}return true;
 };
 float duration=0;
 if(reader.get("FrameTimeDeltaInMsec",duration)){
  if(!std::isfinite(duration)||duration<=0)return false;value.frameTimeMs=duration;
 }
 if(value.feature==Feature::FrameGeneration){
  if(!reader.readImage("DLSSG.Backbuffer",value.color)||!reader.readImage("DLSSG.Depth",value.depth)||
     !reader.readImage("DLSSG.MVecs",value.motion)||!reader.readImage("DLSSG.OutputInterpolated",value.output)||
     !reader.readImage("DLSSG.OutputReal",value.realOutput))return false;
  const bool hudless=reader.readImage("DLSSG.HUDLess",value.guides[RS_SCENE_AOV_HUDLESS_COLOR]);
  const bool ui=reader.readImage("DLSSG.UI",value.guides[RS_SCENE_AOV_UI_COLOR_ALPHA]);
  value.uiComposited=!(hudless&&ui);
  if(!value.uiComposited)value.color=value.guides[RS_SCENE_AOV_HUDLESS_COLOR];
  if(!reader.get("DLSSG.MvecScaleX",value.motionScaleX)||!reader.get("DLSSG.MvecScaleY",value.motionScaleY)||
     !reader.get("DLSSG.JitterOffsetX",value.jitterX)||!reader.get("DLSSG.JitterOffsetY",value.jitterY))return false;
  uint32_t reset=0;reader.get("DLSSG.Reset",reset);value.reset=reset!=0;
  // Camera units, actual source timing and real/previous history must come
  // from the cooperating scene contract. No QPC-based 60Hz substitute.
  out=value;return true;
 }
 if(!reader.readImage("Color",value.color)||!reader.readImage("Depth",value.depth)||
    !reader.readImage("MotionVectors",value.motion)||!reader.readImage("Output",value.output))return false;
 if(!reader.get("MV.Scale.X",value.motionScaleX)||!reader.get("MV.Scale.Y",value.motionScaleY)||
    !reader.get("Jitter.Offset.X",value.jitterX)||!reader.get("Jitter.Offset.Y",value.jitterY))return false;
 if(!origin(value.color,"DLSS.Input.Color.Subrect.Base.X","DLSS.Input.Color.Subrect.Base.Y")||
    !origin(value.depth,"DLSS.Input.Depth.Subrect.Base.X","DLSS.Input.Depth.Subrect.Base.Y")||
    !origin(value.motion,"DLSS.Input.MV.Subrect.Base.X","DLSS.Input.MV.Subrect.Base.Y")||
    !origin(value.output,"DLSS.Output.Subrect.Base.X","DLSS.Output.Subrect.Base.Y"))return false;
 uint32_t reset=0;reader.get("Reset",reset);value.reset=reset!=0;
 uint32_t width=0,height=0;
 const bool hasWidth=reader.get("DLSS.Render.Subrect.Dimensions.Width",width);
 const bool hasHeight=reader.get("DLSS.Render.Subrect.Dimensions.Height",height);
 if(hasWidth!=hasHeight||(hasWidth&&(!width||!height)))return false;
 if(hasWidth){value.width=width;value.height=height;}
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
  auto guideOrigin=[&](unsigned slot,const char*xKey,const char*yKey){
   auto&image=value.guides[slot];if(!origin(image,xKey,yKey))return false;
   value.aovs.images[slot].x=image.x;value.aovs.images[slot].y=image.y;return true;
  };
  if(!guideOrigin(RS_SCENE_AOV_NORMAL,"DLSS.Input.Normals.Subrect.Base.X","DLSS.Input.Normals.Subrect.Base.Y")||
     !guideOrigin(RS_SCENE_AOV_DIFFUSE_ALBEDO,"DLSS.Input.DiffuseAlbedo.Subrect.Base.X","DLSS.Input.DiffuseAlbedo.Subrect.Base.Y")||
     !guideOrigin(RS_SCENE_AOV_SPECULAR_ALBEDO,"DLSS.Input.SpecularAlbedo.Subrect.Base.X","DLSS.Input.SpecularAlbedo.Subrect.Base.Y")||
     !guideOrigin(RS_SCENE_AOV_SPECULAR_HIT_DISTANCE,"DLSSD.SpecularHitDistance.Subrect.Base.X","DLSSD.SpecularHitDistance.Subrect.Base.Y"))return false;
  uint32_t mode=0;reader.get("DLSS.Roughness.Mode",mode);
  if(mode==1){value.guides[RS_SCENE_AOV_ROUGHNESS]=value.guides[RS_SCENE_AOV_NORMAL];value.aovs.images[RS_SCENE_AOV_ROUGHNESS]=value.aovs.images[RS_SCENE_AOV_NORMAL];value.aovs.images[RS_SCENE_AOV_ROUGHNESS].encoding=RS_SCENE_AOV_SCALAR;value.aovs.images[RS_SCENE_AOV_ROUGHNESS].space=RS_SCENE_AOV_SPACE_NONE;value.aovs.images[RS_SCENE_AOV_ROUGHNESS].channel=3;}
  else if(mode!=0||!resolve(RS_SCENE_AOV_ROUGHNESS,"GBuffer.Roughness"))return false;
  if(mode==0&&!guideOrigin(RS_SCENE_AOV_ROUGHNESS,"DLSS.Input.Roughness.Subrect.Base.X","DLSS.Input.Roughness.Subrect.Base.Y"))return false;
  if(!reader.readMatrix("WorldToViewMatrix",value.matrices.view)||!reader.readMatrix("ViewToClipMatrix",value.matrices.projection))return false;
 }
 out=value;return true;
}
}
