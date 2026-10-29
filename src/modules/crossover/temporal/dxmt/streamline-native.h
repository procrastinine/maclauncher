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
#ifdef __cplusplus
static_assert(sizeof(MLStreamlineNativeImage)==24&&sizeof(MLStreamlineNativeResources)==184,"Streamline native resource carrier ABI1 changed");
#else
_Static_assert(sizeof(MLStreamlineNativeImage)==24&&sizeof(MLStreamlineNativeResources)==184,"Streamline native resource carrier ABI1 changed");
#endif
