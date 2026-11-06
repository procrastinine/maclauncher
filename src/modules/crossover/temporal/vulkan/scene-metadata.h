#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-request.h"
// Additive wire metadata. Texture identity remains in base.images; no native
// pointer or callback can occur in this packet. V1 and its selector stay intact.
typedef struct RSWineSceneAovImageV2 {
 uint32_t x,y,width,height,encoding,space,channel,origin;
 float scale,bias;
 uint32_t pass,reserved;
} RSWineSceneAovImageV2;
typedef struct RSWineSceneMetadataV2 {
 uint32_t size,version,aovMask,aovFlags;
 uint64_t viewId,epoch,imageRevision;
 RSWineVulkanSceneColorV1 color,uiColor,hudlessColor;
 float preExposure;
 uint32_t pass,colorPass,matrixFlags;
 float view[16],projection[16];
 RSWineSceneAovImageV2 images[14];
 // Actual final DXGI HWND association, resolved only by the matched Unix owner.
 uint64_t destinationWindow;
} RSWineSceneMetadataV2;
typedef struct RSWineVulkanSceneRequestV2 {
 RSWineVulkanSceneRequestV1 base;
 RSWineSceneMetadataV2 metadata;
} RSWineVulkanSceneRequestV2;
#ifdef _WIN32
#define RS_SCENE_CALL2 __stdcall
#else
#define RS_SCENE_CALL2
#endif
typedef int32_t (RS_SCENE_CALL2 *RSWineVulkanSceneRecordCall2)(const RSWineVulkanSceneRequestV2*);
// Preparation mutates only the existing request: an owned native admission
// returns its opaque consumerId and flags0. It does not encode or fulfill an
// SDK output. Feature2 is reconstruction; unsupported features retain input.
typedef int32_t (RS_SCENE_CALL2 *RSWineVulkanScenePrepareCall3)(RSWineVulkanSceneRequestV2*,uint32_t);
typedef int32_t (RS_SCENE_CALL2 *RSWineVulkanSceneCancelCall3)(const RSWineVulkanSceneRequestV2*);
// Device/declared-shape support only. Images and commands are absent and no
// admission identity or output resource is returned by this query.
typedef int32_t (RS_SCENE_CALL2 *RSWineVulkanSceneQueryCall3)(const RSWineVulkanSceneRequestV2*,uint32_t);
#undef RS_SCENE_CALL2
#if defined(__cplusplus)
static_assert(sizeof(RSWineSceneAovImageV2)==48,"Wire AOV metadata layout");
static_assert(sizeof(RSWineSceneMetadataV2)==1008,"Wire scene metadata layout");
static_assert(sizeof(RSWineVulkanSceneRequestV2)==1752,"Wire scene request layout");
#endif
