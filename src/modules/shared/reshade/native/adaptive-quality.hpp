#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
namespace macfx {
struct AdaptiveQualitySettings {
 bool enabled=false;double budgetMs=8,minScale=.5,maxScale=1;std::string nodeId;
};
struct AdaptiveQualitySample {
 uint64_t sequence=0,contentId=0,epoch=0;
 double milliseconds=0;
 bool real=true,redraw=false;
};
struct AdaptiveQualityDecision {uint64_t requestId=0;double scale=1,meanMilliseconds=0;bool overBudget=false;};
struct AdaptiveQualityStatus {
 bool enabled=false;double scale=1,meanMilliseconds=0;
 std::optional<double>pendingScale;uint64_t pendingRequestId=0,samples=0;
};
// Metadata policy only. A producer supplies timings from completed GPU work;
// no render-rate cap, provider substitution or image processing occurs here.
// A decision remains pending until the producer adopts or rejects its ordinary
// async graph replacement, so slow preparation cannot produce oscillations.
class AdaptiveQualityController {
 struct Impl;std::unique_ptr<Impl>impl;
public:
 AdaptiveQualityController();~AdaptiveQualityController();
 void configure(const AdaptiveQualitySettings&,double appliedScale);
 std::optional<AdaptiveQualityDecision>observe(const AdaptiveQualitySample&);
 bool adopted(uint64_t requestId,double scale);
 bool rejected(uint64_t requestId);
 AdaptiveQualityStatus snapshot()const;
};
}
