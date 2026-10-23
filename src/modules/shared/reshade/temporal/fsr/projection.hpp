#pragma once
#include "../frame.h"
#include <limits>

// The shared ABI uses physical near/far distances, with zero as the infinite
// far sentinel. FidelityFX requires FLT_MAX and depth-oriented plane ordering.
inline void rsFsrCameraPlanes(const RSTemporalFrame &frame, float &nearPlane, float &farPlane) {
    const float farDistance = frame.flags & RS_TEMPORAL_DEPTH_INFINITE
        ? std::numeric_limits<float>::max() : frame.farPlane;
    const bool reversed = frame.flags & RS_TEMPORAL_DEPTH_REVERSED;
    nearPlane = reversed ? farDistance : frame.nearPlane;
    farPlane = reversed ? frame.nearPlane : farDistance;
}
