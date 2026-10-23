#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RS_FRAME_ABI_VERSION 1
enum RSFrameMethod { RS_FRAME_BILINEAR = 0, RS_FRAME_METALFX = 1, RS_FRAME_LS1 = 2, RS_FRAME_MAKO = 3, RS_FRAME_FSR1 = 4, RS_FRAME_NEAREST = 5, RS_FRAME_BICUBIC = 6 };
enum RSFrameColor { RS_FRAME_PERCEPTUAL = 0, RS_FRAME_LINEAR = 1 };
enum RSFrameOrigin { RS_FRAME_TOP_LEFT = 0, RS_FRAME_BOTTOM_LEFT = 1 };
enum RSFrameCode { RS_FRAME_OK = 0, RS_FRAME_INVALID_ARGUMENT = 1, RS_FRAME_ENCODE_FAILED = 2, RS_FRAME_BUSY = 3 };
// Metal objects are borrowed Objective-C pointers. This call only encodes work.
// The host owns producer synchronization, command submission and presentation.
struct RSFrameRequest {
 uint32_t size, version;
 void *owner, *commandBuffer, *sourceTexture, *outputTexture;
 uint64_t frameId;
 uint32_t method, color, origin;
};
struct RSFrameResult {
 uint32_t size, version;
 uint32_t encoded, effects, scaled, activeMethod;
 uint32_t inputWidth, inputHeight, outputWidth, outputHeight;
 uint64_t frameId;
 char reason[512];
};
// Initialize both structs size/version before calling. Returns RSFrameCode.
void rsReleaseFrameOwner(void *owner);
int rsProcessFrame(const struct RSFrameRequest *request, struct RSFrameResult *result);

#ifdef __cplusplus
}
#endif
