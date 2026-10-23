#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// Offline callers supply readable SDR BGRA8 Metal textures on one queue.
// Processing submits and waits for the complete ordered plan, including neural
// completion. Times are from the source media timeline, in milliseconds.
struct RSVideoFrame {
    uint32_t size, version;
    void *sourceTexture, *outputTexture;
    uint64_t frameId;
    double timeMs;
    float frameTimeMs;
};
void *rsVideoCreate(void *commandQueue, char *error, uint32_t capacity);
int rsVideoProcess(void *handle, const struct RSVideoFrame *frame, char *error, uint32_t capacity);
void rsVideoRelease(void *handle);
#ifdef __cplusplus
}
#endif
