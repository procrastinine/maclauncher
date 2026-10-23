// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <array>
#include <cstdint>
#include <memory>
namespace macfx {
struct AdaptivePacingConfig {
    unsigned targetHz=120,maximumMultiplier=2,displayRefreshHz=0;
    bool stableCadence=false,preferNativeNearTarget=true;
};
struct InterpolationPlan {
    std::array<float,4> timestamps{};
    unsigned count=0;
};
struct AdaptiveDecision {
    uint64_t sourceId=0;
    double sourceSubmittedAt=0;
    InterpolationPlan requested,admitted;
    bool valid=false,needsHistory=false;
};
struct AdaptivePacingStatus {
    uint64_t sourceObservations=0,rejectedObservations=0,requestedGenerated=0,admittedGenerated=0;
    uint64_t presentedReal=0,presentedGenerated=0,rejectedDisplayTimes=0;
    unsigned effectiveTargetHz=0,validatedGeneratedLimit=0;
    double observedSourceHz=0,observedPresentationHz=0,lastLatencyMs=0;
};
// No clock reads, GPU resources, callbacks or frame queues. The source timestamp
// is the producer's submission boundary, not a callback/adapter arrival time.
// This reports observed source cadence, never an engine's internal render FPS.
// The host serializes calls and preserves its original real-frame output.
class AdaptivePacing {
public:
    explicit AdaptivePacing(const AdaptivePacingConfig&);
    ~AdaptivePacing();
    AdaptiveDecision observe(uint64_t sourceId,double sourceSubmittedAt,bool historyReady,
                             unsigned availableOutputSlots,bool acquisitionBackoff=false);
    // Submission acceptance is distinct from actual positive display timestamps.
    void reportDelivery(unsigned requested,unsigned acceptedForPresentation);
    bool reportPresented(bool generated,double sourceSubmittedAt,double displayedAt);
    void reset();
    AdaptivePacingStatus snapshot()const;
private:struct Impl;std::unique_ptr<Impl> impl;
};
}
