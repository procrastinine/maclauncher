#pragma once
#ifndef MACFX_VULKAN_SCENE_INTEROP_H
#define MACFX_VULKAN_SCENE_INTEROP_H
// Copyright (c) MacLauncher contributors. MIT license.
#include <stdint.h>
#include <vulkan/vulkan.h>
#if __has_include("vulkan-scene.h")
#include "vulkan-scene.h"
#elif __has_include("macfx-temporal/vulkan-scene.h")
#include "macfx-temporal/vulkan-scene.h"
#else
#include "../../reshade/native/vulkan-scene.h"
#endif
#ifdef __cplusplus
extern "C" {
#endif
struct RSVulkanSceneImageV1 {
    VkImage image;
    VkImageAspectFlags aspect;
    uint32_t mipLevel, arrayLayer;
};

enum RSVulkanSceneOperationFlags {
    // V1 retains the original producer's complete output. A queued operation
    // never authorizes omission of original SDK rendering or presentation.
    RS_VULKAN_SCENE_ORIGINAL_OUTPUT_RETAINED=1,
    // Only callbacks from rsCreateVulkanSceneBoundary1 may request untracked
    // images. Query the optional staging capability before setting this bit.
    RS_VULKAN_SCENE_PREPARED_TRACKED_BOUNDARY=2
};
typedef struct RSVulkanSceneOperationV1 {
    uint32_t size, version, flags, imageMask;
    // Scalar metadata is copied. Native resource/command pointers must be null;
    // images below are real handles for this exact native Vulkan device.
    RSTemporalFrame frame;
    // Prepared consumer resource mask. Zero means color/output only. Other
    // information remains provenance without requiring native applicability.
    RSVulkanSceneImageV1 images[RS_VULKAN_SCENE_IMAGE_COUNT];
    // Null means unknown. SDK HDR flags and VkFormat never establish source
    // primaries/reference white/alpha, nor does a different AOV color domain.
    const struct RSImageColorDescription* color;
    const RSSceneAovs* aovs;
    const RSSceneMatrices* matrices;
    double sourceTimeSeconds;
    RSVulkanSceneCallbacksV1 callbacks;
} RSVulkanSceneOperationV1;

uint32_t rsMoltenVKSceneOperationAPI(void);
uint32_t rsMoltenVKSceneStagingAPI(void);
// VK_SUCCESS means recorded only. Unknown/unready operations preserve original
// Vulkan work. Resolve from the actual ICD, after Wine handle unwrapping where
// applicable; Wine dispatchable handles are not native Vulkan handles.
VkResult rsMoltenVKRecordSceneOperation(VkCommandBuffer,
                                      const RSVulkanSceneOperationV1*);
typedef uint32_t (*PFN_rsMoltenVKSceneOperationAPI)(void);
typedef uint32_t (*PFN_rsMoltenVKSceneStagingAPI)(void);
typedef VkResult (*PFN_rsMoltenVKRecordSceneOperation)(VkCommandBuffer,
                                                   const RSVulkanSceneOperationV1*);
#ifdef __cplusplus
}
#endif
#endif
