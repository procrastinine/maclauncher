// Copyright (c) MacLauncher contributors. MIT license.
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include "wine-observer.hpp"
#include "scalar-mapping.hpp"
#include "../vulkan/scene-request.h"
#include <atomic>
#include <memory>
#include <mutex>
#include <unordered_map>

namespace maclauncher::fidelityfx {
namespace {
struct Context {
 void*original=nullptr;
 uint64_t device=0,generation=0,consumerId=0,lastContent=0;
 bool retired=false,resetPending=false;
};
struct Storage {
 std::atomic<unsigned>references{1};
 HMODULE module;
 RSWineVulkanSceneContextCall1 control;
 RSWineVulkanSceneRecordCall1 record;
 uint64_t identity;
 std::mutex lock;
 std::unordered_map<uint64_t,Context>contexts;
 bool disabled=false;
 Storage(HMODULE m,RSWineVulkanSceneContextCall1 c,RSWineVulkanSceneRecordCall1 r,uint64_t id):module(m),control(c),record(r),identity(id){}
 RSWineVulkanSceneContextV1 request(uint32_t operation,uint64_t contextId=0,const Context*context=nullptr)const{
  RSWineVulkanSceneContextV1 value{};value.size=sizeof(value);value.version=RS_WINE_VULKAN_SCENE_VERSION;
  value.profile=RS_WINE_VULKAN_SCENE_PROFILE;value.operation=operation;value.observerId=identity;value.contextId=contextId;
  if(context){value.device=context->device;value.generation=context->generation;value.consumerId=context->consumerId;}
  return value;
 }
 void unregister()noexcept{auto value=request(RS_WINE_SCENE_CONTEXT_UNREGISTER);try{control(&value);}catch(...){}}
 ~Storage(){unregister();FreeLibrary(module);}
 void retire(uint64_t contextId,Context&context)noexcept{
  context.retired=true;
  if(context.generation&&context.consumerId){auto value=request(RS_WINE_SCENE_CONTEXT_DESTROY,contextId,&context);try{control(&value);}catch(...){}}
  context.generation=context.consumerId=0;
 }
 bool prepare(uint64_t contextId,Context&context,bool reset){
  if(reset)context.resetPending=true;
  if(context.generation&&!context.resetPending)return true;
  const bool beginning=!context.generation;
  auto value=request(beginning?RS_WINE_SCENE_CONTEXT_BEGIN:RS_WINE_SCENE_CONTEXT_RESET,contextId,&context);
  if(control(&value)!=VK_SUCCESS)return false;
  if(value.size!=sizeof(value)||value.version!=RS_WINE_VULKAN_SCENE_VERSION||
     value.profile!=RS_WINE_VULKAN_SCENE_PROFILE||value.operation!=(beginning?RS_WINE_SCENE_CONTEXT_BEGIN:RS_WINE_SCENE_CONTEXT_RESET)||
     value.observerId!=identity||value.contextId!=contextId||value.device!=context.device||
     value.reserved[0]||value.reserved[1]||!value.generation||!value.consumerId){
   // An invalid token reply grants no recording authority. Retire the whole
   // observer identity so no partially accepted native owner is stranded.
   disabled=true;unregister();return false;
  }
  context.generation=value.generation;context.consumerId=value.consumerId;context.resetPending=false;return true;
 }
};
uint64_t handleBits(const void*value){return static_cast<uint64_t>(reinterpret_cast<uintptr_t>(value));}
bool image(RSWineVulkanSceneRequestV1&request,unsigned slot,const FfxApiResource&source,bool depth=false){
 if(!source.resource)return false;
 const auto&description=source.description;
 if(description.type!=FFX_API_RESOURCE_TYPE_TEXTURE2D||!description.width||!description.height||description.depth!=1)return false;
 const bool depthTarget=description.usage&FFX_API_RESOURCE_USAGE_DEPTHTARGET;
 if((!depth&&depthTarget)||(!depthTarget&&(description.usage&FFX_API_RESOURCE_USAGE_STENCILTARGET)))return false;
 auto&target=request.images[slot];
 // The public SDK's ffxApiGetResourceVK stores the VkImage value directly in
 // resource.resource. It is never dereferenced or treated as a native pointer.
 target.image=handleBits(source.resource);target.aspect=depthTarget?VK_IMAGE_ASPECT_DEPTH_BIT:VK_IMAGE_ASPECT_COLOR_BIT;
 request.imageMask|=1u<<slot;return true;
}
void ML_FFX_CALL retain(void*storage){static_cast<Storage*>(storage)->references.fetch_add(1,std::memory_order_relaxed);}
void ML_FFX_CALL release(void*storage){auto*value=static_cast<Storage*>(storage);if(value->references.fetch_sub(1,std::memory_order_acq_rel)==1)delete value;}
void ML_FFX_CALL observed(void*storage,const MLFfxUpscaleObservationV1*source){
 if(!source||source->size!=sizeof(*source)||source->version!=1||!source->originalContext||!source->contextId||!source->contentId||
    source->create.header.type!=FFX_API_CREATE_CONTEXT_DESC_TYPE_UPSCALE||source->create.header.pNext||
    source->backend.header.type!=FFX_API_CREATE_CONTEXT_DESC_TYPE_BACKEND_VK||source->backend.header.pNext||
    !source->backend.vkDevice||!source->backend.vkPhysicalDevice||!source->backend.vkDeviceProcAddr||!source->dispatch.commandList)return;
 RSWineVulkanSceneRequestV1 request{};request.size=sizeof(request);request.version=RS_WINE_VULKAN_SCENE_VERSION;
 request.profile=RS_WINE_VULKAN_SCENE_PROFILE;request.flags=RS_WINE_VULKAN_ORIGINAL_OUTPUT_RETAINED;
 request.device=handleBits(source->backend.vkDevice);request.commandBuffer=handleBits(source->dispatch.commandList);request.frameId=source->contentId;
 if(!mapUpscaleScalars(source->create,source->dispatch,request.frame)||
    !image(request,RS_WINE_SCENE_COLOR,source->dispatch.color)||!image(request,RS_WINE_SCENE_OUTPUT,source->dispatch.output))return;
 image(request,RS_WINE_SCENE_DEPTH,source->dispatch.depth,true);image(request,RS_WINE_SCENE_MOTION,source->dispatch.motionVectors);
 image(request,RS_WINE_SCENE_EXPOSURE,source->dispatch.exposure);image(request,RS_WINE_SCENE_REACTIVE,source->dispatch.reactive);
 image(request,RS_WINE_SCENE_TRANSPARENCY,source->dispatch.transparencyAndComposition);
 // FFx has no absolute source PTS or complete color description. Zero remains
 // unknown here; the common native service supplies its own processing time.
 auto&value=*static_cast<Storage*>(storage);std::lock_guard lock(value.lock);
 if(value.disabled)return;
 auto [entry,inserted]=value.contexts.try_emplace(source->contextId);auto&context=entry->second;
 if(inserted){context.original=source->originalContext;context.device=request.device;}
 if(context.retired)return;
 if(context.original!=source->originalContext||context.device!=request.device){value.retire(source->contextId,context);return;}
 if(source->contentId<=context.lastContent)return;
 context.lastContent=source->contentId;
 if(!value.prepare(source->contextId,context,source->dispatch.reset))return;
 request.ownerId=context.generation;request.consumerId=context.consumerId;
 // Only this PE-to-Wine function is called. Native PFNs and callbacks are
 // resolved and retained by the matched Unix/native owners after unwrapping.
 value.record(&request);
}
void ML_FFX_CALL destroyed(void*storage,uint64_t contextId,void*originalContext){
 if(!contextId||!originalContext)return;
 auto&value=*static_cast<Storage*>(storage);std::lock_guard lock(value.lock);
 auto [entry,inserted]=value.contexts.try_emplace(contextId);auto&context=entry->second;
 if(inserted)context.original=originalContext;
 if(context.original==originalContext&&!context.retired)value.retire(contextId,context);
}
}
bool createWineObserver(MLFfxObserverV1&result)noexcept{
 HMODULE module=nullptr;
 try{
  // Acquiring the loaded PE module keeps its call targets valid until explicit
  // observer release. This bootstrap is never invoked from DllMain.
  if(!GetModuleHandleExW(0,L"winevulkan.dll",&module))return false;
  const auto api=reinterpret_cast<RSWineVulkanSceneAPICall1>(GetProcAddress(module,"MacLauncherWineVulkanSceneAPI1"));
  const auto control=reinterpret_cast<RSWineVulkanSceneContextCall1>(GetProcAddress(module,"MacLauncherWineVulkanSceneContext1"));
  const auto record=reinterpret_cast<RSWineVulkanSceneRecordCall1>(GetProcAddress(module,"MacLauncherWineVulkanRecordScene1"));
  if(!api||!control||!record||api()!=RS_WINE_VULKAN_SCENE_VERSION){FreeLibrary(module);return false;}
  uint64_t identity=0;
  if(BCryptGenRandom(nullptr,reinterpret_cast<PUCHAR>(&identity),sizeof(identity),BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0||!identity){FreeLibrary(module);return false;}
  auto storage=std::make_unique<Storage>(module,control,record,identity);
  result={sizeof(result),1,storage.get(),retain,release,observed,destroyed};storage.release();return true;
 }catch(...){if(module)FreeLibrary(module);return false;}
}
}
