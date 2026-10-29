#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
enum RSColorPrimaries {RS_COLOR_BT709=0,RS_COLOR_DISPLAY_P3=1,RS_COLOR_BT2020=2};
enum RSColorTransfer {RS_COLOR_SRGB=0,RS_COLOR_LINEAR=1,RS_COLOR_PQ=2,RS_COLOR_HLG=3,RS_COLOR_CAMERA_BT709=4};
enum RSColorRange {RS_COLOR_FULL=0,RS_COLOR_LIMITED=1};
enum RSColorAlpha {RS_COLOR_STRAIGHT=0,RS_COLOR_PREMULTIPLIED=1,RS_COLOR_OPAQUE=2};
enum RSColorFlags {RS_COLOR_SCENE_REFERRED=1};
struct RSImageColorDescription {
 uint32_t size,version,primaries,transfer,range,alpha;
 float referenceWhite,peakLuminance,blackLuminance,hlgSystemGamma;
 uint32_t flags,reserved;
};
struct RSFrameRequest;struct RSFrameDepth;struct RSFrameResult;
struct RSPresenterOptions;struct RSPresenterError;
// Encodes the shared graph using explicit RGB metadata. Output has the same
// description as input. No submission, readback or display ownership is added.
int rsProcessFrameWithColor(const struct RSFrameRequest*,const struct RSFrameDepth*,const struct RSImageColorDescription*,struct RSFrameResult*);
// Additive presenter entry point. The caller tags its output Metal layer and
// supplies actual display headroom; input metadata remains independent.
void *rsCreateColorFramePresenter(void *layer,void *owner,const struct RSPresenterOptions*,const struct RSImageColorDescription*,float displayHeadroom,struct RSPresenterError*);
void rsSetColorFramePresenterHeadroom(void *presenter,float displayHeadroom);
#ifdef __cplusplus
}
#endif
