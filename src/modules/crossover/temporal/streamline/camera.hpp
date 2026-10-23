#pragma once
#include <cmath>
#include <cfloat>
#include <cstring>
#include <initializer_list>
#include <sl_core_types.h>
#include "../../../shared/reshade/temporal/camera.h"
#include "../../../shared/reshade/temporal/frame.h"

namespace maclauncher_streamline {
// Streamline's public matrices are unjittered, row-major view-to-clip matrices.
// Restrict this bridge to perspective projections representable by the provider.
inline bool camera(const sl::Constants &value, uint32_t frame, uint32_t viewport, RSTemporalCamera &out) {
    out = {};
    if (value.structType != sl::Constants::s_structType || value.structVersion < 1 || value.structVersion > 2 ||
        value.orthographicProjection != sl::Boolean::eFalse ||
        (value.depthInverted != sl::Boolean::eTrue && value.depthInverted != sl::Boolean::eFalse) ||
        !std::isfinite(value.cameraNear) || value.cameraNear <= 0 || value.cameraNear == FLT_MAX ||
        !std::isfinite(value.cameraFOV) || value.cameraFOV <= 0 || value.cameraFOV >= 3.141592653589793f) return false;
    const float *m = &value.cameraViewToClip.row[0].x;
    for (unsigned i = 0; i < 16; ++i) if (!std::isfinite(m[i]) || m[i] == FLT_MAX) return false;
    const float w = m[11], scale = std::abs(w);
    if (scale < 1e-8f || std::abs(m[0]) < 1e-8f || std::abs(m[5]) < 1e-8f) return false;
    for (unsigned i : {1u, 2u, 3u, 4u, 6u, 7u, 8u, 9u, 12u, 13u, 15u}) if (std::abs(m[i]) > scale * 1e-5f) return false;
    const bool reversed = value.depthInverted == sl::Boolean::eTrue;
    const float nearDepth = reversed ? 1.f : 0.f, farDepth = reversed ? 0.f : 1.f;
    const double a = m[10] / w, b = m[14] / scale;
    if (std::abs(a + b / value.cameraNear - nearDepth) > 5e-4 ||
        std::abs(2 * std::atan(scale / std::abs(m[5])) - value.cameraFOV) > .005) return false;
    bool infinite = false;
    if (std::isfinite(value.cameraFar) && value.cameraFar > value.cameraNear && value.cameraFar < FLT_MAX) {
        if (std::abs(a + b / value.cameraFar - farDepth) > 5e-4) return false;
    } else {
        // FLT_MAX is also Streamline's unspecified sentinel. Only a matrix with
        // an actual infinite far plane makes that camera usable.
        if (!(value.cameraFar == FLT_MAX || std::isinf(value.cameraFar) && value.cameraFar > 0) ||
            std::abs(a - farDepth) > 1e-7) return false;
        infinite = true;
    }
    out.size = sizeof(out); out.version = 1; out.frameId = uint64_t(frame) + 1; out.viewportId = viewport;
    out.nearPlane = value.cameraNear; out.farPlane = infinite ? 0.f : value.cameraFar; out.verticalFov = value.cameraFOV;
    out.flags = (reversed ? RS_TEMPORAL_DEPTH_REVERSED : 0) | (infinite ? RS_TEMPORAL_DEPTH_INFINITE : 0) |
        (value.reset == sl::Boolean::eTrue ? RS_TEMPORAL_RESET : 0) |
        (value.motionVectorsJittered == sl::Boolean::eTrue ? RS_TEMPORAL_JITTERED_MOTION : 0);
    return true;
}
}
