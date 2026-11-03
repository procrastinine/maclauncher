#pragma once
#include "presentation.h"
#include <IOSurface/IOSurfaceRef.h>
#ifdef __cplusplus
extern "C" {
#endif

// Forwarded window/display frames use the shared presenter and a click-through
// overlay. Geometry, options and lifecycle calls run on the main thread;
// Submit accepts frames from the transport thread.
#define RS_WINDOW_SOURCE_ABI_VERSION 2
// Posted on the main thread when the capture crop changes, so the host can
// forward options without waiting for its next poll.
#define RS_WINDOW_SOURCE_CROP_CHANGED "org.maclauncher.window-source.crop-changed"
// SCALED changes output geometry; HOLD gates display-exclusion acknowledgement.
enum RSWindowSourceFlags { RS_WINDOW_SOURCE_CURSOR = 1, RS_WINDOW_SOURCE_SCALED = 2, RS_WINDOW_SOURCE_HOLD = 4 };
enum RSWindowSourceState {
 RS_WINDOW_SOURCE_WAITING = 0,   // No target selected yet.
 RS_WINDOW_SOURCE_RUNNING = 1,   // Capturing; the overlay is shown.
 RS_WINDOW_SOURCE_HIDDEN = 2,    // Overlay hidden: target off screen, held or on another Space.
 RS_WINDOW_SOURCE_OFF = 3,       // No image processing is requested; capture is stopped.
 RS_WINDOW_SOURCE_SUSPENDED = 4, // The host suspended capture (sleep, lock, user switch).
 RS_WINDOW_SOURCE_FAILED = 5,    // Capture failed; reason names it. A plan edit or Off and On retries once.
 RS_WINDOW_SOURCE_CLOSED = 6     // The window closed, the display ended or sharing was stopped.
};
struct RSWindowSourceOptions {
 uint32_t size,version,flags,suspended;
 double captureRate; // Zero follows the shared source cap.
 double scale; // Zero fits the screen.
};
struct RSWindowSourceTarget {
 uint32_t size,version;
 uint32_t windowID,displayID; // Exactly one is nonzero.
};
struct RSWindowSourceGeometry {
 uint32_t size,version,exists,onScreen; int32_t pid,layer;
 double x,y,width,height,scale; uint32_t displayID,pixelsWidth,pixelsHeight;
 uint64_t generation;
};
struct RSWindowSourceFrame {uint32_t size,version;uint64_t sequence,generation;double time;uint32_t width,height;};
struct RSWindowSourcePointer {uint32_t size,version,visible;double x,y;};
typedef void (*RSWindowSourceReleased)(void *,uint64_t);
struct RSWindowSourceStatus {
 uint32_t size,version,state,revealed;
 uint64_t captured,dropped,presentedReal,presentedGenerated;
 uint32_t pixelsWidth,pixelsHeight;
 uint32_t onActiveSpace,displayID,outputVisible;
 double cropX,cropY;
 double targetX,targetY,targetWidth,targetHeight; int32_t targetPid;
 char reason[512];
};
void *rsWindowSourceCreate(const struct RSWindowSourceOptions *,struct RSPresenterError *);
// The overlay's window number, for exclusion from the picker and capture.
uint32_t rsWindowSourceOutputWindow(void *);
int rsWindowSourceSelect(void *,const struct RSWindowSourceTarget *,struct RSPresenterError *);
int rsWindowSourceSetOverlays(void *,const uint32_t *,uint32_t);
int rsWindowSourceSetGeometry(void *,const struct RSWindowSourceGeometry *);
int rsWindowSourceSubmit(void *,IOSurfaceRef,const struct RSWindowSourceFrame *,RSWindowSourceReleased,void *);
double rsWindowSourceCaptureInterval(void *);
int rsWindowSourceSetPointer(void *,const struct RSWindowSourcePointer *);
int rsWindowSourceSetOptions(void *,const struct RSWindowSourceOptions *);
int rsWindowSourcePoll(void *,struct RSWindowSourceStatus *);
// Releases capture and the overlay; in-flight GPU work completes on its own.
void rsWindowSourceDestroy(void *);
// Released captures of this process that are still stopping. A host waits,
// for a bounded time, until this is zero before it exits.
unsigned rsWindowSourcePendingStops(void);
unsigned rsWindowSourceAPI(void);

#ifdef __cplusplus
}
#endif
