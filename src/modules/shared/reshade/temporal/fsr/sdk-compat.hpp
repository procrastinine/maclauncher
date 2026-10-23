#pragma once
// Only SDK naming and platform ABI are adapted here. AMD owns both temporal
// schedules, constants, filters and shader implementations.
#if RS_FSR3
#include <FidelityFX/host/ffx_fsr3upscaler.h>
using FfxFsr2Interface=FfxInterface;
using FfxFsr2Context=FfxFsr3UpscalerContext;
using FfxFsr2ContextDescription=FfxFsr3UpscalerContextDescription;
using FfxFsr2DispatchDescription=FfxFsr3UpscalerDispatchDescription;
using FfxFsr2Pass=FfxPass;
#define ffxFsr2ContextCreate ffxFsr3UpscalerContextCreate
#define ffxFsr2ContextDestroy ffxFsr3UpscalerContextDestroy
#define ffxFsr2ContextDispatch ffxFsr3UpscalerContextDispatch
#define FFX_FSR2_ENABLE_HIGH_DYNAMIC_RANGE FFX_FSR3UPSCALER_ENABLE_HIGH_DYNAMIC_RANGE
#define FFX_FSR2_ENABLE_DEPTH_INVERTED FFX_FSR3UPSCALER_ENABLE_DEPTH_INVERTED
#define FFX_FSR2_ENABLE_DEPTH_INFINITE FFX_FSR3UPSCALER_ENABLE_DEPTH_INFINITE
#define FFX_FSR2_ENABLE_DISPLAY_RESOLUTION_MOTION_VECTORS FFX_FSR3UPSCALER_ENABLE_DISPLAY_RESOLUTION_MOTION_VECTORS
#define FFX_FSR2_ENABLE_MOTION_VECTORS_JITTER_CANCELLATION FFX_FSR3UPSCALER_ENABLE_MOTION_VECTORS_JITTER_CANCELLATION
#define FFX_FSR2_ENABLE_AUTO_EXPOSURE FFX_FSR3UPSCALER_ENABLE_AUTO_EXPOSURE
#define FFX_FSR2_ENABLE_DYNAMIC_RESOLUTION FFX_FSR3UPSCALER_ENABLE_DYNAMIC_RESOLUTION
#define uavCount uavTextureCount
#define srvCount srvTextureCount
#define uavResourceBindings uavTextureBindings
#define srvResourceBindings srvTextureBindings
#define cbResourceBindings constantBufferBindings
#define uint32Size num32BitEntries
static constexpr uint32_t temporalMethod=RS_TEMPORAL_FSR3;
static constexpr const char *shaderGroup="fsr3";
inline FfxResourceInternal inputResource(const FfxComputeJobDescription &j,unsigned n){return j.srvTextures[n].resource;}
inline FfxResourceInternal outputResource(const FfxComputeJobDescription &j,unsigned n){return j.uavTextures[n].resource;}
inline unsigned outputMip(const FfxComputeJobDescription &j,unsigned n){return j.uavTextures[n].mip;}
inline unsigned constantSlot(const FfxComputeJobDescription &j,unsigned n){return j.pipeline.constantBufferBindings[n].slotIndex;}
#else
#include "ffx_fsr2.h"
static constexpr uint32_t temporalMethod=RS_TEMPORAL_FSR2;
static constexpr const char *shaderGroup="fsr2";
inline FfxResourceInternal inputResource(const FfxComputeJobDescription &j,unsigned n){return j.srvs[n];}
inline FfxResourceInternal outputResource(const FfxComputeJobDescription &j,unsigned n){return j.uavs[n];}
inline unsigned outputMip(const FfxComputeJobDescription &j,unsigned n){return j.uavMip[n];}
inline unsigned constantSlot(const FfxComputeJobDescription &j,unsigned n){return j.cbSlotIndex[n];}
#endif
