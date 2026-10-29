// Copyright (c) MacLauncher contributors. MIT license.
#include "adaptive-quality.hpp"
#include <algorithm>
#include <cmath>
#include <mutex>
#include <stdexcept>
namespace macfx {
struct AdaptiveQualityController::Impl {
 mutable std::mutex lock;AdaptiveQualitySettings settings;AdaptiveQualityStatus status;
 uint64_t epoch=0,lastSequence=0,lastContent=0,requests=0;unsigned expensive=0,spare=0,cooldown=0;
 void history(){status.meanMilliseconds=0;status.samples=0;expensive=spare=0;}
};
AdaptiveQualityController::AdaptiveQualityController():impl(std::make_unique<Impl>()){}
AdaptiveQualityController::~AdaptiveQualityController()=default;
void AdaptiveQualityController::configure(const AdaptiveQualitySettings&settings,double appliedScale){
 if(!std::isfinite(settings.budgetMs)||settings.budgetMs<.25||settings.budgetMs>1000||!std::isfinite(settings.minScale)||!std::isfinite(settings.maxScale)||settings.minScale<1./16||settings.maxScale>1||settings.minScale>settings.maxScale||!std::isfinite(appliedScale)||(settings.enabled?(appliedScale<settings.minScale||appliedScale>settings.maxScale):(appliedScale<=0||appliedScale>16)))throw std::invalid_argument("Adaptive quality requires a finite budget and an applied scale inside the selected bounds");
 std::lock_guard<std::mutex>guard(impl->lock);impl->settings=settings;impl->status={settings.enabled,appliedScale,0,std::nullopt,0,0};impl->epoch=impl->lastSequence=impl->lastContent=0;impl->expensive=impl->spare=impl->cooldown=0;
}
std::optional<AdaptiveQualityDecision>AdaptiveQualityController::observe(const AdaptiveQualitySample&sample){
 std::lock_guard<std::mutex>guard(impl->lock);auto&state=*impl;
 if(!state.settings.enabled||!sample.real||sample.redraw||!sample.sequence||!sample.contentId||!std::isfinite(sample.milliseconds)||sample.milliseconds<=0)return std::nullopt;
 if(state.epoch!=sample.epoch){state.epoch=sample.epoch;state.lastSequence=state.lastContent=0;state.status.pendingScale.reset();state.status.pendingRequestId=0;state.history();state.cooldown=0;}
 if(sample.sequence<=state.lastSequence||sample.contentId<=state.lastContent)return std::nullopt;
 state.lastSequence=sample.sequence;state.lastContent=sample.contentId;
 // Pending work still uses the previous execution; it cannot describe the
 // candidate's cost. The first adopted real frame starts a fresh estimate.
 if(state.status.pendingScale)return std::nullopt;
 state.status.meanMilliseconds=state.status.samples?state.status.meanMilliseconds*.875+sample.milliseconds*.125:sample.milliseconds;state.status.samples++;
 if(state.cooldown){state.cooldown--;return std::nullopt;}
 const double mean=state.status.meanMilliseconds,budget=state.settings.budgetMs;
 state.expensive=mean>budget*1.1?state.expensive+1:0;state.spare=mean<budget*.8?state.spare+1:0;
 const bool down=state.expensive>=6,up=state.spare>=60;
 if(!down&&!up)return std::nullopt;
 const double current=state.status.scale;
 double next=down?std::floor((current-1./16)*16+1.e-8)/16:std::ceil((current+1./16)*16-1.e-8)/16;
 next=std::clamp(next,state.settings.minScale,state.settings.maxScale);state.expensive=state.spare=0;
 if(std::abs(next-current)<1.e-8)return std::nullopt;
 state.status.pendingScale=next;state.status.pendingRequestId=++state.requests;return AdaptiveQualityDecision{state.status.pendingRequestId,next,mean,down};
}
bool AdaptiveQualityController::adopted(uint64_t requestId,double scale){std::lock_guard<std::mutex>guard(impl->lock);if(!impl->settings.enabled||!impl->status.pendingScale||!requestId||requestId!=impl->status.pendingRequestId)return false;if(!std::isfinite(scale)||std::abs(scale-*impl->status.pendingScale)>1.e-8)throw std::invalid_argument("The adopted adaptive scale does not match its pending request");impl->status.scale=scale;impl->status.pendingScale.reset();impl->status.pendingRequestId=0;impl->history();impl->cooldown=20;return true;}
bool AdaptiveQualityController::rejected(uint64_t requestId){std::lock_guard<std::mutex>guard(impl->lock);if(!requestId||!impl->status.pendingScale||requestId!=impl->status.pendingRequestId)return false;impl->status.pendingScale.reset();impl->status.pendingRequestId=0;impl->expensive=impl->spare=0;impl->cooldown=60;return true;}
AdaptiveQualityStatus AdaptiveQualityController::snapshot()const{std::lock_guard<std::mutex>guard(impl->lock);return impl->status;}
}
