#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// One FidelityFX upscale dispatch as a VKD3D-Proton MetalFX temporal upscale
// (vkd3d_metalfx.h), the values a MacLauncher temporal frame carries
// (vk_temporal_frame.h). Resource fields hold FfxApiResource.resource
// unchanged: ID3D12Resource pointers from the DX12 backend, VkImage handles
// from the Vulkan backend.
#include "scalar-mapping.hpp"
namespace maclauncher::fidelityfx {
inline bool temporalDescription(const ffxCreateContextDescUpscale&create,const ffxDispatchDescUpscale&dispatch,VKD3D_METALFX_TEMPORAL_DESC&desc){
 RSTemporalFrame frame{};
 if(!mapUpscaleScalars(create,dispatch,frame)||!dispatch.color.resource||!dispatch.depth.resource||
    !dispatch.motionVectors.resource||!dispatch.output.resource)return false;
 const auto resource=[](const FfxApiResource&value){return static_cast<ID3D12Resource*>(value.resource);};
 const auto has=[&](unsigned flag){return (frame.flags&flag)?TRUE:FALSE;};
 desc={};
 desc.InputContentWidth=frame.renderWidth;desc.InputContentHeight=frame.renderHeight;
 desc.AutoExposure=has(RS_TEMPORAL_AUTO_EXPOSURE);desc.InReset=has(RS_TEMPORAL_RESET);
 desc.DepthReversed=has(RS_TEMPORAL_DEPTH_REVERSED);desc.MotionVectorInDisplayRes=has(RS_TEMPORAL_OUTPUT_MOTION);
 desc.Color=resource(dispatch.color);desc.Depth=resource(dispatch.depth);
 desc.MotionVector=resource(dispatch.motionVectors);desc.Output=resource(dispatch.output);
 desc.ExposureTexture=desc.AutoExposure?nullptr:resource(dispatch.exposure);
 desc.MotionVectorScaleX=frame.motionScaleX;desc.MotionVectorScaleY=frame.motionScaleY;
 desc.PreExposure=frame.preExposure;desc.JitterOffsetX=frame.jitterX;desc.JitterOffsetY=frame.jitterY;
 desc.Hdr=(create.flags&FFX_UPSCALE_ENABLE_HIGH_DYNAMIC_RANGE)?TRUE:FALSE;
 desc.MotionVectorJittered=has(RS_TEMPORAL_JITTERED_MOTION);
 desc.CameraValid=has(RS_TEMPORAL_CAMERA_VALID);desc.DepthInfinite=has(RS_TEMPORAL_DEPTH_INFINITE);
 desc.NearPlane=frame.nearPlane;desc.FarPlane=frame.farPlane;desc.VerticalFov=frame.verticalFov;
 desc.FrameTimeMs=frame.frameTimeMs;desc.Sharpness=frame.sharpness;
 // FSR's reactive mask and its transparency-and-composition mask cover the render extent from the origin.
 desc.ReactiveMask=resource(dispatch.reactive);desc.TransparencyMask=resource(dispatch.transparencyAndComposition);
 return true;
}
}
