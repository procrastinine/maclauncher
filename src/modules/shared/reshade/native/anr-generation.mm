// Copyright (c) MacLauncher contributors. MIT license.
#include "generation-provider.hpp"
#include "generation-provider.h"
#include "image-admission.hpp"
#include "scene-aovs.hpp"
#include "image-color.hpp"
#if __has_include("anr-submission.h")
#include "anr-submission.h"
#else
#include "../generation/anr/native/submission.h"
#endif
#include <dlfcn.h>
#include <filesystem>
#include <mutex>
#include <stdexcept>
namespace macfx {
namespace {
struct Module {
 void*library=nullptr;const RSGenerationProvider*api=nullptr;std::string directory;
 Module(){
  const char*configured=std::getenv("RESHADE_ANR_GENERATION_LIBRARY");std::filesystem::path file;
  if(configured&&*configured)file=configured;else{Dl_info info{};if(!dladdr(reinterpret_cast<const void*>(&makeANRGenerationEncoder),&info)||!info.dli_fname)throw std::runtime_error("The graphics provider directory is unavailable");file=std::filesystem::path(info.dli_fname).parent_path()/"generation/anr/libmaclauncher-anr-generation.dylib";}
  if(!file.is_absolute())throw std::runtime_error("The frame-generation provider requires an absolute library path");
  library=dlopen(file.c_str(),RTLD_NOW|RTLD_LOCAL);if(!library){const char*error=dlerror();throw std::runtime_error(std::string("The Apex Neural Rendering frame-generation provider is unavailable: ")+(error?:"unknown loader error"));}
  const auto get=reinterpret_cast<const RSGenerationProvider*(*)(uint32_t)>(dlsym(library,"rsGetGenerationProvider"));api=get?get(1):nullptr;
  if(!api||api->size<sizeof(*api)||api->version!=1||!api->create||!api->encode||!api->destroy||!api->prepare)throw std::runtime_error("The Apex Neural Rendering frame-generation provider has an incompatible API");directory=file.parent_path();
 }
};
std::shared_ptr<Module>module(){static auto*loaded=new std::shared_ptr<Module>(std::make_shared<Module>());return *loaded;}
void*reserve(void*device,uint64_t bytes)noexcept{try{auto value=reserveImageBytes((__bridge id<MTLDevice>)device,bytes,0,"anr-generation-memory");value->commit();return new std::shared_ptr<ImageReservation>(std::move(value));}catch(...){return nullptr;}}
void release(void*token)noexcept{delete static_cast<std::shared_ptr<ImageReservation>*>(token);}
class Encoder final:public GenerationEncoder {
 id<MTLDevice>device;FrameOrigin origin=FrameOrigin::TopLeft;std::shared_ptr<Module>provider;void*context=nullptr;
 std::mutex mutex;RSTemporalFrame scene{};ImageColorDescription colorDescription;id<MTLTexture>depth=nil,motion=nil;__weak id<MTLCommandBuffer>sceneCommands=nil;
 RSANRSubmission input(id<MTLCommandBuffer>commands,id<MTLTexture>color,const RSTemporalFrame*frame,uint64_t sequence=0){RSANRSubmission extended{};auto&value=extended.base;value.size=sizeof(extended);value.version=1;value.commandBuffer=(__bridge void*)commands;value.color=(__bridge void*)color;value.sequence=sequence;value.transferFunction=colorDescription.transfer==ColorTransfer::PQ?1:colorDescription.transfer==ColorTransfer::Linear?2:0;value.minLuminance=colorDescription.blackLuminance;value.maxLuminance=colorDescription.transfer==ColorTransfer::SRGB?1:colorDescription.peakLuminance;value.scene=frame;extended.referenceWhite=colorDescription.referenceWhite;extended.bottomLeft=origin==FrameOrigin::BottomLeft;
  if(frame){auto aovs=temporalSceneAovs(*frame);if(aovs&&aovs->composedRegionKnown&&aovs->composedColor==color&&!aovs->composedX&&!aovs->composedY&&aovs->composedWidth==color.width&&aovs->composedHeight==color.height&&aovs->value.frameId==frame->frameId){const auto&p=aovs->value;const auto&h=p.images[RS_SCENE_AOV_HUDLESS_COLOR];const auto&u=p.images[RS_SCENE_AOV_UI_COLOR_ALPHA];auto hud=aovs->textures[RS_SCENE_AOV_HUDLESS_COLOR],ui=aovs->textures[RS_SCENE_AOV_UI_COLOR_ALPHA];
   const auto sameColor=[&](const RSImageColorDescription&raw){try{const auto v=readImageColor(raw);return v.primaries==colorDescription.primaries&&v.transfer==colorDescription.transfer&&v.range==colorDescription.range&&v.referenceWhite==colorDescription.referenceWhite&&v.peakLuminance==colorDescription.peakLuminance&&v.blackLuminance==colorDescription.blackLuminance&&v.hlgSystemGamma==colorDescription.hlgSystemGamma&&v.sceneReferred==colorDescription.sceneReferred;}catch(...){return false;}};
   const auto full=[&](const RSSceneAovImage&r,id<MTLTexture>t){return t&&t.device==device&&t.width==color.width&&t.height==color.height&&!r.x&&!r.y&&r.width==color.width&&r.height==color.height&&r.origin==unsigned(origin)&&r.encoding==RS_SCENE_AOV_COLOR;};
   // Exact alpha overlay only. Color/alpha transforms must already match.
   if(rsSceneAovConventionsKnown(&p,RS_SCENE_AOV_HUDLESS_COLOR)&&rsSceneAovConventionsKnown(&p,RS_SCENE_AOV_UI_COLOR_ALPHA)&&full(h,hud)&&full(u,ui)&&sameColor(p.hudlessColor)&&sameColor(p.uiColor)&&(p.uiColor.alpha==RS_COLOR_STRAIGHT||p.uiColor.alpha==RS_COLOR_PREMULTIPLIED)&&ui.pixelFormat==color.pixelFormat&&hud.pixelFormat==color.pixelFormat&&p.hudlessColor.transfer==p.uiColor.transfer&&p.hudlessColor.primaries==p.uiColor.primaries&&p.hudlessColor.referenceWhite==p.uiColor.referenceWhite){value.color=(__bridge void*)hud;extended.ui=(__bridge void*)ui;extended.premultiplied=p.uiColor.alpha==RS_COLOR_PREMULTIPLIED;}
  }}return extended;}
 GenerationResult result(const RSGenerationResult&value,int code){GenerationResult result;result.encoded=code==RS_GENERATION_OK&&value.encoded;result.ready=code==RS_GENERATION_OK&&value.ready;result.busy=code==RS_GENERATION_BUSY;result.frameId=value.sequence;result.generated=value.generated;result.historyFrames=value.historyFrames;result.reason=value.reason;return result;}
public:
 Encoder(id<MTLDevice>gpu,const LsfgConfig&config):device(gpu),provider(module()){
  if(!gpu||config.multiplier<2||config.multiplier>5)throw std::runtime_error("Apex Neural Rendering frame interpolation supports multipliers from 2 to 5");
  RSANROptions options{{sizeof(options),1,(__bridge void*)device,provider->directory.c_str(),(__bridge void*)device,reserve,release},config.modelPath.c_str()};RSGenerationResult result{};result.size=sizeof(result);result.version=1;context=provider->api->create(&options.base,&result);if(!context)throw std::runtime_error(result.reason);
 }
 ~Encoder(){if(context)provider->api->destroy(context);}
 const char*method()const noexcept override{return "anr";}
 bool requiresScene()const noexcept override{return true;}
 void setColorDescription(const ImageColorDescription&value)override{std::lock_guard guard(mutex);if(!value.valid()||value.range!=ColorRange::Full||value.transfer==ColorTransfer::HLG||value.primaries!=ColorPrimaries::BT709&&value.transfer==ColorTransfer::Linear)throw std::runtime_error("Apex Neural Rendering interpolation requires explicit sRGB, PQ or linear BT.709 color");colorDescription=value;}
 void setSceneOrigin(FrameOrigin value)override{std::lock_guard guard(mutex);origin=value;}
 void setScene(const RSTemporalFrame&value)override{std::lock_guard guard(mutex);scene=value;depth=(__bridge id<MTLTexture>)value.depth;motion=(__bridge id<MTLTexture>)value.motion;sceneCommands=(__bridge id<MTLCommandBuffer>)value.commandBuffer;}
 GenerationResult prepare(id<MTLCommandBuffer>commands,id<MTLTexture>color,const RSTemporalFrame*frame)override{
  std::lock_guard guard(mutex);GenerationResult result;if(!frame){result.reason="Apex Neural Rendering frame interpolation waits for original scene depth, motion and camera inputs";return result;}
  auto value=input(commands,color,frame);RSGenerationResult prepared{};prepared.size=sizeof(prepared);prepared.version=1;const auto code=provider->api->prepare(context,&value.base,&prepared);result=this->result(prepared,code);result.encoded=code==RS_GENERATION_OK;return result;
 }
 uint64_t imageBytes(unsigned,unsigned,const GenerationMeasure&)const override{return 0;}
 GenerationResult encode(id<MTLCommandBuffer>commands,id<MTLTexture>color,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases)override{
  std::lock_guard guard(mutex);GenerationResult rejected;if(sceneCommands!=commands||!depth||!motion){rejected.reason="Apex Neural Rendering frame interpolation requires the original scene for this exact command buffer";return rejected;}
  if(phases.count>4||outputs.size()!=phases.count){rejected.reason="Apex Neural Rendering frame interpolation supports up to four timeline phases";return rejected;}
  auto value=input(commands,color,&scene,sequence);value.base.count=phases.count;for(unsigned index=0;index<phases.count;++index){value.base.outputs[index]=(__bridge void*)outputs[index];value.base.phases[index]=phases.timestamps[index];}
  RSGenerationResult encoded{};encoded.size=sizeof(encoded);encoded.version=1;const auto code=provider->api->encode(context,&value.base,&encoded);sceneCommands=nil;depth=nil;motion=nil;return result(encoded,code);
 }
};
}
std::shared_ptr<GenerationEncoder>makeANRGenerationEncoder(id<MTLDevice>device,const LsfgConfig&config){return std::make_shared<Encoder>(device,config);}
}
