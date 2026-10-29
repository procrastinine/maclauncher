#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
enum RSFrameSource {RS_FRAME_SOURCE_UNKNOWN=0,RS_FRAME_SOURCE_METAL_DRAWABLE=1,RS_FRAME_SOURCE_OPENGL_FRAMEBUFFER=2,RS_FRAME_SOURCE_LAYER_SURFACE=3,RS_FRAME_SOURCE_SOFTWARE_BITMAP=4,RS_FRAME_SOURCE_BROWSER_WINDOW=5,RS_FRAME_SOURCE_EXPLICIT_TEXTURE=6,RS_FRAME_SOURCE_DECODED_VIDEO=7};
// Attests the actual producer route. Guide availability comes from submitted
// matching resources, independently of this descriptive route. No GPU work,
// submission, image-history reset or additional observation loop is created.
int rsSetFramePresenterSource(void *presenter,uint32_t source);
struct RSFramePreparationNotice {
 uint32_t size,version;uint64_t sequence;char revision[65],contract[65];
};
struct RSFramePreparationObserver {
 uint32_t size,version;void *context;
 void (*wake)(void *,const struct RSFramePreparationNotice *);
 void (*retain)(void *);void (*release)(void *);
};
// Resource readiness, not acceptance or a new content frame. Wake posts to the
// producer queue and retries its pending real image or retained-content redraw.
// Notice storage is borrowed for the callback. Retain/release keep the context
// alive through in-flight callbacks, including after unregister (observer=null).
// No callback may synchronously render or destroy the presenter.
int rsObserveFramePresenterPreparation(void *presenter,const struct RSFramePreparationObserver *observer);

#ifdef __cplusplus
}
#endif
