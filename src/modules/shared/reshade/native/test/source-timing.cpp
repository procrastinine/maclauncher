#include "source-timing.hpp"
#include <cassert>
#include <limits>

int main() {
    using namespace macfx;
    assert(configuredSourceInterval(0) == 0);
    for (double rate : {1., 23.976, 24., 29.97, 30., 59.94, 60., 72.5, 120., 240., 360., 480., 1000., 10000.}) {
        const double period = configuredSourceInterval(rate);
        assert(period > 0 && std::abs(period * rate - 1) < 1e-12);
        if (rate >= 1) {
            const double measured = measuredSourcePeriod(10 + period, 10, 1. / 60);
            assert(std::abs(measured - period) < 1e-12);
            assert(boundedSourcePeriod(period) == period);
            assert(std::abs(updateSourceInterval(period, measured) - period) < 1e-12);
        }
    }
    for (double rate : {-1., .5, std::numeric_limits<double>::infinity(),
                        std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::denorm_min()}) {
        bool rejected = false;
        try { configuredSourceInterval(rate); } catch (const std::runtime_error &) { rejected = true; }
        assert(rejected);
    }
    assert(measuredSourcePeriod(10, 0, .02) == .02);
    assert(measuredSourcePeriod(20, 10, .02) == 1);
    for (double sample : {0., -1., 10., std::numeric_limits<double>::infinity(),
                          std::numeric_limits<double>::quiet_NaN()})
        assert(updateSourceInterval(.02, sample) == .02);
    assert(updateSourceInterval(.02, 1. / 480) < .02);
    // Fractional and arbitrary rates exercise a continuous calculation.
    for (unsigned index = 1; index <= 10000; ++index) {
        const double rate = 1 + index * .731;
        const double period = configuredSourceInterval(rate);
        assert(std::abs(period * rate - 1) < 1e-12);
        assert(boundedSourcePeriod(period) == period);
    }
}
