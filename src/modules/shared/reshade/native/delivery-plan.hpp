// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "adaptive-pacing.hpp"
#include <array>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
namespace macfx {
struct DueFrame {uint64_t sourceId=0;int generated=-1;double due=0;};
struct DeliveryStatus {unsigned pending=0;uint64_t droppedGenerated=0,droppedReal=0,rejectedBatches=0;};
// One bounded completed source interval, its interpolation phases and real
// frame. Replacing the batch retires older unpresented work immediately. This
// owns no image, producer, clock, callback or dynamic allocation.
class DeliveryPlan {
 std::array<DueFrame,32> entries{};unsigned first=0,count=0;uint64_t lastSource=0;DeliveryStatus status;
 void drop(const DueFrame&frame){if(frame.generated<0)++status.droppedReal;else ++status.droppedGenerated;}
public:
 template<class Phases>bool replace(uint64_t sourceId,const Phases&phases,double completedAt,double sourcePeriod,unsigned maximumImages=32,bool preserveClosingReal=false,std::optional<double>realDeadline={}){
  bool valid=sourceId>lastSource&&std::isfinite(completedAt)&&completedAt>0&&std::isfinite(sourcePeriod)&&sourcePeriod>0&&sourcePeriod<=1&&(!realDeadline||(std::isfinite(*realDeadline)))&&phases.count<std::size(entries)&&phases.count<=std::size(phases.timestamps);float previous=0;
  for(unsigned i=0;valid&&i<phases.count;++i){const float phase=phases.timestamps[i];valid=std::isfinite(phase)&&phase>previous&&phase<1;previous=phase;}
  if(!valid){++status.rejectedBatches;return false;}
  for(unsigned i=first;i<count;++i)if(!(preserveClosingReal&&entries[i].generated<0))drop(entries[i]);first=0;count=0;lastSource=sourceId;
  // No older real frame is re-enqueued. The first generated image can be
  // displayed immediately; the new real image closes that interpolation span.
  const unsigned generated=std::min(phases.count,maximumImages?maximumImages-1:0u);
  std::array<unsigned,31>selected{};unsigned next=0;
  for(unsigned i=0;i<generated;++i){const double target=double(i+1)/(generated+1);unsigned chosen=next;double distance=2;
   for(unsigned candidate=next;candidate<=phases.count-(generated-i);++candidate){const double gap=std::abs(phases.timestamps[candidate]-target);if(gap<distance){chosen=candidate;distance=gap;}}
   selected[i]=chosen;next=chosen+1;
  }
  status.droppedGenerated+=phases.count-generated;
  const double initial=generated?phases.timestamps[selected[0]]:1;
  const double closing=realDeadline?*realDeadline:completedAt+sourcePeriod*(1-initial);
  for(unsigned i=0;i<generated;++i){const auto phase=selected[i];entries[count++]={sourceId,int(phase),closing-sourcePeriod*(1-phases.timestamps[phase])};}
  entries[count++]={sourceId,-1,closing};status.pending=count;return true;
 }
 std::optional<DueFrame> take(double now){
  if(!std::isfinite(now)||now<=0)return {};
  std::optional<DueFrame> value;while(first<count&&entries[first].due<=now){if(value)drop(*value);value=entries[first++];}
  status.pending=count-first;return value;
 }
 std::optional<DueFrame> takeAhead(double now,double lead){
  if(auto due=take(now))return due;
  if(!std::isfinite(now)||!std::isfinite(lead)||lead<=0||first>=count||entries[first].due>now+lead)return {};
  const auto next=entries[first++];status.pending=count-first;return next;
 }
 void clear(){for(unsigned i=first;i<count;++i)drop(entries[i]);first=count=0;status.pending=0;}
 std::optional<double> nextTime()const{return first<count?std::optional<double>(entries[first].due):std::nullopt;}
 void reset(){entries={};first=count=0;lastSource=0;status={};}
 DeliveryStatus snapshot()const{return status;}
};
}
