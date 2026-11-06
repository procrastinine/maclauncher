#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <stdint.h>
#include "image-color.h"
// Private PE/native carrier, appended to the owned scaler props. Handles are
// populated only by DXMT's real resource-access/recording path.
typedef struct MLStreamlineNativeImage {
  uint64_t texture;
  uint32_t x,y,width,height;
} MLStreamlineNativeImage;
typedef struct MLStreamlineNativeResources {
  uint32_t size,version;
  uint64_t frameId,viewId,epoch,imageRevision;
  MLStreamlineNativeImage hudless,ui;
  struct RSImageColorDescription hudlessColor,uiColor;
} MLStreamlineNativeResources;
// Additive native recording metadata. The original 184-byte carrier remains
// unchanged; only an explicit size/version2 permits reading this HWND tail.
typedef struct MLStreamlineNativeResourcesV2 {
  MLStreamlineNativeResources base;
  uint64_t destinationWindow;
  struct RSImageColorDescription sceneColor;
  uint32_t sceneColorKnown,reserved;
  uint32_t scenePass,sceneColorPass;
} MLStreamlineNativeResourcesV2;
#ifdef __cplusplus
static_assert(sizeof(MLStreamlineNativeImage)==24&&sizeof(MLStreamlineNativeResources)==184,"Streamline native resource carrier ABI1 changed");
static_assert(sizeof(MLStreamlineNativeResourcesV2)==256,"Streamline native destination carrier ABI2 changed");
#else
_Static_assert(sizeof(MLStreamlineNativeImage)==24&&sizeof(MLStreamlineNativeResources)==184,"Streamline native resource carrier ABI1 changed");
_Static_assert(sizeof(MLStreamlineNativeResourcesV2)==256,"Streamline native destination carrier ABI2 changed");
#endif
