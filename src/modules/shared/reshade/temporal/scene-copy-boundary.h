#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#if __has_include("temporal-scene-aovs.h")
#include "temporal-scene-aovs.h"
#include "temporal-scene-matrices.h"
#else
#include "scene-aovs.h"
#include "scene-matrices.h"
#endif
#ifdef __cplusplus
extern "C" {
#endif
// Register one exact renderer-ordered identity copy. scene.color is the
// immutable source snapshot and scene.output is the original engine target.
// Commands are null at registration. The actual full-region copy and its
// ending blit encoder supply the borrowed command-buffer authority later.
// Preparation never blocks that renderer; an unavailable optional prefix
// leaves the engine's original copy and subsequent passes unchanged.
int rsSetTemporalSceneCopyBoundary(void *owner,void *nativeWindow,
 const RSTemporalFrame *scene,const RSSceneMatrices*,const RSSceneAovs*,
 const RSSceneAovRetirement*);
void rsClearTemporalSceneCopyBoundaries(void *owner);
uint32_t rsSceneCopyBoundaryAPI(void);
#ifdef __cplusplus
}
#endif
