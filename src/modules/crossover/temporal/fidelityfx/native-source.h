#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#ifdef __cplusplus
#include <ffx_api/ffx_upscale.h>
#include <ffx_api/vk/ffx_api_vk.h>
#else
#include <stddef.h>
#include <ffx_api/ffx_api.h>
// SDK descriptor structs are opaque to C callers; C++ keeps the full headers.
struct ffxCreateContextDescUpscale;
struct ffxCreateBackendVKDesc;
struct ffxDispatchDescUpscale;
#endif
#include "scene-interop.h"
#ifdef __cplusplus
extern "C" {
#endif
// Native Vulkan handles/callbacks only. A Wine Unix owner must explicitly
// unwrap its PE handles before invoking this API. Original output is retained.
typedef struct RSFfxVulkanBindingV1 {
 uint32_t size,version;
 uint64_t contentId;
 RSTemporalFrame identity;
 VkCommandBuffer commands;
 RSVulkanSceneImageV1 images[RS_VULKAN_SCENE_IMAGE_COUNT];
 uint32_t imageMask;
 const struct RSImageColorDescription*color;
 const RSSceneAovs*aovs;
 const RSSceneMatrices*matrices;
 double sourceTimeSeconds;
 RSVulkanSceneCallbacksV1 callbacks;
 PFN_rsMoltenVKSceneOperationAPI api;
 PFN_rsMoltenVKRecordSceneOperation record;
 ffxReturnCode_t originalResult;
} RSFfxVulkanBindingV1;
uint32_t rsFidelityFXNativeSourceAPI(void);
VkResult rsFidelityFXRecordNativeUpscale1(const struct ffxCreateContextDescUpscale*,
 const struct ffxCreateBackendVKDesc*,const struct ffxDispatchDescUpscale*,const RSFfxVulkanBindingV1*);
#ifdef __cplusplus
}
#endif
