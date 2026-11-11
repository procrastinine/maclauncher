// Copyright (c) MacLauncher contributors. MIT license.
// Five-export FidelityFX API proxy. Contexts, configuration, queries and all
// frame generation stay with the original library. When the game's device
// forwards MacLauncher temporal frames, an upscale dispatch is recorded as one
// frame and MacLauncher's selected upscaler writes its output: on Vulkan as a
// VkTemporalFrameInfoMVK in a vkCmdPipelineBarrier2 (vk_temporal_frame.h), on
// Direct3D 12 through VKD3D-Proton's ID3D12GraphicsCommandListMetalFX
// (vkd3d_metalfx.h). Otherwise the original dispatch runs. While the game's
// Graphics are off (graphics-state.hpp), every dispatch goes to the original,
// so the game looks as it does without MacLauncher; turning them on takes the
// next dispatch again. Each switch restarts the history of the implementation
// that takes over. Each backend's
// proxy is its own build: profile.hpp names the original library and sets
// MACLAUNCHER_FFX_BACKEND_VK for the Vulkan proxy.
#define NOMINMAX
#include "profile.hpp"
#include <windows.h>
#include <d3d12.h>
#include "capture.hpp"
#include "vkd3d_metalfx.h"
#if MACLAUNCHER_FFX_BACKEND_VK
#include "vk_temporal_frame.h"
#endif
#include "carrier.hpp"
#include "../graphics-state.hpp"
#include <atomic>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
namespace {
HMODULE selfModule=nullptr;
INIT_ONCE originalOnce=INIT_ONCE_STATIC_INIT;
HMODULE originalModule=nullptr;
BOOL CALLBACK loadOriginal(PINIT_ONCE,PVOID,PVOID*){
 wchar_t file[32768];const DWORD length=GetModuleFileNameW(selfModule,file,32768);if(!length||length>=32768)return TRUE;
 std::wstring name(file,length);const auto slash=name.find_last_of(L"\\/");if(slash==std::wstring::npos)return TRUE;
 name.resize(slash+1);name+=maclauncherOriginalLibrary;
 originalModule=LoadLibraryExW(name.c_str(),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);return TRUE;
}
template<class T>T original(const char*name){InitOnceExecuteOnce(&originalOnce,loadOriginal,nullptr,nullptr);return originalModule?reinterpret_cast<T>(GetProcAddress(originalModule,name)):nullptr;}
struct Context {
 maclauncher::fidelityfx::UpscaleContext metadata;
#if MACLAUNCHER_FFX_BACKEND_VK
 uint64_t identity=0,frames=0;
 PFN_vkCmdPipelineBarrier2 barrier=nullptr; // set when the device forwards temporal frames
#else
 ID3D12MetalFXScaler*scaler=nullptr;        // made at the first recorded upscale
#endif
 bool original=false; // the last dispatch went to the original while Graphics were off
 std::mutex lock;
};
std::mutex contextsLock;
std::unordered_map<ffxContext,std::shared_ptr<Context>>contexts;
std::shared_ptr<Context>lookup(ffxContext key)noexcept{try{std::lock_guard lock(contextsLock);const auto found=contexts.find(key);return found==contexts.end()?nullptr:found->second;}catch(...){return {};}}
std::shared_ptr<Context>forget(ffxContext key)noexcept{try{std::lock_guard lock(contextsLock);const auto found=contexts.find(key);if(found==contexts.end())return {};auto value=found->second;contexts.erase(found);return value;}catch(...){return {};}}
#if MACLAUNCHER_FFX_BACKEND_VK
// Temporal history belongs to the driver under the context's feature id. The
// tag keeps these ids apart from those of other producers on the same device.
constexpr uint64_t featureTag=0x4646580000000000ull; // "FFX"
std::atomic<uint64_t>nextContext{1};
// Ids of destroyed contexts wait for the next recorded frame, of any device.
std::mutex releasedLock;
uint64_t released[64];
uint32_t releasedCount=0;
// Whether driverInfo names the word, as VKD3D-Proton's MetalFX interface checks it.
bool names(const char*info,const char*word){
 const size_t length=std::strlen(word);
 for(auto found=std::strstr(info,word);found;found=std::strstr(found+1,word))
  if((found==info||found[-1]==' ')&&(!found[length]||found[length]==' '))return true;
 return false;
}
PFN_vkCmdPipelineBarrier2 carrierBarrier(const ffxCreateBackendVKDesc&backend){
 const HMODULE loader=GetModuleHandleW(L"vulkan-1.dll");if(!loader)return nullptr;
 const auto properties=reinterpret_cast<PFN_vkGetPhysicalDeviceProperties2>(GetProcAddress(loader,"vkGetPhysicalDeviceProperties2"));if(!properties)return nullptr;
 VkPhysicalDeviceDriverProperties driver{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRIVER_PROPERTIES};
 VkPhysicalDeviceProperties2 value{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2,&driver};
 properties(backend.vkPhysicalDevice,&value);driver.driverInfo[VK_MAX_DRIVER_INFO_SIZE-1]=0;
 if(!names(driver.driverInfo,"temporal-sr"))return nullptr;
 // A device without Vulkan 1.3 or VK_KHR_synchronization2 has neither entry point; its dispatches stay the original's.
 for(const char*name:{"vkCmdPipelineBarrier2","vkCmdPipelineBarrier2KHR"})
  if(const auto barrier=reinterpret_cast<PFN_vkCmdPipelineBarrier2>(backend.vkDeviceProcAddr(backend.vkDevice,name)))return barrier;
 return nullptr;
}
bool recordVulkan(Context&context,const ffxDispatchDescUpscale&dispatch){
 VKD3D_METALFX_TEMPORAL_DESC desc;
 if(!context.barrier||!maclauncher::fidelityfx::temporalDescription(context.metadata.create,dispatch,desc))return false;
 const auto image=[](ID3D12Resource*value){return reinterpret_cast<VkImage>(value);};
 VkTemporalFrameInfoMVK info{};VkTemporalFrameMasksInfoMVK masks{};
 vk_temporal_super_resolution(&info,&desc);
 info.images[TEMPORAL_COLOR]=image(desc.Color);info.images[TEMPORAL_DEPTH]=image(desc.Depth);
 info.images[TEMPORAL_MOTION]=image(desc.MotionVector);info.images[TEMPORAL_OUTPUT]=image(desc.Output);
 info.images[TEMPORAL_EXPOSURE]=image(desc.ExposureTexture);
 info.outputWidth=dispatch.upscaleSize.width;info.outputHeight=dispatch.upscaleSize.height;
 if(desc.ReactiveMask||desc.TransparencyMask){
  masks.sType=VK_STRUCTURE_TYPE_TEMPORAL_FRAME_MASKS_INFO_MVK;masks.reactive=image(desc.ReactiveMask);masks.transparency=image(desc.TransparencyMask);info.pNext=&masks;
 }
 info.featureId=featureTag|context.identity;info.frameId=++context.frames;
 uint64_t ids[64];
 {std::lock_guard lock(releasedLock);std::memcpy(ids,released,releasedCount*sizeof(*ids));info.releaseFeatureIdCount=releasedCount;releasedCount=0;}
 info.pReleaseFeatureIds=ids;
 VkMemoryBarrier2 barrier{VK_STRUCTURE_TYPE_MEMORY_BARRIER_2};
 barrier.srcStageMask=barrier.dstStageMask=VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT;
 barrier.srcAccessMask=barrier.dstAccessMask=VK_ACCESS_2_MEMORY_READ_BIT|VK_ACCESS_2_MEMORY_WRITE_BIT;
 VkDependencyInfo dependency{VK_STRUCTURE_TYPE_DEPENDENCY_INFO,&info};dependency.memoryBarrierCount=1;dependency.pMemoryBarriers=&barrier;
 const auto commands=static_cast<VkCommandBuffer>(dispatch.commandList);
 context.barrier(commands,&dependency);dependency.pNext=nullptr;context.barrier(commands,&dependency);
 return true;
}
#else
bool recordD3D12(Context&context,const ffxDispatchDescUpscale&dispatch){
 VKD3D_METALFX_TEMPORAL_DESC desc;
 if(!maclauncher::fidelityfx::temporalDescription(context.metadata.create,dispatch,desc))return false;
 ID3D12GraphicsCommandListMetalFX*list=nullptr;
 // Another Direct3D 12 implementation has no such interface; the original dispatch then runs.
 if(FAILED(static_cast<IUnknown*>(dispatch.commandList)->QueryInterface(IID_ID3D12GraphicsCommandListMetalFX,reinterpret_cast<void**>(&list)))||!list)return false;
 const bool recorded=list->lpVtbl->SupportsTemporalUpscale(list)&&SUCCEEDED(list->lpVtbl->TemporalUpscale(list,&desc,&context.scaler));
 list->lpVtbl->Release(list);return recorded;
}
#endif
bool record(Context&context,const ffxDispatchDescUpscale&dispatch){
#if MACLAUNCHER_FFX_BACKEND_VK
 return recordVulkan(context,dispatch);
#else
 return recordD3D12(context,dispatch);
#endif
}
}
BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,LPVOID){if(reason==DLL_PROCESS_ATTACH){selfModule=module;DisableThreadLibraryCalls(module);}return TRUE;}
extern "C" FFX_API_ENTRY ffxReturnCode_t ffxCreateContext(ffxContext*context,ffxCreateContextDescHeader*desc,const ffxAllocationCallbacks*callbacks){
 const auto call=original<PfnFfxCreateContext>("ffxCreateContext");if(!call)return FFX_API_RETURN_NO_PROVIDER;
 const auto result=call(context,desc,callbacks);
 if(result==FFX_API_RETURN_OK&&context&&*context)try{
  auto metadata=maclauncher::fidelityfx::captureContext(desc);if(!metadata.known)return result;
  auto next=std::make_shared<Context>();next->metadata=metadata;
#if MACLAUNCHER_FFX_BACKEND_VK
  next->identity=nextContext.fetch_add(1,std::memory_order_relaxed);
  if(!(next->barrier=carrierBarrier(metadata.vulkan)))return result;
#endif
  {std::lock_guard lock(contextsLock);contexts[*context]=std::move(next);}
  maclauncher::graphics::LiveState::start();
 }catch(...){}
 return result;
}
extern "C" FFX_API_ENTRY ffxReturnCode_t ffxDestroyContext(ffxContext*context,const ffxAllocationCallbacks*callbacks){
 const auto call=original<PfnFfxDestroyContext>("ffxDestroyContext");if(!call)return FFX_API_RETURN_NO_PROVIDER;
 const auto previous=context?*context:nullptr;const auto result=call(context,callbacks);
 if(result==FFX_API_RETURN_OK)if(const auto current=forget(previous)){
  std::lock_guard lock(current->lock);
#if MACLAUNCHER_FFX_BACKEND_VK
  if(current->frames&&current->barrier){std::lock_guard ids(releasedLock);if(releasedCount<64)released[releasedCount++]=featureTag|current->identity;}
#else
  if(current->scaler){current->scaler->lpVtbl->Destroy(current->scaler);current->scaler=nullptr;}
#endif
 }
 return result;
}
extern "C" FFX_API_ENTRY ffxReturnCode_t ffxConfigure(ffxContext*context,const ffxConfigureDescHeader*desc){
 const auto call=original<PfnFfxConfigure>("ffxConfigure");return call?call(context,desc):FFX_API_RETURN_NO_PROVIDER;
}
extern "C" FFX_API_ENTRY ffxReturnCode_t ffxQuery(ffxContext*context,ffxQueryDescHeader*desc){
 const auto call=original<PfnFfxQuery>("ffxQuery");return call?call(context,desc):FFX_API_RETURN_NO_PROVIDER;
}
extern "C" FFX_API_ENTRY ffxReturnCode_t ffxDispatch(ffxContext*context,const ffxDispatchDescHeader*desc){
 const auto call=original<PfnFfxDispatch>("ffxDispatch");if(!call)return FFX_API_RETURN_NO_PROVIDER;
 if(context&&desc&&desc->type==FFX_API_DISPATCH_DESC_TYPE_UPSCALE&&!desc->pNext)if(const auto current=lookup(*context))try{
  auto dispatch=*reinterpret_cast<const ffxDispatchDescUpscale*>(desc);
  std::lock_guard lock(current->lock);
  const bool active=maclauncher::graphics::LiveState::active(),switched=current->original==active;
  if(switched)dispatch.reset=true;
  if(!active){current->original=true;return call(context,&dispatch.header);}
  current->original=false;
  if(dispatch.commandList&&record(*current,dispatch))return FFX_API_RETURN_OK;
  return call(context,&dispatch.header);
 }catch(...){}
 return call(context,desc);
}
