// Copyright (c) MacLauncher contributors. MIT license.
#include "recorded-source.hpp"
#include "scalar-mapping.hpp"
#include <cmath>
namespace maclauncher::fidelityfx {
VkResult recordNativeUpscale(const UpscaleDispatch&source,const NativeUpscaleBinding&binding){
 if(binding.size!=sizeof(binding)||binding.version!=1)return VK_ERROR_FEATURE_NOT_PRESENT;
 if(binding.originalResult!=FFX_API_RETURN_OK||!source.contentId||!source.context.vulkan||!binding.commands||!binding.api||!binding.record||binding.api()!=1)return VK_ERROR_FEATURE_NOT_PRESENT;
 const auto&create=source.context.create;const auto&dispatch=source.dispatch;
 if(dispatch.header.type!=FFX_API_DISPATCH_DESC_TYPE_UPSCALE||dispatch.header.pNext||!binding.identity.owner||binding.identity.size!=sizeof(RSTemporalFrame)||binding.identity.version!=1)return VK_ERROR_FEATURE_NOT_PRESENT;
 const auto&images=binding.images;
 if(!images[RS_VULKAN_SCENE_COLOR].image||!images[RS_VULKAN_SCENE_OUTPUT].image)return VK_ERROR_FEATURE_NOT_PRESENT;
 if(!std::isfinite(binding.sourceTimeSeconds)||binding.sourceTimeSeconds<0)return VK_ERROR_FEATURE_NOT_PRESENT;
 RSVulkanSceneOperationV1 operation{};operation.size=sizeof(operation);operation.version=1;operation.flags=RS_VULKAN_SCENE_ORIGINAL_OUTPUT_RETAINED;operation.imageMask=binding.imageMask;
 auto&frame=operation.frame;frame=binding.identity;frame.frameId=binding.identity.frameId?binding.identity.frameId:source.contentId;
 // Actual native image and command objects are resolved only by the driver.
 // FFX's opaque resource pointers and Wine dispatchable handles never cross.
 frame.commandBuffer=nullptr;frame.color=frame.depth=frame.motion=frame.output=frame.exposure=frame.reactive=frame.transparency=nullptr;frame.commandBufferKind=0;
 if(!mapUpscaleScalars(create,dispatch,frame))return VK_ERROR_FEATURE_NOT_PRESENT;
 for(unsigned i=0;i<RS_VULKAN_SCENE_IMAGE_COUNT;++i)operation.images[i]=images[i];
 operation.color=binding.color;operation.aovs=binding.aovs;operation.matrices=binding.matrices;operation.sourceTimeSeconds=binding.sourceTimeSeconds;operation.callbacks=binding.callbacks;
 return binding.record(binding.commands,&operation);
}
}
extern "C" uint32_t rsFidelityFXNativeSourceAPI(void){return 1;}
extern "C" VkResult rsFidelityFXRecordNativeUpscale1(const ffxCreateContextDescUpscale*create,const ffxCreateBackendVKDesc*backend,const ffxDispatchDescUpscale*dispatch,const RSFfxVulkanBindingV1*binding){
 if(!create||!backend||!dispatch||!binding||binding->size!=sizeof(*binding)||binding->version!=1||create->header.pNext||backend->header.pNext)return VK_ERROR_FEATURE_NOT_PRESENT;
 // Copies preserve all original scalar/callback fields. No game-owned chain
 // is edited and no PE handle or resource pointer is interpreted as native.
 auto creation=*create;auto native=*backend;creation.header.pNext=&native.header;
 auto context=maclauncher::fidelityfx::captureContext(&creation.header);maclauncher::fidelityfx::UpscaleDispatch source;
 if(!maclauncher::fidelityfx::captureDispatch(context,&dispatch->header,binding->contentId,source))return VK_ERROR_FEATURE_NOT_PRESENT;
 return maclauncher::fidelityfx::recordNativeUpscale(source,*binding);
}
