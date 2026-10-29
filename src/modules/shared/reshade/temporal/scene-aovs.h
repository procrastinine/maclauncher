#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#if __has_include("temporal-frame.h")
#include "temporal-frame.h"
#else
#include "frame.h"
#endif
#if __has_include("image-color.h")
#include "image-color.h"
#else
#include "../native/image-color.h"
#endif
#ifdef __cplusplus
extern "C" {
#endif
#define RS_SCENE_AOV_ABI_VERSION 1
enum RSSceneAovSlot {
 RS_SCENE_AOV_NORMAL=0,RS_SCENE_AOV_ROUGHNESS=1,
 RS_SCENE_AOV_RESOLVED_RADIANCE=2,RS_SCENE_AOV_RESOLVED_SPECULAR=3,
 RS_SCENE_AOV_DIFFUSE_ALBEDO=4,RS_SCENE_AOV_SPECULAR_ALBEDO=5,
 RS_SCENE_AOV_NOISY_DIFFUSE=6,RS_SCENE_AOV_NOISY_SPECULAR=7,
 RS_SCENE_AOV_SPECULAR_HIT_DISTANCE=8,RS_SCENE_AOV_DENOISE_MASK=9,
 RS_SCENE_AOV_TRANSPARENCY=10,RS_SCENE_AOV_METALLIC=11,
 RS_SCENE_AOV_HUDLESS_COLOR=12,RS_SCENE_AOV_UI_COLOR_ALPHA=13,
 RS_SCENE_AOV_COUNT=14
};
enum RSSceneAovEncoding {
 RS_SCENE_AOV_LINEAR=0,RS_SCENE_AOV_XYZ_SIGNED=1,
 RS_SCENE_AOV_XYZ_UNORM=2,RS_SCENE_AOV_ROUGHNESS_FOLDED=3,
 RS_SCENE_AOV_SCALAR=4,RS_SCENE_AOV_COLOR=5
};
enum RSSceneAovSpace {RS_SCENE_AOV_SPACE_NONE=0,RS_SCENE_AOV_SPACE_VIEW=1,RS_SCENE_AOV_SPACE_WORLD=2};
enum RSSceneAovOrigin {RS_SCENE_AOV_TOP_LEFT=0,RS_SCENE_AOV_BOTTOM_LEFT=1};
enum RSSceneAovFlags {
 // The exact matched scene color contains noisy lighting, not a final-image
 // denoise request or a claim inferred from the renderer's name.
 RS_SCENE_AOV_COLOR_NOISY=1,
 RS_SCENE_AOV_RADIANCE_INCLUDES_SPECULAR=2,
 // Exact current color composition; the two declarations are mutually exclusive.
 RS_SCENE_AOV_COLOR_INCLUDES_SPECULAR=4,
 RS_SCENE_AOV_SPECULAR_MERGE_PENDING=8
};
enum RSSceneAovPass {RS_SCENE_AOV_PASS_UNSPECIFIED=0,RS_SCENE_AOV_AFTER_OPAQUE=1,RS_SCENE_AOV_AFTER_SKY=2,RS_SCENE_AOV_BEFORE_TRANSPARENT=3,RS_SCENE_AOV_AFTER_TRANSPARENT=4,RS_SCENE_AOV_TEMPORAL_INPUT=5};
// Each 2D resolved texture covers the complete matched render viewport through
// this explicit ROI. A known full-viewport resize preserves that UV mapping.
// Scalar channels use value * scale + bias. XYZ_UNORM normals decode rgb*2-1
// then normalize. ROUGHNESS_FOLDED decodes min(v,1-v)*scale+bias; it does not
// reinterpret a packed flag as material roughness. Roughness is perceptual
// roughness, albedo is material reflectance, and hit distance is in view units.
typedef struct RSSceneAovImage {
 void *texture;
 uint32_t x,y,width,height,encoding,space,channel,origin;
 float scale,bias;
 // Zero inherits packet.pass; otherwise the actual attachment capture stage.
 uint32_t pass,reserved;
} RSSceneAovImage;
// Material albedo, resolved lit specular and noisy radiance are separate slots.
// A producer publishes only attachments that actually exist. All radiance is
// linear in color.primaries/referenceWhite, multiplied by preExposure; albedo
// is unexposed linear reflectance in those primaries. No attachment supplies
// invented depth, normals, hit distance or material values for a missing slot.
typedef struct RSSceneAovs {
 uint32_t size,version,flags,reserved;
 uint64_t frameId,viewId,epoch,imageRevision;
 struct RSImageColorDescription color;
 // UI color/alpha may use a different display encoding and alpha convention.
 // This field is required only when UI_COLOR_ALPHA is present.
 struct RSImageColorDescription uiColor;
 // HUD-less color has its own transfer/range/alpha contract, independent of
 // scene-linear radiance and of the UI overlay.
 struct RSImageColorDescription hudlessColor;
 float preExposure;
 uint32_t pass,colorPass,reserved2;
 RSSceneAovImage images[RS_SCENE_AOV_COUNT];
} RSSceneAovs;
// Bind before encoding. The core retains exact attachments through the actual
// borrowed command completion. It never commits or waits on producer commands.
int rsBindTemporalSceneAovs(const RSTemporalFrame*,const RSSceneAovs*);
void rsReleaseTemporalSceneAovs(void *owner);
// One-shot registration for a renderer that records before a Metal command
// buffer exists. Clear on each producer frame boundary and owner destruction.
// Duplicate texture tuples are rejected rather than guessed by size or order.
int rsSetTemporalAovsForTextures(void *owner,void *color,void *depth,void *motion,const RSSceneAovs*);
void rsClearTemporalAovsTextures(void *owner);
typedef struct RSSceneAovRetirement {
 uint32_t size,version;
 void *context;
 void (*retired)(void *context,uint64_t frameId,uint64_t viewId,uint64_t epoch);
} RSSceneAovRetirement;
// On success, context remains valid until exactly one retirement callback on a
// core retirement queue. It marks the end of ALL captured core/GPU/redraw use,
// not just the first source command. The callback must release metadata only;
// producer copy-command ordering remains the producer's responsibility. A
// rejected registration takes no callback ownership.
int rsSetTemporalAovsForTexturesObserved(void *owner,void *color,void *depth,void *motion,const RSSceneAovs*,const RSSceneAovRetirement*);
uint32_t rsSceneAovAPI(void);
// Bit N requests attachment slot N, only for actual selected consumers.
uint32_t rsGetSceneAovDemand(uint32_t version);
#ifdef __cplusplus
}
static_assert(sizeof(RSSceneAovImage)==56,"Scene AOV image ABI1 must be 56 bytes");
static_assert(sizeof(RSSceneAovs)==992,"Scene AOV packet ABI1 must be 992 bytes");
#endif
