// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "adaptive-pacing.hpp"
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
namespace macfx {
struct DueFrame {uint64_t sourceId=0;int generated=-1;double due=0;};
struct DeliveryStatus {unsigned pending=0;uint64_t droppedGenerated=0,droppedReal=0,rejectedBatches=0;};
// One completed source batch, at most four interpolation phases and its real
// frame. Replacing the batch retires older unpresented work immediately. This
// owns no image, producer, clock, callback or dynamic allocation.
class DeliveryPlan {
 std::array<DueFrame,5> entries{};unsigned first=0,count=0;uint64_t lastSource=0;DeliveryStatus status;
 void drop(const DueFrame&frame){if(frame.generated<0)++status.droppedReal;else ++status.droppedGenerated;}
public:
 bool replace(uint64_t sourceId,const InterpolationPlan&phases,double completedAt,double sourcePeriod){
  bool valid=sourceId>lastSource&&std::isfinite(completedAt)&&completedAt>0&&std::isfinite(sourcePeriod)&&sourcePeriod>0&&sourcePeriod<=1&&phases.count<=4;float previous=0;
  for(unsigned i=0;valid&&i<phases.count;++i){const float phase=phases.timestamps[i];valid=std::isfinite(phase)&&phase>previous&&phase<1;previous=phase;}
  if(!valid){++status.rejectedBatches;return false;}
  for(unsigned i=first;i<count;++i)drop(entries[i]);first=0;count=0;lastSource=sourceId;
  // No older real frame is re-enqueued. The first generated image can be
  // displayed immediately; the new real image closes that interpolation span.
  const double initial=phases.count?phases.timestamps[0]:1;
  for(unsigned i=0;i<phases.count;++i)entries[count++]={sourceId,int(i),completedAt+sourcePeriod*(phases.timestamps[i]-initial)};
  entries[count++]={sourceId,-1,completedAt+sourcePeriod*(1-initial)};status.pending=count;return true;
 }
 std::optional<DueFrame> take(double now){
  if(!std::isfinite(now)||now<=0)return {};
  std::optional<DueFrame> value;while(first<count&&entries[first].due<=now){if(value)drop(*value);value=entries[first++];}
  status.pending=count-first;return value;
 }
 void clear(){for(unsigned i=first;i<count;++i)drop(entries[i]);first=count=0;status.pending=0;}
 void reset(){entries={};first=count=0;lastSource=0;status={};}
 DeliveryStatus snapshot()const{return status;}
};
}
