#pragma once
#include <stdint.h>
#include "image-color.h"
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
// Output comparison in the shared presenter and both offline processing APIs.
uint32_t rsVideoComparisonAPI(void);
uint32_t rsOutputColorAPI(void);
struct RSVideoOutputColorStatus {
    uint32_t size,version;
    char requested[16],active[16],reason[256];
};
// Optional metadata-only output mapping observation. Returns 1 for an explicit
// policy, 0 for Automatic, or -1 for an invalid request; never waits for GPU work.
int rsVideoGetOutputColorStatus(void *,struct RSVideoOutputColorStatus *);
enum RSVideoQualityState {RS_VIDEO_QUALITY_PENDING=1,RS_VIDEO_QUALITY_ACTIVE=2,RS_VIDEO_QUALITY_OFF=3};
enum RSVideoQualityScope {RS_VIDEO_QUALITY_UNKNOWN=0,RS_VIDEO_QUALITY_SOURCE_AND_PROCESSING=1,RS_VIDEO_QUALITY_IMAGE_PROCESSING=2,RS_VIDEO_QUALITY_FINAL_PROCESSING=3,RS_VIDEO_QUALITY_OFFLINE_FRAME=4,RS_VIDEO_QUALITY_EXTERNAL_PROCESSING=5};
struct RSVideoQualityStatus {
    uint32_t size,version,state,scope;
    double scale,meanMilliseconds;
    char nodeId[129],reason[1025];
};
// Returns 1 for a requested policy, 0 without a policy, or -1 for an invalid
// request. Metadata only; it never submits GPU work or waits for preparation.
int rsVideoGetQualityStatus(void *handle,struct RSVideoQualityStatus*);
void *rsVideoCreate(void *commandQueue, char *error, uint32_t capacity);
int rsVideoProcess(void *handle, const struct RSVideoFrame *frame, char *error, uint32_t capacity);
// Explicit RGB8/RGB16F processing preserves the source description through
// the graph and applies the target conversion once before encoding output.
int rsVideoProcessColor(void *handle,const struct RSVideoFrame*,const struct RSImageColorDescription*source,const struct RSImageColorDescription*target,char *error,uint32_t capacity);
enum RSVideoOutputFlags {RS_VIDEO_OUTPUT_GENERATED=1};
struct RSVideoSequenceOutput {
    void *texture;
    double phase;
    uint32_t flags,reserved;
};
struct RSVideoSequence {
    uint32_t size,version,capacity,count;
    struct RSVideoSequenceOutput *outputs;
    double previousTimeMs;
    uint32_t multiplier,reserved;
};
// A null outputs array queries required capacity without advancing history.
// Otherwise every output texture is caller-owned and matches outputTexture.
// Returned phases are ordered between the previous and current source PTS;
// the final output is always the current real endpoint. GPU completion and
// asynchronous model errors are resolved before success is returned.
int rsVideoProcessSequence(void *,const struct RSVideoFrame*,struct RSVideoSequence*,
    const struct RSImageColorDescription*source,const struct RSImageColorDescription*target,char *error,uint32_t capacity);
void rsVideoRelease(void *handle);
#ifdef __cplusplus
}
#endif
