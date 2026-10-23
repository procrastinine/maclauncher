#pragma once
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace macfx {
inline double configuredSourceInterval(double rate) {
    if (!std::isfinite(rate) || rate < 0 || (rate > 0 && rate < 1)) throw std::runtime_error("Invalid source frame rate");
    if (rate == 0) return 0;
    const double interval = 1 / rate;
    if (!std::isfinite(interval) || interval <= 0) throw std::runtime_error("Invalid source frame rate");
    return interval;
}
inline double boundedSourcePeriod(double sample) {
    // Long interruptions do not extend interpolation across a paused source.
    // Short periods retain their real duration, including above 240 Hz.
    return std::min(sample, 1.0);
}
inline double measuredSourcePeriod(double current, double previous, double fallback) {
    return previous > 0 ? boundedSourcePeriod(current - previous) : fallback;
}
inline double updateSourceInterval(double interval, double sample) {
    return std::isfinite(sample) && sample > 0 && sample <= 1 ? interval * .8 + sample * .2 : interval;
}
}
