#include <cassert>
#include <iostream>
#include "camera.hpp"
static sl::Constants perspective(bool reversed = false, bool rightHanded = false, bool infinite = false) {
    sl::Constants c{};std::memset(&c.cameraViewToClip, 0, sizeof(c.cameraViewToClip));
    c.cameraNear = .1f;c.cameraFar = infinite ? INFINITY : 1000.f;c.cameraFOV = 1.1f;
    c.orthographicProjection = sl::Boolean::eFalse;c.depthInverted = reversed ? sl::Boolean::eTrue : sl::Boolean::eFalse;
    auto m = &c.cameraViewToClip.row[0].x;
    m[0] = m[5] = 1.f / std::tan(c.cameraFOV / 2);m[11] = rightHanded ? -1.f : 1.f;
    const float farDepth = reversed ? 0.f : 1.f, nearDepth = 1.f - farDepth;
    const float b = infinite ? (nearDepth - farDepth) * c.cameraNear : (nearDepth - farDepth) * c.cameraNear * c.cameraFar / (c.cameraFar - c.cameraNear);
    const float a = nearDepth - b / c.cameraNear;
    m[10] = a * m[11];m[14] = b;return c;
}
int main() {
    RSTemporalCamera result{};unsigned checks = 0;
    for (bool reversed : {false, true}) for (bool rh : {false, true}) for (bool infinite : {false, true}) {
        auto c = perspective(reversed, rh, infinite);assert(maclauncher_streamline::camera(c, 0, 37, result));checks++;
        assert(result.frameId == 1 && result.viewportId == 37 && result.frameTimeMs == 0);
        assert(bool(result.flags & RS_TEMPORAL_DEPTH_REVERSED) == reversed && bool(result.flags & RS_TEMPORAL_DEPTH_INFINITE) == infinite);
        c.structVersion = 1;assert(maclauncher_streamline::camera(c, UINT32_MAX, 37, result));checks++;assert(result.frameId == uint64_t(UINT32_MAX) + 1);
        c.reset = sl::Boolean::eTrue;c.motionVectorsJittered = sl::Boolean::eTrue;
        assert(maclauncher_streamline::camera(c, 1, 37, result));checks++;assert((result.flags & (RS_TEMPORAL_RESET | RS_TEMPORAL_JITTERED_MOTION)) == (RS_TEMPORAL_RESET | RS_TEMPORAL_JITTERED_MOTION));
    }
    auto rejected = [&](sl::Constants c) { assert(!maclauncher_streamline::camera(c, 5, 9, result));assert(result.size == 0);checks++; };
    auto c = perspective();c.cameraNear = 0;rejected(c);c = perspective();c.cameraFOV = NAN;rejected(c);
    c = perspective();c.cameraFOV = 2;rejected(c);c = perspective();c.cameraNear = 1;rejected(c);
    c = perspective();c.depthInverted = sl::Boolean::eTrue;rejected(c);c = perspective();c.orthographicProjection = sl::Boolean::eTrue;rejected(c);
    c = perspective();c.structVersion = 3;rejected(c);c = perspective();c.cameraViewToClip.row[2].x = .5;rejected(c);
    c = perspective();c.cameraFar = FLT_MAX;rejected(c);c = perspective();c.cameraFar = -1;rejected(c);
    c = perspective(false, false, true);c.cameraFar = FLT_MAX;assert(maclauncher_streamline::camera(c, 5, 9, result));checks++;
    std::cout << "Streamline projection checks: " << checks << " passed\n";
}
