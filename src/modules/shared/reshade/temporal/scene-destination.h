#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// A cooperating renderer identifies the native NSWindow containing this exact
// full-window scene. Subviewports and ambiguous compositions remain unbound.
// Metadata is copied before the matching temporal texture tuple is encoded.
int rsSetTemporalSceneDestinationForTextures(void *owner,void *nativeWindow,
    void *color,void *depth,void *motion,uint64_t frameId);
// Optional declaration independent of perspective camera parameters. Flags
// currently accept RS_TEMPORAL_HDR for an explicitly known HDR scene source.
int rsSetTemporalSceneDestinationFlagsForTextures(void *owner,void *nativeWindow,
    void *color,void *depth,void *motion,uint64_t frameId,uint32_t flags);
// Clear at the next producer frame boundary and when the producer stops.
void rsClearTemporalSceneDestinationTextures(void *owner);
#ifdef __cplusplus
}
#endif
