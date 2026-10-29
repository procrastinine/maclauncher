#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "presentation-observed.h"
#ifdef __cplusplus
extern "C" {
#endif
enum RSPresentationContentFlags {RS_PRESENT_CONTENT_REDRAW=1,RS_PRESENT_CONTENT_PTS_UNKNOWN=2,RS_PRESENT_CONTENT_DISPLAY_MAPPED=4};
struct RSPresentationContent {
 uint32_t size,version,flags,reserved;
 uint64_t contentId,epoch,imageRevision;
 double pts,duration;
};
// Submission frameId/sourceTime remain increasing delivery identities/host
// timestamps. Content identity/PTS describe the real decoded image. A redraw
// repeats the latest accepted content stamp, reruns image processing and
// submits no frame-generator history. Duration is media seconds, or zero when
// unknown. PTS_UNKNOWN explicitly supplies no media PTS; logical image time is
// the first real admission time and stays fixed on redraw. Recreate the
// presenter for a seek/new stream epoch. The host retains
// its source image and producer synchronization through every submission.
// imageRevision changes when producer-side processing changes the pixels of
// that same decoded image, so downstream image caches reset without inventing
// another decoded frame.
// DISPLAY_MAPPED attests producer pixels already mapped to display range;
// their physical HDR encoding/mastering metadata remains independent.
// Observer may be null; producer and observer ownership follows the existing
// observed-presentation API exactly. No command submission or CPU wait is added.
int rsSubmitFramePresenterContent(void *,const struct RSPresenterSubmission *,
 const struct RSPresentationContent *,const struct RSPresentationObserver *,
 struct RSFrameResult *);
int rsSubmitFramePresenterContentAtTime(void *,const struct RSPresenterSubmission *,
 const struct RSPresentationContent *,const struct RSPresentationTarget *,
 const struct RSPresentationObserver *,struct RSFrameResult *);
#ifdef __cplusplus
}
#endif
