#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <ffx_api/ffx_upscale.h>
#include <ffx_api/vk/ffx_api_vk.h>
#include <array>
#include <cmath>
namespace maclauncher::fidelityfx {
struct UpscaleContext {
 ffxCreateContextDescUpscale create{};
 ffxCreateBackendVKDesc backend{};
 uint64_t dispatchOrdinal=0;
 bool vulkan=false,known=false;
};
inline UpscaleContext captureContext(const ffxCreateContextDescHeader*header){
 UpscaleContext value;bool upscale=false,backend=false;std::array<const ffxApiHeader*,64>seen{};unsigned count=0;
 for(auto next=header;next;next=next->pNext){
  if(count==seen.size())return {};for(unsigned i=0;i<count;++i)if(seen[i]==next)return {};seen[count++]=next;
  switch(next->type){
   case FFX_API_CREATE_CONTEXT_DESC_TYPE_UPSCALE:if(upscale)return {};value.create=*reinterpret_cast<const ffxCreateContextDescUpscale*>(next);value.create.header.pNext=nullptr;upscale=true;break;
   case FFX_API_CREATE_CONTEXT_DESC_TYPE_BACKEND_VK:if(backend)return {};value.backend=*reinterpret_cast<const ffxCreateBackendVKDesc*>(next);value.backend.header.pNext=nullptr;backend=true;break;
   case FFX_API_DESC_TYPE_OVERRIDE_VERSION:break; // Genuine provider selection remains owned by the original API.
   default:return {}; // Unknown extensions still forward unchanged; optional observation declines.
  }
 }
 value.known=upscale&&backend;value.vulkan=value.known&&value.backend.vkDevice&&value.backend.vkPhysicalDevice&&value.backend.vkDeviceProcAddr;return value;
}
struct UpscaleDispatch {
 UpscaleContext context;
 ffxDispatchDescUpscale dispatch{};
 // Successful original dispatch identity, not an invented renderer clock.
 uint64_t contentId=0;
};
inline bool captureDispatch(const UpscaleContext&context,const ffxDispatchDescHeader*header,uint64_t contentId,UpscaleDispatch&value){
 if(!context.known||!context.vulkan||!header||header->type!=FFX_API_DISPATCH_DESC_TYPE_UPSCALE||header->pNext||!contentId)return false;
 const auto&source=*reinterpret_cast<const ffxDispatchDescUpscale*>(header);
 if(!source.commandList||!source.renderSize.width||!source.renderSize.height||source.renderSize.width>context.create.maxRenderSize.width||source.renderSize.height>context.create.maxRenderSize.height)return false;
 value.context=context;value.dispatch=source;value.dispatch.header.pNext=nullptr;value.contentId=contentId;return true;
}
}
