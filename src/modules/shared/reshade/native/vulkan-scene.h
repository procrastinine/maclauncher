#pragma once
#ifndef MACFX_VULKAN_SCENE_NATIVE_H
#define MACFX_VULKAN_SCENE_NATIVE_H
// Copyright (c) MacLauncher contributors. MIT license.
#include <stdint.h>
#if __has_include("temporal-frame.h")
#include "temporal-frame.h"
#include "temporal-scene-aovs.h"
#include "temporal-scene-matrices.h"
#elif __has_include("macfx-temporal/frame.h")
#include "macfx-temporal/frame.h"
#include "macfx-temporal/scene-aovs.h"
#include "macfx-temporal/scene-matrices.h"
#else
#include "../temporal/frame.h"
#include "../temporal/scene-aovs.h"
#include "../temporal/scene-matrices.h"
#endif
#ifdef __cplusplus
extern "C" {
#endif
struct RSImageColorDescription;
typedef struct RSVulkanSceneImageV1 RSVulkanSceneImageV1;
enum RSVulkanSceneImageSlot {
    RS_VULKAN_SCENE_COLOR=0, RS_VULKAN_SCENE_DEPTH=1,
    RS_VULKAN_SCENE_MOTION=2, RS_VULKAN_SCENE_OUTPUT=3,
    RS_VULKAN_SCENE_EXPOSURE=4, RS_VULKAN_SCENE_REACTIVE=5,
    RS_VULKAN_SCENE_TRANSPARENCY=6,
    RS_VULKAN_SCENE_AOV_FIRST=7,
    RS_VULKAN_SCENE_IMAGE_COUNT=RS_VULKAN_SCENE_AOV_FIRST+RS_SCENE_AOV_COUNT
};
enum RSVulkanSceneEncoderKind {
    RS_VULKAN_SCENE_COMPUTE_ENCODER=0, RS_VULKAN_SCENE_BLIT_ENCODER=1
};
// Translator-owned dependencies, borrowed only inside encode. End every owned
// encoder before returning; never submit or wait for a command buffer.
typedef struct RSVulkanSceneDependenciesV1 {
    void* scope;
    void (*before)(void* scope, void* metalEncoder, uint32_t kind);
    void (*after)(void* scope, void* metalEncoder, uint32_t kind);
} RSVulkanSceneDependenciesV1;
typedef struct RSVulkanSceneEncodingV1 {
    uint32_t size, version;
    RSTemporalFrame frame;
    const struct RSImageColorDescription* color;
    const RSSceneAovs* aovs;
    const RSSceneMatrices* matrices;
    double sourceTimeSeconds;
    RSVulkanSceneDependenciesV1 dependencies;
    const RSVulkanSceneImageV1* images;
    uint32_t imageMask;
} RSVulkanSceneEncodingV1;
enum RSVulkanSceneCompletion {
    RS_VULKAN_SCENE_GPU_COMPLETED=0,
    RS_VULKAN_SCENE_GPU_FAILED=1,
    RS_VULKAN_SCENE_ABANDONED=2
};
typedef struct RSVulkanSceneCallbacksV1 {
    uint32_t size, version;
    void* storage;
    void (*retain)(void* storage);
    void (*release)(void* storage);
    int (*encode)(void* storage, const RSVulkanSceneEncodingV1*, RSTemporalResult*);
    void (*completed)(void* storage, uint64_t frameId, uint32_t completion,
                      const RSTemporalResult*);
} RSVulkanSceneCallbacksV1;
// Returns one owned reference in output. The caller releases it through the
// returned callback table. The adapter retains consumer until its last owner
// retires. Creation prepares no device resources and advances no frame state.
int rsCreateVulkanSceneBoundary1(const RSVulkanSceneCallbacksV1* consumer,
                               RSVulkanSceneCallbacksV1* output);
#ifdef __cplusplus
}
#endif
#endif
