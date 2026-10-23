#pragma once
#include "target-time.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Optional display-driven retirement API; existing ABI1 structures are unchanged.
 * Resolve this symbol before using it, or require observedPresentationAPI: 1
 * in the selected graphics runtime metadata. No presentation target is supplied,
 * so ordinary scheduling and configured frame generation remain available.
 *
 * Only RS_FRAME_OK transfers observer-context ownership. The observer retires
 * exactly once for that accepted source frame, on its final real display or
 * drop/cancel/GPU error. Generated frames do not retire the source observer.
 * The context must remain valid through retirement, including after presenter
 * destruction. Retirement is independent of the producer releaseToken callback;
 * neither callback implies that the other has run. Positive presentedTime means
 * an actual real-frame display; other outcomes carry no display timestamp.
 * Rejection retains observer-context and producer-token ownership and invokes
 * neither callback. As with ABI1 submission, encoding can emit partial work on
 * rejection: source storage must survive any such command buffer's completion
 * or discard. The caller alone commits the borrowed command buffer. */
int rsSubmitFramePresenterObserved(void *, const struct RSPresenterSubmission *,
 const struct RSPresentationObserver *, struct RSFrameResult *);

#ifdef __cplusplus
}
#endif
