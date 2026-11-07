#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// The Vulkan and Direct3D 12 FidelityFX headers declare the same frame
// generation swapchain keys, so each proxy compiles with its own backend's
// header: MACLAUNCHER_FFX_BACKEND_VK (profile.hpp) selects Vulkan.
#include <ffx_api/ffx_upscale.h>
#if MACLAUNCHER_FFX_BACKEND_VK
#include <ffx_api/vk/ffx_api_vk.h>
#else
#include <ffx_api/dx12/ffx_api_dx12.h>
#endif
#include <array>
namespace maclauncher::fidelityfx {
// An upscale context's creation values and, for Vulkan, its device.
struct UpscaleContext {
 ffxCreateContextDescUpscale create{};
#if MACLAUNCHER_FFX_BACKEND_VK
 ffxCreateBackendVKDesc vulkan{};
#endif
 bool known=false;
};
inline UpscaleContext captureContext(const ffxCreateContextDescHeader*header){
 UpscaleContext value;bool upscale=false,backend=false,device=false;std::array<const ffxApiHeader*,64>seen{};unsigned count=0;
 for(auto next=header;next;next=next->pNext){
  if(count==seen.size())return {};for(unsigned i=0;i<count;++i)if(seen[i]==next)return {};seen[count++]=next;
  switch(next->type){
   case FFX_API_CREATE_CONTEXT_DESC_TYPE_UPSCALE:if(upscale)return {};value.create=*reinterpret_cast<const ffxCreateContextDescUpscale*>(next);value.create.header.pNext=nullptr;upscale=true;break;
#if MACLAUNCHER_FFX_BACKEND_VK
   case FFX_API_CREATE_CONTEXT_DESC_TYPE_BACKEND_VK:if(backend)return {};value.vulkan=*reinterpret_cast<const ffxCreateBackendVKDesc*>(next);value.vulkan.header.pNext=nullptr;
    device=value.vulkan.vkDevice&&value.vulkan.vkPhysicalDevice&&value.vulkan.vkDeviceProcAddr;backend=true;break;
#else
   case FFX_API_CREATE_CONTEXT_DESC_TYPE_BACKEND_DX12:if(backend)return {};device=reinterpret_cast<const ffxCreateBackendDX12Desc*>(next)->device!=nullptr;backend=true;break;
#endif
   case FFX_API_DESC_TYPE_OVERRIDE_VERSION:break; // The original library selects its provider.
   default:return {}; // Other extensions reach the original unchanged; its dispatches stay its own.
  }
 }
 value.known=upscale&&backend&&device;return value;
}
}
