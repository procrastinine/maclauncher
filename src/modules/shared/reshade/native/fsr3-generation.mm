// Copyright (c) MacLauncher contributors. MIT license.
#include "generation-provider.hpp"
#include "generation-provider.h"
#include "image-admission.hpp"
#include <dlfcn.h>
#include <filesystem>
#include <mutex>
#include <stdexcept>
namespace macfx {
namespace {
struct Module {
 void*library=nullptr;const RSGenerationProvider*api=nullptr;std::string directory;
 Module(){
  const char*configured=std::getenv("RESHADE_FSR3_GENERATION_LIBRARY");std::filesystem::path file;
  if(configured&&*configured)file=configured;else{Dl_info info{};if(!dladdr(reinterpret_cast<const void*>(&makeFSR3GenerationEncoder),&info)||!info.dli_fname)throw std::runtime_error("The graphics provider directory is unavailable");file=std::filesystem::path(info.dli_fname).parent_path()/"generation/fsr3/libmaclauncher-fsr3-generation.dylib";}
  if(!file.is_absolute())throw std::runtime_error("The frame-generation provider requires an absolute library path");
  library=dlopen(file.c_str(),RTLD_NOW|RTLD_LOCAL);if(!library){const char*error=dlerror();throw std::runtime_error(std::string("The AMD frame-generation provider is unavailable: ")+(error?:"unknown loader error"));}
  const auto get=reinterpret_cast<const RSGenerationProvider*(*)(uint32_t)>(dlsym(library,"rsGetGenerationProvider"));api=get?get(1):nullptr;
  if(!api||api->size<sizeof(*api)||api->version!=1||!api->create||!api->encode||!api->destroy||!api->prepare)throw std::runtime_error("The AMD frame-generation provider has an incompatible API");directory=file.parent_path();
 }
};
std::shared_ptr<Module>module(){static auto*loaded=new std::shared_ptr<Module>(std::make_shared<Module>());return *loaded;}
void*reserve(void*device,uint64_t bytes)noexcept{try{auto value=reserveImageBytes((__bridge id<MTLDevice>)device,bytes,0,"fsr3-generation-memory");value->commit();return new std::shared_ptr<ImageReservation>(std::move(value));}catch(...){return nullptr;}}
void release(void*token)noexcept{delete static_cast<std::shared_ptr<ImageReservation>*>(token);}
class Encoder final:public GenerationEncoder {
 id<MTLDevice>device;std::shared_ptr<Module>provider;void*context=nullptr;
 std::mutex mutex;RSTemporalFrame scene{};ImageColorDescription colorDescription;id<MTLTexture>depth=nil,motion=nil;__weak id<MTLCommandBuffer>sceneCommands=nil;
 RSGenerationSubmission input(id<MTLCommandBuffer>commands,id<MTLTexture>color,const RSTemporalFrame*frame,uint64_t sequence=0){RSGenerationSubmission value{};value.size=sizeof(value);value.version=1;value.commandBuffer=(__bridge void*)commands;value.color=(__bridge void*)color;value.sequence=sequence;value.transferFunction=colorDescription.transfer==ColorTransfer::PQ?1:colorDescription.transfer==ColorTransfer::Linear?2:0;value.minLuminance=colorDescription.blackLuminance;value.maxLuminance=colorDescription.transfer==ColorTransfer::SRGB?1:colorDescription.peakLuminance;value.scene=frame;return value;}
 GenerationResult result(const RSGenerationResult&value,int code){GenerationResult result;result.encoded=code==RS_GENERATION_OK&&value.encoded;result.ready=code==RS_GENERATION_OK&&value.ready;result.busy=code==RS_GENERATION_BUSY;result.frameId=value.sequence;result.generated=value.generated;result.historyFrames=value.historyFrames;result.reason=value.reason;return result;}
public:
 Encoder(id<MTLDevice>gpu,const LsfgConfig&config):device(gpu),provider(module()){
  if(!gpu||config.multiplier!=2)throw std::runtime_error("AMD frame interpolation produces one midpoint between original scene frames");
  RSGenerationOptions options{sizeof(options),1,(__bridge void*)device,provider->directory.c_str(),(__bridge void*)device,reserve,release};RSGenerationResult result{};result.size=sizeof(result);result.version=1;context=provider->api->create(&options,&result);if(!context)throw std::runtime_error(result.reason);
 }
 ~Encoder(){if(context)provider->api->destroy(context);}
 const char*method()const noexcept override{return "fsr3";}
 bool requiresScene()const noexcept override{return true;}
 void setColorDescription(const ImageColorDescription&value)override{std::lock_guard guard(mutex);if(!value.valid()||value.transfer==ColorTransfer::HLG||value.primaries!=ColorPrimaries::BT709&&value.transfer==ColorTransfer::Linear)throw std::runtime_error("AMD interpolation requires explicit sRGB, PQ or linear BT.709 color");colorDescription=value;}
 void setScene(const RSTemporalFrame&value)override{std::lock_guard guard(mutex);scene=value;depth=(__bridge id<MTLTexture>)value.depth;motion=(__bridge id<MTLTexture>)value.motion;sceneCommands=(__bridge id<MTLCommandBuffer>)value.commandBuffer;}
 GenerationResult prepare(id<MTLCommandBuffer>commands,id<MTLTexture>color,const RSTemporalFrame*frame)override{
  GenerationResult result;if(!frame){result.reason="AMD frame interpolation waits for original scene depth, motion and camera inputs";return result;}
  auto value=input(commands,color,frame);RSGenerationResult prepared{};prepared.size=sizeof(prepared);prepared.version=1;const auto code=provider->api->prepare(context,&value,&prepared);result=this->result(prepared,code);result.encoded=code==RS_GENERATION_OK;return result;
 }
 uint64_t imageBytes(unsigned,unsigned,const GenerationMeasure&)const override{return 0;}
 GenerationResult encode(id<MTLCommandBuffer>commands,id<MTLTexture>color,const std::vector<id<MTLTexture>>&outputs,uint64_t sequence,const InterpolationPlan&phases)override{
  std::lock_guard guard(mutex);GenerationResult rejected;if(sceneCommands!=commands||!depth||!motion){rejected.reason="AMD frame interpolation requires the original scene for this exact command buffer";return rejected;}
  if(phases.count>1||outputs.size()!=phases.count){rejected.reason="AMD frame interpolation supports one midpoint phase";return rejected;}
  auto value=input(commands,color,&scene,sequence);value.count=phases.count;for(unsigned index=0;index<phases.count;++index){value.outputs[index]=(__bridge void*)outputs[index];value.phases[index]=phases.timestamps[index];}
  RSGenerationResult encoded{};encoded.size=sizeof(encoded);encoded.version=1;const auto code=provider->api->encode(context,&value,&encoded);sceneCommands=nil;depth=nil;motion=nil;return result(encoded,code);
 }
};
}
std::shared_ptr<GenerationEncoder>makeFSR3GenerationEncoder(id<MTLDevice>device,const LsfgConfig&config){return std::make_shared<Encoder>(device,config);}
}
