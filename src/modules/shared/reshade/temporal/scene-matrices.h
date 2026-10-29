#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#if __has_include("temporal-frame.h")
#include "temporal-frame.h"
#else
#include "frame.h"
#endif
#ifdef __cplusplus
extern "C" {
#endif
#define RS_SCENE_MATRICES_ABI_VERSION 1
enum RSSceneMatrixFlags {
 RS_SCENE_VIEW_VALID=1,RS_SCENE_PROJECTION_VALID=2,
 // The projection's NDC depth interval. Unknown is distinct from either range.
 RS_SCENE_CLIP_ZERO_TO_ONE=4,RS_SCENE_CLIP_MINUS_ONE_TO_ONE=8,
 RS_SCENE_PROJECTION_JITTERED=16,RS_SCENE_PROJECTION_Y_DOWN=32
};
// Actual current-frame transforms, using row-major row-vector world-to-view
// and view-to-clip matrices. The default projection is unjittered with NDC Y
// increasing upward. Explicit flags describe a projection already containing
// sample jitter or NDC Y increasing downward; consumers must not apply either
// correction a second time. Separate sample jitter remains in RSTemporalFrame.
// At most one clip-range flag may accompany a valid projection. Existing
// publishers without that declaration remain valid; consumers needing depth
// unprojection must wait for an explicitly declared range.
// No camera transform is inferred from missing data.
typedef struct RSSceneMatrices {
 uint32_t size,version,flags,reserved;
 uint64_t frameId;
 float view[16],projection[16];
} RSSceneMatrices;
// Copy metadata for this exact owner/frame/command-buffer and scene textures.
// Bind before encoding the frame. Commands remain uncommitted and borrowed.
int rsBindTemporalSceneMatrices(const RSTemporalFrame *,const RSSceneMatrices *);
void rsReleaseTemporalSceneMatrices(void *owner);
// Renderers recording before a Metal command buffer exists register the exact
// texture tuple once. Clear at each producer frame boundary and destruction.
// A collision rejects both outstanding registrations until explicitly cleared.
int rsSetTemporalMatricesForTextures(void *owner,void *color,void *depth,void *motion,const RSSceneMatrices *);
void rsClearTemporalMatricesTextures(void *owner);
#ifdef __cplusplus
}
static_assert(sizeof(RSSceneMatrices)==152,"Scene matrices ABI1 must be 152 bytes");
#endif
