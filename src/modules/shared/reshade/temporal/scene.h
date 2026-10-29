#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
enum RSSceneFrameDemand {
    RS_SCENE_COLOR=1, RS_SCENE_DEPTH=2, RS_SCENE_MOTION=4,
    RS_SCENE_CAMERA=8, RS_SCENE_JITTER=16, RS_SCENE_EXPOSURE=32,
    RS_SCENE_REACTIVE=64, RS_SCENE_UI=128,
    RS_SCENE_VIEW_MATRIX=256, RS_SCENE_PROJECTION_MATRIX=512
};
// Version 1 reports the enabled graph and legacy selection's actual guide
// requirements. Camera means perspective near/far/FOV; matrices are separate.
// This reads cached selection metadata and does not prepare GPU resources.
uint32_t rsGetSceneFrameDemand(uint32_t version);
#ifdef __cplusplus
}
#endif
