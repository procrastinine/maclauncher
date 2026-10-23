#pragma once
#include "frame.h"
#include "presentation.h"

#ifdef __cplusplus
extern "C" {
#endif
#define RS_DEPTH_ABI_VERSION 1u
// A borrowed, resolved 2D Metal texture from the same frame and device as color.
// R32Float stores raw normalized device depth; Depth32Float is read on the GPU.
// No projection, reverse-Z or linearization convention is inferred. The selected
// effect owns those settings. Width, height, frame ID and origin must match color.
// Producer writes/dependencies precede this call in the retaining command buffer.
typedef struct RSFrameDepth {
    uint32_t size, version;
    void *texture;
    uint64_t frameId;
    uint32_t origin, reserved;
} RSFrameDepth;
int rsProcessFrameWithDepth(const struct RSFrameRequest *, const RSFrameDepth *, struct RSFrameResult *);
int rsSubmitFramePresenterWithDepth(void *, const struct RSPresenterSubmission *, const RSFrameDepth *, struct RSFrameResult *);
#ifdef __cplusplus
}
#endif
