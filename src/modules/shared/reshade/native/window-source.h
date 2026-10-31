#pragma once
#include "presentation.h"
#ifdef __cplusplus
extern "C" {
#endif

// A picked window or display as a graphics input. The host process presents
// the system content picker, then hands its filter to this source, which
// captures complete frames, processes them with the shared presenter and
// shows the result in a click-through overlay at the target's frame. Every
// call is main-thread only; the host polls about ten times per second.
#define RS_WINDOW_SOURCE_ABI_VERSION 1
// SCALED letterboxes a picked window on its screen and forwards pointer
// events to it, which needs the Accessibility permission. A display is
// always shown in place.
enum RSWindowSourceFlags { RS_WINDOW_SOURCE_CURSOR = 1, RS_WINDOW_SOURCE_SCALED = 2 };
enum RSWindowSourceState {
 RS_WINDOW_SOURCE_WAITING = 0,   // No target selected yet.
 RS_WINDOW_SOURCE_RUNNING = 1,   // Capturing; the overlay is shown.
 RS_WINDOW_SOURCE_HIDDEN = 2,    // The target is minimized, hidden, covered or in another Space.
 RS_WINDOW_SOURCE_OFF = 3,       // No image processing is requested; capture is stopped.
 RS_WINDOW_SOURCE_SUSPENDED = 4, // The host suspended capture (sleep, lock, user switch).
 RS_WINDOW_SOURCE_FAILED = 5,    // Capture failed; reason names it. A plan edit or Off and On retries once.
 RS_WINDOW_SOURCE_CLOSED = 6     // The window closed, the display ended or sharing was stopped.
};
struct RSWindowSourceOptions {
 uint32_t size,version,flags,suspended;
 double captureRate; // Frames per second; zero accepts every complete frame.
};
struct RSWindowSourceTarget {
 uint32_t size,version;
 void *filter; // SCContentFilter * from a picker this process presented.
 uint32_t windowID,displayID; // Exactly one is nonzero.
};
struct RSWindowSourceStatus {
 uint32_t size,version,state,revealed;
 uint64_t captured,dropped,presentedReal,presentedGenerated;
 uint32_t pixelsWidth,pixelsHeight;
 char reason[512];
};
void *rsWindowSourceCreate(const struct RSWindowSourceOptions *,struct RSPresenterError *);
// The overlay's window number, for exclusion from the picker and capture.
uint32_t rsWindowSourceOutputWindow(void *);
int rsWindowSourceSelect(void *,const struct RSWindowSourceTarget *,struct RSPresenterError *);
int rsWindowSourceSetOptions(void *,const struct RSWindowSourceOptions *);
int rsWindowSourcePoll(void *,struct RSWindowSourceStatus *);
// Releases capture and the overlay; in-flight GPU work completes on its own.
void rsWindowSourceDestroy(void *);
unsigned rsWindowSourceAPI(void);

#ifdef __cplusplus
}
#endif
