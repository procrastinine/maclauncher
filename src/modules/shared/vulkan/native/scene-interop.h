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
#if __has_include("recorded-scene.h")
#include "recorded-scene.h"
#elif __has_include("macfx-temporal/recorded-scene.h")
#include "macfx-temporal/recorded-scene.h"
#else
#include "../../reshade/native/recorded-scene.h"
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

// API3 explicitly accepts operation version3/size below, with native callback
// version3. Only this tail is new; API1/API2 operations keep their exact bytes.
// Encoding remains RSVulkanSceneEncodingV2. Old readers reject rather than
// receiving a larger callback table through an unnegotiated interface.
typedef struct RSVulkanSceneOperationV3 {
    RSVulkanSceneOperationV1 base;
    void (*submitted)(void* storage,uint64_t frameId,const RSTemporalResult*,
                      uint32_t accepted,void* metalSharedEvent,uint64_t value);
} RSVulkanSceneOperationV3;

// Driver-neutral operation packets retain the V1 layout. API 1 negotiates
// classic callback/encoding V1; API 2 requires explicitly negotiated callback V2
// and native encoding V2 with genuine Metal4 commands, queue and flight lease.
// Unknown versions retain the original output; no callback version is inferred
// from symbol presence. The legacy Molten names continue to report API 1.
uint32_t rsVulkanSceneOperationAPI(void);
uint32_t rsVulkanSceneStagingAPI(void);
VkResult rsVulkanRecordSceneOperation(VkCommandBuffer,const RSVulkanSceneOperationV1*);
// Resource-free selected-provider query on the actual native Vulkan device.
// The driver supplies the native Metal device; no images, commands or output
// admission are created. The callback type comes from recorded-scene.h.
int rsVulkanQuerySceneFeature3(VkDevice,void* featureOwner,uint32_t feature,
    const RSTemporalFrame*,RSQueryRecordedSceneFeature3,RSTemporalResult*);
typedef int (*PFN_rsVulkanQuerySceneFeature3)(VkDevice,void*,uint32_t,
    const RSTemporalFrame*,RSQueryRecordedSceneFeature3,RSTemporalResult*);
// Resource-only preparation on this actual native Vulkan device. The callback
// type and generation submission come from the common recorded-scene header.
// Reconstruction passes null generation metadata and output bindings. Success
// returns an owned admission with encoded unset, never an evaluated SDK output.
int rsVulkanPrepareSceneOperation3(VkDevice,const RSVulkanSceneOperationV1*,
    void* featureOwner,uint32_t feature,const struct RSGenerationSubmission*,
    const RSVulkanSceneImageV1* generationOutputs,RSPrepareRecordedSceneOperation3,
    RSRecordedSceneConsumerV3*,RSTemporalResult*);
typedef int (*PFN_rsVulkanPrepareSceneOperation3)(VkDevice,const RSVulkanSceneOperationV1*,
    void*,uint32_t,const struct RSGenerationSubmission*,const RSVulkanSceneImageV1*,
    RSPrepareRecordedSceneOperation3,RSRecordedSceneConsumerV3*,RSTemporalResult*);
typedef uint32_t (*PFN_rsVulkanSceneOperationAPI)(void);
typedef uint32_t (*PFN_rsVulkanSceneStagingAPI)(void);
typedef VkResult (*PFN_rsVulkanRecordSceneOperation)(VkCommandBuffer,const RSVulkanSceneOperationV1*);

// Existing immutable MoltenVK packages keep their original exports.
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
