#pragma once
#ifdef __cplusplus
extern "C" {
#endif
/* Register a native producer layer with an explicit frame consumer. The
 * consumer encodes into the supplied Metal command buffer before it commits;
 * it must not commit, wait for, or retain that buffer. A nonzero result means
 * the frame was consumed. The registration borrows context; its owner removes
 * the registration before releasing context and drains its submitted work.
 * Removal waits for active encoding callbacks and cannot run inside a callback.
 * Other layers in an explicit host remain outside automatic interception. */
typedef int (*RSNativeMetalFrame)(void *context, void *commandBuffer, void *texture);
int rsRegisterNativeMetalLayer(void *layer, RSNativeMetalFrame frame, void *context);
/* Only inside the matching frame callback: retain its actual drawable so its
 * pooled source cannot be recycled by a later producer. Release after reads. */
void *rsRetainNativeMetalSource(void *commandBuffer,void *texture);
void rsReleaseNativeMetalSource(void *lease);
void rsUnregisterNativeMetalLayer(void *layer);
#ifdef __cplusplus
}
#endif
