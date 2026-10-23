#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

// Camera values describe the same scene and depth texture as one scaler encode.
// Planes are positive view-space distances; verticalFov is in radians. Infinite
// depth uses RS_TEMPORAL_DEPTH_INFINITE and a zero farPlane. Frame IDs start at 1.
// Flags use RSTemporalFlags: RESET, DEPTH_REVERSED, DEPTH_INFINITE, HDR,
// JITTERED_MOTION and OUTPUT_MOTION. Unsupported projections must not be submitted.
typedef struct RSTemporalCamera {
    uint32_t size, version, flags, reserved;
    uint64_t frameId, viewportId;
    float nearPlane, farPlane, verticalFov, frameTimeMs;
    uint32_t reserved2[4];
} RSTemporalCamera;

// Bind camera metadata to this exact native MetalFX scaler and uncommitted
// command buffer, immediately before its encodeToCommandBuffer: call. Metadata
// is copied and consumed once, including when the selected method is Game
// default. Passing NULL clears it. No command submission or GPU synchronization.
int rsSetTemporalCamera(void *scaler, void *commandBuffer, const RSTemporalCamera *);

// For renderers that record commands before the Metal command buffer exists.
// Register on the rendering thread before the matching scaler is encoded; clear
// the owner's old registration at the next frame boundary and on destruction.
// The renderer must finish encoding the previous frame before registering the
// next. Color, depth and motion identities must all match. Ambiguous outstanding
// registrations are rejected, never queued or replaced with a newer camera.
int rsSetTemporalCameraForTextures(void *owner, void *color, void *depth,
                                  void *motion, const RSTemporalCamera *);
void rsClearTemporalCameraTextures(void *owner);
// Read the launcher's cached temporal selection. The existing control reader
// limits filesystem checks; callers must not implement a second polling loop.
uint32_t rsGetTemporalMethod(void);

#ifdef __cplusplus
}
static_assert(sizeof(RSTemporalCamera) == 64, "Temporal camera ABI must be 64 bytes");
#endif
