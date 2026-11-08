#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "vulkan-scene.h"
#include "generation-provider.h"
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
typedef struct RSRecordedSceneConsumerV3 {
    uint32_t size,version;
    void* owner;
    RSVulkanSceneCallbacksV3 callbacks;
} RSRecordedSceneConsumerV3;
// Version3 explicitly negotiates submission-aware output ownership. Creation
// alone admits no feature/shape or prepared provider operation.
int rsCreateRecordedSceneConsumer3(uint64_t generation,uint32_t commandBufferKind,RSRecordedSceneConsumerV3*);
// Native-only matched Wine window callback, on the existing Cocoa/UI thread.
// The owner is issued by factory3; null clears its actual destination.
int rsSetRecordedSceneDestination3(void* owner,void* actualNSWindow);
typedef int (*RSSetRecordedSceneDestination3)(void*,void*);
enum RSRecordedSceneFeature {RS_RECORDED_TEMPORAL=1,RS_RECORDED_RECONSTRUCTION=2,RS_RECORDED_GENERATION=3};
// Selected-provider device/shape query before feature creation. This does not
// admit resources, prepare pipelines or fulfill a frame; encoded remains zero.
int rsQueryRecordedSceneFeature3(void* featureOwner,uint32_t feature,void* actualDevice,const RSTemporalFrame* actualShape,RSTemporalResult*);
typedef int (*RSQueryRecordedSceneFeature3)(void*,uint32_t,void*,const RSTemporalFrame*,RSTemporalResult*);
// Resource-only admission. Actual resolved device/resources are mandatory;
// native preparation may precede command creation. Generation uses the existing
// exact output/phase submission contract. Success returns one owned operation
// lease with encoded==0; it does not report an evaluated/generated frame.
int rsPrepareRecordedSceneOperation3(void* featureOwner,uint32_t feature,void* actualDevice,
 const RSVulkanSceneEncodingV1* actualInputs,const struct RSGenerationSubmission*,
 RSRecordedSceneConsumerV3* admittedOperation,RSTemporalResult*);
typedef int (*RSPrepareRecordedSceneOperation3)(void*,uint32_t,void*,const RSVulkanSceneEncodingV1*,const struct RSGenerationSubmission*,RSRecordedSceneConsumerV3*,RSTemporalResult*);

// Returns one callback reference. Releasing the last recorded/completion owner
// retires this exact ordered-scene owner without touching a later generation.
int rsCreateRecordedSceneConsumer1(uint64_t generation,RSRecordedSceneConsumerV1*);
// Same output layout, explicit size/version2 and commandBufferKind1. Success
// negotiates packet semantics, not support for every plan/provider/device.
int rsCreateRecordedSceneConsumer2(uint64_t generation,uint32_t commandBufferKind,RSRecordedSceneConsumerV1*);
// Cached prepared-plan resource demand, expressed in the existing scene slots.
uint32_t rsRecordedSceneImageDemand1(void);
typedef uint32_t (*RSRecordedSceneConsumerAPI)(void);
typedef int (*RSCreateRecordedSceneConsumer1)(uint64_t,RSRecordedSceneConsumerV1*);
typedef int (*RSCreateRecordedSceneConsumer2)(uint64_t,uint32_t,RSRecordedSceneConsumerV1*);
typedef int (*RSCreateRecordedSceneConsumer3)(uint64_t,uint32_t,RSRecordedSceneConsumerV3*);
typedef uint32_t (*RSRecordedSceneImageDemand1)(void);
typedef struct RSRecordedSceneExtentV1 {uint32_t width,height;} RSRecordedSceneExtentV1;
// Storage capacity is not the scene's current logical processing grid.
static inline RSRecordedSceneExtentV1 rsRecordedSceneInputExtent(const RSTemporalFrame* frame,int reconstructs){
    RSRecordedSceneExtentV1 result={reconstructs?frame->renderWidth:frame->outputWidth,reconstructs?frame->renderHeight:frame->outputHeight};return result;
}
#ifdef __cplusplus
}
#endif
