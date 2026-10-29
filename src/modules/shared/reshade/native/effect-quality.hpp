#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "adaptive-quality.hpp"
#include "runtime-status.hpp"
#include <string>
namespace macfx {
struct EffectPlanSnapshot;
enum class EffectQualityPoint {Source,Final,Scene,Offline};
struct EffectQualityRequest {std::string key,nodeId;double scale=1;uint64_t requestId=0;};
struct EffectQualityStatus {
 bool requested=false;std::string nodeId,reason;double scale=1,meanMilliseconds=0;
 RuntimeAdaptiveQualityScope scope=RuntimeAdaptiveQualityScope::Unknown;
};
// One owner and its accepted immutable executions share this metadata policy.
// GPU objects and rendering remain in the executor and producer.
class EffectQualitySession {
 struct Impl;std::unique_ptr<Impl>impl;
public:
 EffectQualitySession();~EffectQualitySession();
 std::shared_ptr<const EffectPlanSnapshot>select(std::shared_ptr<const EffectPlanSnapshot>);
 uint64_t adopted(const EffectQualityRequest&,EffectQualityPoint,std::string timingReason);
 void rejected(const EffectQualityRequest&,std::string reason);
 void preparing(const EffectQualityRequest&,std::string reason);
 void timingUnavailable(const EffectQualityRequest&,uint64_t adoption,EffectQualityPoint,std::string reason);
 void observe(const EffectQualityRequest&,uint64_t adoption,const AdaptiveQualitySample&,EffectQualityPoint,RuntimeAdaptiveQualityScope);
 uint64_t nextSequence()noexcept;
 bool supports(const EffectQualityRequest&,uint64_t adoption,EffectQualityPoint)const;
 EffectQualityStatus status()const;
 void publish(uintptr_t context,std::string_view revision)const noexcept;
};
}
extern "C" uint32_t rsAdaptiveQualityAPI(void);
