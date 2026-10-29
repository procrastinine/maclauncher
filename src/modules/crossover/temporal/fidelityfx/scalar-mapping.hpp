#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <ffx_api/ffx_upscale.h>
#include "../../../shared/reshade/temporal/frame.h"
#include <cmath>

namespace maclauncher::fidelityfx {
// The native frame and the fixed-width Wine frame share these scalar fields.
// Resource handles, owner identities, callbacks and clocks belong to callers.
template<class Frame>
bool mapUpscaleScalars(const ffxCreateContextDescUpscale&create,
                       const ffxDispatchDescUpscale&dispatch,Frame&frame){
 if(dispatch.header.type!=FFX_API_DISPATCH_DESC_TYPE_UPSCALE||dispatch.header.pNext||
    !std::isfinite(dispatch.frameTimeDelta)||dispatch.frameTimeDelta<0||
    !std::isfinite(dispatch.preExposure)||dispatch.preExposure<=0)return false;
 if(bool(dispatch.upscaleSize.width)!=bool(dispatch.upscaleSize.height))return false;
 frame.renderWidth=dispatch.renderSize.width;frame.renderHeight=dispatch.renderSize.height;
 frame.maxRenderWidth=create.maxRenderSize.width;frame.maxRenderHeight=create.maxRenderSize.height;
 frame.outputWidth=dispatch.upscaleSize.width?dispatch.upscaleSize.width:create.maxUpscaleSize.width;
 frame.outputHeight=dispatch.upscaleSize.height?dispatch.upscaleSize.height:create.maxUpscaleSize.height;
 if(!frame.renderWidth||!frame.renderHeight||!frame.outputWidth||!frame.outputHeight||
    frame.renderWidth>frame.maxRenderWidth||frame.renderHeight>frame.maxRenderHeight)return false;
 frame.colorX=frame.colorY=frame.depthX=frame.depthY=frame.motionX=frame.motionY=frame.outputX=frame.outputY=0;
 frame.jitterX=dispatch.jitterOffset.x;frame.jitterY=dispatch.jitterOffset.y;
 frame.motionScaleX=dispatch.motionVectorScale.x;frame.motionScaleY=dispatch.motionVectorScale.y;
 frame.frameTimeMs=dispatch.frameTimeDelta;frame.preExposure=dispatch.preExposure;
 frame.sharpness=dispatch.enableSharpening?dispatch.sharpness:0;
 constexpr unsigned flags=RS_TEMPORAL_RESET|RS_TEMPORAL_DEPTH_REVERSED|RS_TEMPORAL_DEPTH_INFINITE|
   RS_TEMPORAL_OUTPUT_MOTION|RS_TEMPORAL_JITTERED_MOTION|RS_TEMPORAL_AUTO_EXPOSURE|RS_TEMPORAL_CAMERA_VALID;
 frame.flags&=~flags;
 if(dispatch.reset)frame.flags|=RS_TEMPORAL_RESET;
 if(create.flags&FFX_UPSCALE_ENABLE_DEPTH_INVERTED)frame.flags|=RS_TEMPORAL_DEPTH_REVERSED;
 if(create.flags&FFX_UPSCALE_ENABLE_DEPTH_INFINITE)frame.flags|=RS_TEMPORAL_DEPTH_INFINITE;
 if(create.flags&FFX_UPSCALE_ENABLE_DISPLAY_RESOLUTION_MOTION_VECTORS)frame.flags|=RS_TEMPORAL_OUTPUT_MOTION;
 if(create.flags&FFX_UPSCALE_ENABLE_MOTION_VECTORS_JITTER_CANCELLATION)frame.flags|=RS_TEMPORAL_JITTERED_MOTION;
 if(create.flags&FFX_UPSCALE_ENABLE_AUTO_EXPOSURE)frame.flags|=RS_TEMPORAL_AUTO_EXPOSURE;
 // SDK planes follow depth direction; the shared frame uses physical distances
 // and far=0 for infinity. Invalid optional camera data stays unknown.
 const bool reversed=frame.flags&RS_TEMPORAL_DEPTH_REVERSED,infinite=frame.flags&RS_TEMPORAL_DEPTH_INFINITE;
 frame.nearPlane=reversed?dispatch.cameraFar:dispatch.cameraNear;
 frame.farPlane=infinite?0.f:reversed?dispatch.cameraNear:dispatch.cameraFar;
 frame.verticalFov=dispatch.cameraFovAngleVertical;
 if(std::isfinite(frame.nearPlane)&&frame.nearPlane>0&&
    (infinite||(std::isfinite(frame.farPlane)&&frame.farPlane>frame.nearPlane))&&
    std::isfinite(frame.verticalFov)&&frame.verticalFov>0&&frame.verticalFov<3.1415927f)
  frame.flags|=RS_TEMPORAL_CAMERA_VALID;
 return true;
}
}
