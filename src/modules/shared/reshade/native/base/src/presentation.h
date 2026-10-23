#pragma once
#include "frame.h"
#ifdef __cplusplus
extern "C" {
#endif

#define RS_PRESENTER_ABI_VERSION 1
enum RSPresenterFlags { RS_PRESENTER_FLIP_Y = 1 };
struct RSPresenterOptions {
 uint32_t size,version,origin,flags;
 double sourceFrameRate; // Zero estimates cadence from source timestamps.
};
struct RSPresenterError { uint32_t size,version; char reason[512]; };
struct RSPresenterSubmission {
 uint32_t size,version;
 void *commandBuffer,*sourceTexture;
 uint64_t frameId;
 double sourceTime;
 void *lifetimeToken;
 void (*releaseToken)(void *);
};
struct RSPresenterStatus {
 uint32_t size,version;
 uint64_t submitted,encoded,completedReal,presentedReal,presentedGenerated;
 uint64_t dropped,lastPresentedFrame;
 uint32_t pending,maxPending,stopped;
 double lastLatencyMs;
 char reason[512];
};
// Uses the shared validated RESHADE_* graphics environment. The layer and owner
// must be unique to this presenter. Layer dimensions are controlled by the host;
// source resolution is never changed. Only SDR BGRA8/RGBA8 layers are supported.
void *rsCreateFramePresenter(void *metalLayer,void *owner,
 const struct RSPresenterOptions *,struct RSPresenterError *);
// Encodes source processing and owns final presentation. The host encodes its
// producer fence before submit and commits the buffer once afterward. Never also
// call rsProcessFrame or present this output layer in the host.
// On RS_FRAME_OK, token ownership transfers and releaseToken runs exactly once
// after producer completion, or discarded unsubmitted-buffer destruction.
// RS_FRAME_BUSY is temporary queue/drawable exhaustion: retain the last valid
// output and retry the same frame ID/time with a fresh unsubmitted buffer, or
// submit a later frame. Rejected submissions retain caller token ownership and
// do not reserve frame identity. Accepted encoding reserves identity even if
// its command buffer is later discarded. FramePresenter
// copies the source into its owned history before the producer fence completes.
int rsSubmitFramePresenter(void *,const struct RSPresenterSubmission *,struct RSFrameResult *);
int rsGetFramePresenterStatus(void *,struct RSPresenterStatus *);
// Stop source submissions before destruction. In-flight resources and tokens
// remain alive until their command buffers complete; no GPU wait occurs here.
void rsDestroyFramePresenter(void *);

#ifdef __cplusplus
}
#endif
