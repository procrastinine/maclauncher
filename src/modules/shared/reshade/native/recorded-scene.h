#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "vulkan-scene.h"
#ifdef __cplusplus
extern "C" {
#endif
// Native-only factory. PE transports opaque numeric identities; callback code
// and owner storage are created and retained by the common native runtime.
typedef struct RSRecordedSceneConsumerV1 {
    uint32_t size,version;
    void* owner;
    RSVulkanSceneCallbacksV1 callbacks;
} RSRecordedSceneConsumerV1;
uint32_t rsRecordedSceneConsumerAPI(void);
// Returns one callback reference. Releasing the last recorded/completion owner
// retires this exact ordered-scene owner without touching a later generation.
int rsCreateRecordedSceneConsumer1(uint64_t generation,RSRecordedSceneConsumerV1*);
// Cached prepared-plan resource demand, expressed in the existing scene slots.
uint32_t rsRecordedSceneImageDemand1(void);
typedef uint32_t (*RSRecordedSceneConsumerAPI)(void);
typedef int (*RSCreateRecordedSceneConsumer1)(uint64_t,RSRecordedSceneConsumerV1*);
typedef uint32_t (*RSRecordedSceneImageDemand1)(void);
typedef struct RSRecordedSceneExtentV1 {uint32_t width,height;} RSRecordedSceneExtentV1;
// Storage capacity is not the scene's current logical processing grid.
static inline RSRecordedSceneExtentV1 rsRecordedSceneInputExtent(const RSTemporalFrame* frame,int reconstructs){
    RSRecordedSceneExtentV1 result={reconstructs?frame->renderWidth:frame->outputWidth,reconstructs?frame->renderHeight:frame->outputHeight};return result;
}
#ifdef __cplusplus
}
#endif
