#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <stdint.h>
#include <stddef.h>

#define RS_WINE_VULKAN_SCENE_VERSION 1u
#define RS_WINE_VULKAN_SCENE_PROFILE 0x2630002fu
#define RS_WINE_VULKAN_SCENE_IMAGE_COUNT 21u
#define RS_WINE_VULKAN_ORIGINAL_OUTPUT_RETAINED 1u
enum RSWineVulkanSceneImageSlot {
    RS_WINE_SCENE_COLOR=0, RS_WINE_SCENE_DEPTH=1, RS_WINE_SCENE_MOTION=2,
    RS_WINE_SCENE_OUTPUT=3, RS_WINE_SCENE_EXPOSURE=4, RS_WINE_SCENE_REACTIVE=5,
    RS_WINE_SCENE_TRANSPARENCY=6, RS_WINE_SCENE_AOV_FIRST=7
};

/* Fixed-width PE/Unix data. Handles retain their Wine Vulkan meaning until
 * the matched Wine Unix owner resolves them. No native callback is serialized. */
typedef struct RSWineVulkanSceneImageV1 {
    uint64_t image;
    uint32_t aspect, mipLevel, arrayLayer, reserved;
} RSWineVulkanSceneImageV1;

typedef struct RSWineVulkanSceneFrameV1 {
    uint32_t method, flags, renderWidth, renderHeight, outputWidth, outputHeight;
    uint32_t maxRenderWidth, maxRenderHeight;
    uint32_t colorX, colorY, depthX, depthY, motionX, motionY, outputX, outputY;
    float jitterX, jitterY, motionScaleX, motionScaleY;
    float preExposure, sharpness, frameTimeMs, nearPlane, farPlane, verticalFov;
    uint32_t profile, reserved;
} RSWineVulkanSceneFrameV1;

typedef struct RSWineVulkanSceneColorV1 {
    uint32_t size, version, primaries, transfer, range, alpha;
    float referenceWhite, peakLuminance, blackLuminance, hlgSystemGamma;
    uint32_t flags, reserved;
} RSWineVulkanSceneColorV1;

typedef struct RSWineVulkanSceneRequestV1 {
    uint32_t size, version, profile, flags;
    uint64_t device, commandBuffer, ownerId, frameId, consumerId;
    double sourceTimeSeconds;
    uint32_t imageMask, colorKnown, reserved[2];
    RSWineVulkanSceneImageV1 images[RS_WINE_VULKAN_SCENE_IMAGE_COUNT];
    RSWineVulkanSceneFrameV1 frame;
    RSWineVulkanSceneColorV1 color;
} RSWineVulkanSceneRequestV1;

struct maclauncher_scene_record_params {
    uint64_t request;
    int32_t result;
    uint32_t reserved;
};

enum RSWineVulkanSceneContextOperation {
    RS_WINE_SCENE_CONTEXT_BEGIN=1, RS_WINE_SCENE_CONTEXT_RESET=2,
    RS_WINE_SCENE_CONTEXT_DESTROY=3, RS_WINE_SCENE_CONTEXT_UNREGISTER=4
};
/* Mutable fixed-width control, carried by the existing index674 parameter
 * layout with selector1. Old owned handlers reject that selector safely.
 * BEGIN returns native-issued generation/consumerId, RESET replaces them.
 * No original context pointer, callback or native address crosses PE/Unix. */
typedef struct RSWineVulkanSceneContextV1 {
    uint32_t size,version,profile,operation;
    uint64_t observerId,contextId,generation,device,consumerId;
    uint32_t reserved[2];
} RSWineVulkanSceneContextV1;
#ifdef _WIN32
#define RS_WINE_SCENE_CALL __stdcall
#else
#define RS_WINE_SCENE_CALL
#endif
typedef int32_t (RS_WINE_SCENE_CALL *RSWineVulkanSceneContextCall1)(RSWineVulkanSceneContextV1*);
typedef int32_t (RS_WINE_SCENE_CALL *RSWineVulkanSceneRecordCall1)(const RSWineVulkanSceneRequestV1*);
typedef uint32_t (RS_WINE_SCENE_CALL *RSWineVulkanSceneAPICall1)(void);
#undef RS_WINE_SCENE_CALL

#if defined(__cplusplus)
#define RS_WINE_SCENE_ASSERT static_assert
#else
#define RS_WINE_SCENE_ASSERT _Static_assert
#endif
RS_WINE_SCENE_ASSERT(sizeof(RSWineVulkanSceneImageV1) == 24, "Wine scene image layout");
RS_WINE_SCENE_ASSERT(sizeof(RSWineVulkanSceneFrameV1) == 112, "Wine scene scalar layout");
RS_WINE_SCENE_ASSERT(sizeof(RSWineVulkanSceneColorV1) == 48, "Wine scene color layout");
RS_WINE_SCENE_ASSERT(sizeof(RSWineVulkanSceneRequestV1) == 744, "Wine scene request layout");
RS_WINE_SCENE_ASSERT(offsetof(RSWineVulkanSceneRequestV1, images) == 80, "Wine scene image offset");
RS_WINE_SCENE_ASSERT(offsetof(RSWineVulkanSceneRequestV1, frame) == 584, "Wine scene scalar offset");
RS_WINE_SCENE_ASSERT(sizeof(struct maclauncher_scene_record_params) == 16, "Wine scene call layout");
RS_WINE_SCENE_ASSERT(sizeof(RSWineVulkanSceneContextV1) == 64, "Wine scene context layout");
#undef RS_WINE_SCENE_ASSERT

#ifdef WINE_UNIX_LIB
#include "macfx-shared/vulkan/native/scene-interop.h"

/* Installed by the native common consumer during preparation. acquire returns
 * a borrowed, already prepared frame lease. The bridge retains its callbacks
 * before recording; the actual translator owns subsequent GPU/abandon release. */
typedef struct RSWineVulkanSceneConsumerV1 {
    uint32_t size, version;
    uint64_t ownerId;
    void *owner;
    RSVulkanSceneCallbacksV1 callbacks;
    const RSSceneAovs *aovs;
    const RSSceneMatrices *matrices;
    const struct RSWineVulkanSceneDeviceV1 *device;
} RSWineVulkanSceneConsumerV1;

/* Resolved once during native consumer preparation, while the actual producer
 * owns its device. The per-frame path checks identities and uses these pointers. */
typedef struct RSWineVulkanSceneDeviceV1 {
    uint32_t size, version;
    uint64_t wineDevice;
    VkDevice device;
    PFN_rsMoltenVKSceneOperationAPI api;
    PFN_rsMoltenVKRecordSceneOperation record;
} RSWineVulkanSceneDeviceV1;

typedef struct RSWineVulkanSceneProviderV1 {
    uint32_t size, version, profile, reserved;
    uint64_t consumerId;
    void *storage;
    void (*retain)(void *storage);
    void (*release)(void *storage);
    int32_t (*acquire)(void *storage, const RSWineVulkanSceneRequestV1 *,
                       RSWineVulkanSceneConsumerV1 *);
} RSWineVulkanSceneProviderV1;

#ifdef __cplusplus
extern "C" {
#endif
uint32_t rsWineVulkanSceneNativeAPI(void);
int32_t rsWineVulkanSetSceneProvider1(const RSWineVulkanSceneProviderV1 *);
int32_t rsWineVulkanResolveSceneDevice1(uint64_t, RSWineVulkanSceneDeviceV1 *);
NTSTATUS maclauncher_scene_record64(void *);
NTSTATUS maclauncher_scene_record32(void *);
#ifdef __cplusplus
}
#endif
#endif
