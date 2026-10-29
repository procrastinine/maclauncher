// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-quality.hpp"
#include "effects-plan.hpp"
#include <algorithm>
#include <cmath>
#include <mutex>
#include <atomic>
namespace macfx {
struct EffectQualitySession::Impl {
 mutable std::mutex mutex;AdaptiveQualityController controller;AdaptiveQualitySettings settings;
 std::string sourceKey,key,reason,timingReason;EffectQualityPoint point=EffectQualityPoint::Source;
 RuntimeAdaptiveQualityScope scope=RuntimeAdaptiveQualityScope::Unknown;
 bool validTarget=false,hasSample=false,rejected=false,boundsPending=false;std::shared_ptr<const EffectPlanSnapshot>base,cached;
 double cachedScale=0;uint64_t cachedRequest=0;
 std::atomic<uint64_t>issued{0};uint64_t generation=0,latestSequence=0,acceptedRequest=0,adoptions=0,adoption=0;double acceptedScale=1;bool accepted=false;
};
EffectQualitySession::EffectQualitySession():impl(std::make_unique<Impl>()){}
EffectQualitySession::~EffectQualitySession()=default;
std::shared_ptr<const EffectPlanSnapshot>EffectQualitySession::select(std::shared_ptr<const EffectPlanSnapshot>source){
 std::lock_guard guard(impl->mutex);auto&s=*impl;const auto&settings=source->output.adaptiveQuality;
 const auto key=source->revision+':'+settings.nodeId+':'+std::to_string(settings.enabled)+':'+std::to_string(settings.budgetMs)+':'+std::to_string(settings.minScale)+':'+std::to_string(settings.maxScale);
 if(s.sourceKey!=key){
  s.sourceKey=key;s.key=key+':'+std::to_string(++s.generation);s.settings=settings;s.reason.clear();s.timingReason.clear();s.scope=RuntimeAdaptiveQualityScope::Unknown;s.hasSample=false;s.rejected=false;s.base.reset();s.cached.reset();s.accepted=false;s.acceptedRequest=0;s.latestSequence=s.issued.load();
  const auto node=std::find_if(source->nodes.begin(),source->nodes.end(),[&](const auto&n){return n.id==settings.nodeId&&n.enabled;});
  s.validTarget=settings.enabled&&node!=source->nodes.end()&&(node->kind=="spatial"&&(node->method=="downsample"||node->resizeDirection=="downsample")||node->kind=="shader"&&(node->outputWidth||node->outputHeight||node->presentationScale||node->resolutionAuto||node->outputPresentation));
  s.boundsPending=s.validTarget&&std::clamp(1.,settings.minScale,settings.maxScale)!=1.;
  auto active=settings;active.enabled=s.validTarget&&!s.boundsPending;s.controller.configure(active,1.);
  if(settings.enabled&&!s.validTarget)s.reason="Adaptive size needs an enabled Downsample or shader with an editable output extent";
 }
 if(!settings.enabled){s.base=source;s.cached=source;return source;}
 const auto status=s.controller.snapshot();const double scale=s.validTarget?status.pendingScale.value_or(status.scale):1.;const uint64_t request=status.pendingScale?status.pendingRequestId:s.acceptedRequest;
 if(s.cached&&s.base==source&&s.cachedScale==scale&&s.cachedRequest==request)return s.cached;
 auto selected=std::make_shared<EffectPlanSnapshot>(*source);for(auto&node:selected->nodes)node.workingScale=node.id==settings.nodeId&&s.validTarget?scale:1.;
 selected->quality=std::make_shared<EffectQualityRequest>(EffectQualityRequest{s.key,settings.nodeId,scale,request});s.base=std::move(source);s.cached=selected;s.cachedScale=scale;s.cachedRequest=request;return selected;
}
uint64_t EffectQualitySession::adopted(const EffectQualityRequest&request,EffectQualityPoint point,std::string timingReason){std::lock_guard guard(impl->mutex);auto&s=*impl;if(request.key!=s.key)return 0;if(request.requestId!=s.acceptedRequest){if(!s.controller.adopted(request.requestId,request.scale))return 0;}else if(s.accepted){auto active=s.settings;active.enabled=s.validTarget&&(!s.boundsPending||request.scale<=s.settings.maxScale);s.controller.configure(active,request.scale);}s.hasSample=false;s.latestSequence=s.issued.load();s.adoption=++s.adoptions;s.accepted=true;s.acceptedRequest=request.requestId;s.acceptedScale=request.scale;s.point=point;s.rejected=false;s.timingReason=std::move(timingReason);s.reason=s.validTarget?s.timingReason:s.reason;
 if(s.boundsPending&&s.timingReason.empty()){auto active=s.settings;active.enabled=true;const auto bounded=std::clamp(1.,active.minScale,active.maxScale);s.controller.configure(active,bounded);s.boundsPending=request.scale!=bounded;s.cached.reset();}
 if(s.reason.empty())s.reason=s.boundsPending?"Preparing the requested adaptive bounds":"Waiting for a completed representative GPU interval";return s.adoption;}
void EffectQualitySession::rejected(const EffectQualityRequest&request,std::string reason){std::lock_guard guard(impl->mutex);auto&s=*impl;if(request.key!=s.key)return;if(request.requestId)s.controller.rejected(request.requestId);else if(s.boundsPending){auto inactive=s.settings;inactive.enabled=false;s.controller.configure(inactive,s.acceptedScale);}s.reason=std::move(reason);s.rejected=true;s.cached.reset();}
void EffectQualitySession::preparing(const EffectQualityRequest&request,std::string reason){std::lock_guard guard(impl->mutex);if(request.key==impl->key)impl->reason=reason.empty()?"Preparing the requested adaptive working extent":std::move(reason);}
void EffectQualitySession::timingUnavailable(const EffectQualityRequest&request,uint64_t adoption,EffectQualityPoint point,std::string reason){std::lock_guard guard(impl->mutex);auto&s=*impl;if(request.key==s.key&&s.accepted&&adoption==s.adoption&&request.requestId==s.acceptedRequest&&request.scale==s.acceptedScale&&(point==s.point||point==EffectQualityPoint::Offline))s.reason=std::move(reason);}
bool EffectQualitySession::supports(const EffectQualityRequest&request,uint64_t adoption,EffectQualityPoint point)const{std::lock_guard guard(impl->mutex);const auto&s=*impl;return request.key==s.key&&s.accepted&&adoption==s.adoption&&request.requestId==s.acceptedRequest&&request.scale==s.acceptedScale&&s.validTarget&&!s.boundsPending&&s.timingReason.empty()&&(point==EffectQualityPoint::Offline||point==s.point);}
uint64_t EffectQualitySession::nextSequence()noexcept{return ++impl->issued;}
void EffectQualitySession::observe(const EffectQualityRequest&request,uint64_t adoption,const AdaptiveQualitySample&sample,EffectQualityPoint point,RuntimeAdaptiveQualityScope scope){std::lock_guard guard(impl->mutex);auto&s=*impl;if(request.key!=s.key||!s.accepted||adoption!=s.adoption||request.requestId!=s.acceptedRequest||request.scale!=s.acceptedScale||!s.validTarget||s.boundsPending||!s.timingReason.empty()||(point!=EffectQualityPoint::Offline&&point!=s.point)||!sample.real||sample.redraw||!sample.sequence||sample.sequence<=s.latestSequence||!std::isfinite(sample.milliseconds)||sample.milliseconds<=0)return;
 s.latestSequence=sample.sequence;
 const auto before=s.controller.snapshot();s.controller.observe(sample);const auto after=s.controller.snapshot();if(after.samples!=before.samples){s.hasSample=true;s.scope=scope;if(!s.rejected)s.reason.clear();}if(after.pendingRequestId!=before.pendingRequestId)s.cached.reset();
}
EffectQualityStatus EffectQualitySession::status()const{std::lock_guard guard(impl->mutex);const auto&s=*impl;const auto c=s.controller.snapshot();return {s.settings.enabled,s.settings.nodeId,c.pendingScale&&s.reason.empty()?"Preparing the requested adaptive working extent":s.reason,s.accepted?s.acceptedScale:c.scale,c.meanMilliseconds,s.scope};}
void EffectQualitySession::publish(uintptr_t context,std::string_view revision)const noexcept{try{const auto value=status();RuntimeAdaptiveQualityEvent event;event.context=context;event.planRevision=revision;event.nodeId=value.nodeId;event.reason=value.reason;event.scale=value.scale;event.meanMilliseconds=value.meanMilliseconds;event.scope=value.scope;event.state=!value.requested?RuntimeAdaptiveQualityState::Off:value.reason.empty()?RuntimeAdaptiveQualityState::Active:RuntimeAdaptiveQualityState::Pending;observeRuntimeAdaptiveQuality(event);}catch(...){}}
}
