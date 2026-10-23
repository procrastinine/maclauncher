#pragma once
#ifndef RS_PRESENTER_ABI_VERSION
#include "presentation.h"
#endif
#ifdef __cplusplus
extern "C" {
#endif
/* Optional presentation-time API. Existing ABI1 structures and entrypoints are unchanged.
 * Host time is the Metal/CACurrentMediaTime (Mach uptime) clock, in seconds.
 * Past targets are explicit late/as-soon-as-possible requests. A target more
 * than one second ahead is rejected before encoding or token transfer: the
 * adapter does not reserve drawable capacity for unbounded delays.
 * This is a holding limit, not an Android presentation deadline. */
#define RS_TARGET_ABI_VERSION 1
struct RSPresentationTarget {uint32_t size,version;double hostTime;};
struct RSPresentationTiming {
 uint32_t size,version;
 uint64_t requested,accepted,rejected,lateAtSubmit,completed,cancelled,gpuFailed;
 uint64_t presented,skipped,lastCompletedFrame,lastPresentedFrame;
 double lastRequestedTime,lastCompletedTime,lastPresentedTarget,lastPresentedTime;
 /* Actual minus requested, positive-presented only: early, <=1ms, <=4ms,
    <=8ms, <=16ms, <=32ms, <=100ms, >100ms. */
 uint64_t lateness[8];
};
enum RSPresentationOutcome {
 RS_PRESENTED = 1, RS_PRESENT_DROPPED = 2,
 RS_PRESENT_CANCELLED = 3, RS_PRESENT_GPU_ERROR = 4
};
struct RSPresentationObserver {
 uint32_t size,version;
 void *context;
 void (*retired)(void *context,uint64_t frameId,double presentedTime,
                 double retiredTime,uint32_t outcome);
};
int rsSubmitFramePresenterAtTime(void*,const struct RSPresenterSubmission*,
 const struct RSPresentationTarget*,struct RSFrameResult*);
int rsGetFramePresenterTiming(void*,struct RSPresentationTiming*);
/* On successful submission, retired runs exactly once, outside presenter locks,
 * including dropped/occluded drawables and abandoned command buffers. The
 * context must remain valid until that callback, including after destruction.
 * Rejection retains context ownership and does not invoke the callback.
 * presentedTime is positive only for an actual display presentation; retirement
 * does not imply display. Both times use the target's host clock domain. */
int rsSubmitFramePresenterAtTimeObserved(void*,const struct RSPresenterSubmission*,
 const struct RSPresentationTarget*,const struct RSPresentationObserver*,
 struct RSFrameResult*);
#ifdef __cplusplus
}
#endif
