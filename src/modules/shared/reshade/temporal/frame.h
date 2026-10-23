#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

// Caller-owned Metal resources; commands remain uncommitted. All inputs refer
// to the same scene frame, before presentation/UI composition. Motion vectors
// map current pixels to previous pixels after applying motionScaleX/Y.
enum RSTemporalMethod { RS_TEMPORAL_OFF=0, RS_TEMPORAL_METALFX=1, RS_TEMPORAL_FSR2=2, RS_TEMPORAL_FSR3=3, RS_TEMPORAL_FSR4=4 };
enum RSTemporalFlags {
    RS_TEMPORAL_RESET=1, RS_TEMPORAL_DEPTH_REVERSED=2, RS_TEMPORAL_DEPTH_INFINITE=4,
    RS_TEMPORAL_HDR=8, RS_TEMPORAL_AUTO_EXPOSURE=16, RS_TEMPORAL_JITTERED_MOTION=32,
    RS_TEMPORAL_OUTPUT_MOTION=64, RS_TEMPORAL_CAMERA_VALID=128
};
enum RSTemporalStatus { RS_TEMPORAL_OK=0, RS_TEMPORAL_UNAVAILABLE=1, RS_TEMPORAL_INVALID=2, RS_TEMPORAL_BUSY=3, RS_TEMPORAL_FAILED=4 };
typedef struct RSTemporalFrame {
    uint32_t size, version;
    void *owner, *commandBuffer;
    void *color, *depth, *motion, *output;
    void *exposure, *reactive, *transparency;
    uint64_t frameId;
    uint32_t method, flags;
    uint32_t renderWidth, renderHeight, outputWidth, outputHeight;
    uint32_t maxRenderWidth, maxRenderHeight;
    uint32_t colorX, colorY, depthX, depthY, motionX, motionY, outputX, outputY;
    float jitterX, jitterY, motionScaleX, motionScaleY;
    float preExposure, sharpness, frameTimeMs;
    float nearPlane, farPlane, verticalFov;
    uint32_t commandBufferKind; // 0: MTLCommandBuffer, 1: MTL4CommandBuffer
    uint32_t reserved;
} RSTemporalFrame;
typedef struct RSTemporalResult {
    uint32_t size, version, status, encoded;
    uint32_t method, reset;
    char reason[256];
} RSTemporalResult;
// No fallback silently substitutes a different temporal algorithm.
int rsProcessTemporalFrame(const RSTemporalFrame *, RSTemporalResult *);
// Release when a renderer stops or discards an unsubmitted frame. Some native
// scalers retain their most recent commands; releasing the owner breaks that
// relationship and ensures the next submitted frame begins with fresh history.
void rsReleaseTemporalOwner(void *owner);

// Optional provider ABI. One immutable table per loaded library; implementations
// keep independent history per owner/device, bound pending work, retain resources
// through command completion and never commit or wait for the command buffer.
typedef struct RSTemporalProvider {
    uint32_t size, version, methods, reserved; // methods: 1 << RSTemporalMethod
    int (*encode)(const RSTemporalFrame *, RSTemporalResult *);
    void (*release)(void *owner);
} RSTemporalProvider;
typedef const RSTemporalProvider *(*RSGetTemporalProvider)(uint32_t version);
// Provider libraries export rsGetTemporalProvider. Version currently equals 1.
#ifdef __cplusplus
}
#endif
