// SPDX-License-Identifier: MIT
#pragma once
#include "temporal-carrier.h"
#include "frame.h"
#include <cmath>
#include <algorithm>
// Pure value mapping shared by the native consumer and its CPU fixture. The
// caller supplies actual resolved view extents; offsets never underflow.
inline bool mvkTemporalMap(const VkTemporalFrameInfoMVK& i, uint32_t cw, uint32_t ch,
                          uint32_t dw, uint32_t dh, uint32_t mw, uint32_t mh,
                          uint32_t ow, uint32_t oh, RSTemporalFrame& f) {
    if (!i.frameId || !i.featureId || (i.featureType != TEMPORAL_SUPER_RESOLUTION && i.featureType != TEMPORAL_RAY_RECONSTRUCTION) ||
        i.colorX >= cw || i.colorY >= ch || i.depthX >= dw || i.depthY >= dh ||
        i.motionX >= mw || i.motionY >= mh || i.outputX >= ow || i.outputY >= oh) return false;
    f.size=sizeof(f); f.version=1; f.frameId=i.frameId;
    f.renderWidth=i.renderWidth?i.renderWidth:cw-i.colorX;
    f.renderHeight=i.renderHeight?i.renderHeight:ch-i.colorY;
    f.outputWidth=i.outputWidth?i.outputWidth:ow-i.outputX;
    f.outputHeight=i.outputHeight?i.outputHeight:oh-i.outputY;
    f.maxRenderWidth=std::min(cw-i.colorX,dw-i.depthX);
    f.maxRenderHeight=std::min(ch-i.colorY,dh-i.depthY);
    const bool displayMotion=i.flags&TEMPORAL_MOTION_DISPLAY_RES;
    if (!f.renderWidth || !f.renderHeight || !f.outputWidth || !f.outputHeight ||
        f.renderWidth>f.maxRenderWidth || f.renderHeight>f.maxRenderHeight ||
        f.outputWidth>ow-i.outputX || f.outputHeight>oh-i.outputY ||
        (displayMotion?f.outputWidth:f.renderWidth)>mw-i.motionX ||
        (displayMotion?f.outputHeight:f.renderHeight)>mh-i.motionY) return false;
    f.colorX=i.colorX; f.colorY=i.colorY; f.depthX=i.depthX; f.depthY=i.depthY;
    f.motionX=i.motionX; f.motionY=i.motionY; f.outputX=i.outputX; f.outputY=i.outputY;
    f.flags=(i.flags&TEMPORAL_RESET?RS_TEMPORAL_RESET:0) |
        (i.flags&TEMPORAL_DEPTH_REVERSED?RS_TEMPORAL_DEPTH_REVERSED:0) |
        (i.flags&TEMPORAL_HDR?RS_TEMPORAL_HDR:0) |
        (i.flags&TEMPORAL_AUTO_EXPOSURE?RS_TEMPORAL_AUTO_EXPOSURE:0) |
        (i.flags&TEMPORAL_MOTION_JITTERED?RS_TEMPORAL_JITTERED_MOTION:0) |
        (displayMotion?RS_TEMPORAL_OUTPUT_MOTION:0);
    if (i.flags&TEMPORAL_CAMERA_VALID) {
        if (!std::isfinite(i.nearPlane) || i.nearPlane<=0 || !std::isfinite(i.verticalFov) ||
            i.verticalFov<=0 || i.verticalFov>=3.14159265358979323846f ||
            ((i.flags&TEMPORAL_DEPTH_INFINITE)?i.farPlane!=0:
              (!std::isfinite(i.farPlane)||i.farPlane<=i.nearPlane))) return false;
        f.flags|=RS_TEMPORAL_CAMERA_VALID;
        if(i.flags&TEMPORAL_DEPTH_INFINITE)f.flags|=RS_TEMPORAL_DEPTH_INFINITE;
        f.nearPlane=i.nearPlane; f.farPlane=i.farPlane; f.verticalFov=i.verticalFov;
    }
    f.jitterX=i.jitterOffsetX; f.jitterY=i.jitterOffsetY;
    f.motionScaleX=i.motionVectorScaleX; f.motionScaleY=i.motionVectorScaleY;
    f.preExposure=i.preExposure>0?i.preExposure:1.f;
    f.sharpness=i.sharpness; f.frameTimeMs=i.frameTimeMs;
    return std::isfinite(f.jitterX)&&std::isfinite(f.jitterY)&&
        std::isfinite(f.motionScaleX)&&std::isfinite(f.motionScaleY)&&
        std::isfinite(i.preExposure)&&i.preExposure>=0&&std::isfinite(f.sharpness)&&
        std::isfinite(f.frameTimeMs)&&f.frameTimeMs>=0;
}
