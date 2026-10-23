// SPDX-License-Identifier: GPL-3.0-or-later
#include "adaptive-pacing.hpp"
#include "adaptive_scheduler.hpp"
#include <algorithm>
#include <cmath>
#include <optional>
#include <stdexcept>
namespace {
using Scheduler=mako::layer::AdaptiveScheduler;
using Config=mako::layer::AdaptiveSchedulerConfig;
using Clock=Scheduler::Clock;
Clock::time_point timePoint(double seconds){return Clock::time_point(std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(seconds)));}
bool validTime(double value){return std::isfinite(value)&&value>0&&value<1e9;}
Config upstreamConfig(const macfx::AdaptivePacingConfig&input){
    if(!input.targetHz||input.targetHz>1000||input.displayRefreshHz>1000)throw std::invalid_argument("Invalid target or display refresh rate");
    Config config;config.targetFps=input.displayRefreshHz?std::min(input.targetHz,input.displayRefreshHz):input.targetHz;
    config.maximumMultiplier=input.maximumMultiplier;
    config.generatedFrameCapacity=input.maximumMultiplier?input.maximumMultiplier-1:0;
    config.stableCadence=input.stableCadence;
    // This host does not throttle game rendering. Its source cadence is measured.
    config.automaticBaseFpsCap=false;
    config.nearTargetNativePreference=input.preferNativeNearTarget;
    config.dynamicCadenceRecovery=true;
    if(input.displayRefreshHz)config.displayRefreshFps=input.displayRefreshHz;
    config.recoveryPolicy=mako::layer::AdaptiveRecoveryPolicy::OrderedSdr;
    return config;
}
macfx::InterpolationPlan copyPlan(const mako::layer::GeneratedFramePlan&input){
    macfx::InterpolationPlan result;result.count=input.size();
    std::copy(input.begin(),input.end(),result.timestamps.begin());return result;
}
}
struct macfx::AdaptivePacing::Impl {
    Config config;Scheduler scheduler;AdaptivePacingStatus status;
    uint64_t lastSourceId=0;
    double firstSourceTime=0,lastSourceTime=0,firstDisplayTime=0,lastDisplayTime=0;
    std::array<double,8>displayTimes{};unsigned displayCursor=0;
    explicit Impl(const AdaptivePacingConfig&input):config(upstreamConfig(input)),scheduler(config){status.effectiveTargetHz=config.targetFps;}
    void reset(){scheduler=Scheduler(config);lastSourceId=0;firstSourceTime=lastSourceTime=firstDisplayTime=lastDisplayTime=0;displayTimes.fill(0);displayCursor=0;status={};status.effectiveTargetHz=config.targetFps;}
};
macfx::AdaptivePacing::AdaptivePacing(const AdaptivePacingConfig&config):impl(std::make_unique<Impl>(config)){}
macfx::AdaptivePacing::~AdaptivePacing()=default;
macfx::AdaptiveDecision macfx::AdaptivePacing::observe(uint64_t sourceId,double sourceSubmittedAt,bool historyReady,unsigned availableOutputSlots,bool acquisitionBackoff){
    AdaptiveDecision decision;decision.sourceId=sourceId;decision.sourceSubmittedAt=sourceSubmittedAt;
    if(!sourceId||sourceId<=impl->lastSourceId||!validTime(sourceSubmittedAt)||sourceSubmittedAt<=impl->lastSourceTime){++impl->status.rejectedObservations;return decision;}
    const auto now=timePoint(sourceSubmittedAt);
    if(!impl->lastSourceId)impl->scheduler.beginStabilization(now,"source-start");
    impl->lastSourceId=sourceId;impl->lastSourceTime=sourceSubmittedAt;
    if(!impl->firstSourceTime)impl->firstSourceTime=sourceSubmittedAt;
    ++impl->status.sourceObservations;
    const auto request=impl->scheduler.planFrame(now,acquisitionBackoff);
    // Policy history is a bounded source-cadence warm-up. Neural history remains
    // a separate host fact and cannot be fabricated from arriving callbacks.
    if(impl->scheduler.historyWarmupActive())impl->scheduler.consumeHistoryWarmupFrame(now);
    decision.valid=true;decision.requested=copyPlan(request);decision.needsHistory=!request.empty()&&!historyReady;
    // Reserve output capacity for the newest real frame. Insufficient synthetic
    // capacity reduces generation; it never creates a backlog or blocks source.
    const unsigned syntheticSlots=availableOutputSlots?std::min(4u,availableOutputSlots-1):0;
    const unsigned admitted=historyReady?std::min(unsigned(request.size()),syntheticSlots):0;
    decision.admitted=copyPlan(mako::layer::scheduleAdmittedGeneratedFrames(request,admitted));
    impl->status.requestedGenerated+=request.size();impl->status.admittedGenerated+=admitted;
    impl->status.validatedGeneratedLimit=impl->scheduler.validatedGenerationLimit();
    return decision;
}
void macfx::AdaptivePacing::reportDelivery(unsigned requested,unsigned acceptedForPresentation){
    if(requested>4||acceptedForPresentation>requested)throw std::invalid_argument("Invalid generated-frame delivery counts");
    impl->scheduler.reportGeneratedFrameDelivery({requested,acceptedForPresentation});
}
bool macfx::AdaptivePacing::reportPresented(bool generated,double sourceSubmittedAt,double displayedAt){
    if(!validTime(sourceSubmittedAt)||!validTime(displayedAt)||displayedAt<sourceSubmittedAt||
       std::find(impl->displayTimes.begin(),impl->displayTimes.end(),displayedAt)!=impl->displayTimes.end()){
        ++impl->status.rejectedDisplayTimes;return false;
    }
    impl->displayTimes[impl->displayCursor++%impl->displayTimes.size()]=displayedAt;
    if(!impl->firstDisplayTime||displayedAt<impl->firstDisplayTime)impl->firstDisplayTime=displayedAt;
    impl->lastDisplayTime=std::max(impl->lastDisplayTime,displayedAt);
    if(generated)++impl->status.presentedGenerated;else ++impl->status.presentedReal;
    impl->status.lastLatencyMs=(displayedAt-sourceSubmittedAt)*1000;return true;
}
void macfx::AdaptivePacing::reset(){impl->reset();}
macfx::AdaptivePacingStatus macfx::AdaptivePacing::snapshot()const{
    auto result=impl->status;
    if(result.sourceObservations>1&&impl->lastSourceTime>impl->firstSourceTime)result.observedSourceHz=double(result.sourceObservations-1)/(impl->lastSourceTime-impl->firstSourceTime);
    const auto displayed=result.presentedReal+result.presentedGenerated;
    if(displayed>1&&impl->lastDisplayTime>impl->firstDisplayTime)result.observedPresentationHz=double(displayed-1)/(impl->lastDisplayTime-impl->firstDisplayTime);
    return result;
}
