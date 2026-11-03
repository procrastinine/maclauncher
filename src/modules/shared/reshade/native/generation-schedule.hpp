#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// Display rules of the shared generation timeline. Pure arithmetic: no clock,
// image, provider or presenter state, so every generator and presenter path
// applies the same decisions.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
namespace macfx {
// A display refreshing refreshHz times per second shows about
// refreshHz*sourcePeriod images from one source interval, with a quarter
// refresh of tolerance so that 24 fps at 60 Hz keeps two images. The count
// includes the real image: 1 means that no generated image can be seen, so
// generation for that interval is suppressed rather than produced and dropped.
// Presenters pass a refresh rate only for ExternalWindow sources. Games and
// file export pass zero, which leaves the requested image count unchanged.
inline unsigned displayVisibleImages(unsigned refreshHz,double sourcePeriod,unsigned limit)noexcept{
 if(!limit)return 0;
 if(!refreshHz||!std::isfinite(sourcePeriod)||sourcePeriod<=0)return limit;
 const double images=std::floor(double(refreshHz)*std::min(sourcePeriod,1.)+.25);
 return images>=limit?limit:std::max(1u,unsigned(images));
}
// A display-limited interval has only its real endpoint. It uses ordinary
// drawable pipelining and source-buffer presentation; interpolation and output
// subframes alone need the independent delivery queue.
struct GenerationDelivery {bool displayLimited=false,deferred=false;unsigned sourceCapacity=1;};
inline GenerationDelivery generationDelivery(bool generating,bool subframes,unsigned refreshHz,double sourcePeriod,unsigned drawableCount)noexcept{
 const bool limited=generating&&displayVisibleImages(refreshHz,sourcePeriod,2)==1;
 return {limited,(generating&&!limited)||subframes,generating&&!limited?1u:std::min(4u,drawableCount)};
}
// The evenly spaced subset of requested phases that visibleImages can show;
// fewer than two visible images leave no generated phase.
// The row-state reason of a generation stage whose interval the display limit
// suppressed; status, Details and the overlay report this one text.
inline constexpr char displayLimitedReason[]="The display refresh rate leaves no refresh for a generated image at this source frame rate";
template<class Plan>Plan displayLimitedPhases(const Plan&requested,unsigned visibleImages)noexcept{
 if(requested.count<visibleImages)return requested;
 Plan result{};if(visibleImages<2)return result;
 const unsigned wanted=visibleImages-1;unsigned next=0;
 for(unsigned i=0;i<wanted;++i){
  const double target=double(i+1)/(wanted+1);unsigned chosen=next;double distance=2;
  for(unsigned candidate=next;candidate<=requested.count-(wanted-i);++candidate){const double gap=std::abs(double(requested.timestamps[candidate])-target);if(gap<distance){chosen=candidate;distance=gap;}}
  result.timestamps[result.count++]=requested.timestamps[chosen];next=chosen+1;
 }
 return result;
}
// Refresh phase. The presenter replaces its displayed image at each due time,
// and a refresh shows the image that is current when it latches. Two changes
// inside one refresh interval lose the first image; a change close to a latch
// point moves between refreshes with small timing noise. latchTime is one
// latch point: a refresh time minus the measured delay from submission to that
// refresh. The result is a delay in [0, refreshPeriod) for a batch's due times.
// A batch whose every change is at least a quarter refresh (or, when its
// spacing allows less, its best possible distance) from the latch points keeps
// zero delay. Otherwise the delay centers the widest gap between the changes'
// refresh phases on the latch points, which maximizes the smallest distance.
// The previous batch's delay (negative: none) is kept while every change stays
// at least half that distance clear, so consecutive batches keep their spacing
// and timing noise near the threshold never alternates the choice; a delay
// that differs per batch would reorder images and collapse two into one
// refresh. maximumDelay bounds the result: when the centering delay exceeds
// it, the better of no delay and the bound applies.
constexpr size_t maximumScheduledChanges=32;
struct RefreshPhase {double delay=0,margin=0;};
template<class Times>RefreshPhase refreshPhaseDelay(const Times&due,size_t count,double latchTime,double refreshPeriod,double previousDelay=-1,double maximumDelay=INFINITY)noexcept{
 if(!count||count>maximumScheduledChanges||!std::isfinite(latchTime)||!std::isfinite(refreshPeriod)||refreshPeriod<=0)return {};
 std::array<double,maximumScheduledChanges>phases{};
 for(size_t i=0;i<count;++i){
  if(!std::isfinite(due[i]))return {};
  double phase=std::fmod((due[i]-latchTime)/refreshPeriod,1.);if(phase<0)phase+=1;if(phase>=1)phase=0;phases[i]=phase;
 }
 std::sort(phases.begin(),phases.begin()+count);
 double gap=phases[0]+1-phases[count-1],start=phases[count-1];
 for(size_t i=1;i<count;++i)if(phases[i]-phases[i-1]>gap){gap=phases[i]-phases[i-1];start=phases[i-1];}
 const double best=gap/2,wanted=std::min(.25,best),limit=maximumDelay>0?std::min(maximumDelay/refreshPeriod,1.):0;
 const auto margin=[&](double shift){double value=.5;for(size_t i=0;i<count;++i){double phase=phases[i]+shift;phase-=std::floor(phase);value=std::min(value,std::min(phase,1-phase));}return value;};
 const auto result=[&](double shift){return RefreshPhase{shift*refreshPeriod,margin(shift)*refreshPeriod};};
 if(std::isfinite(previousDelay)&&previousDelay>=0){const double kept=std::fmod(previousDelay/refreshPeriod,1.);if(kept<=limit+1e-12&&margin(kept)+1e-9>=wanted/2)return result(kept);}
 if(margin(0)+1e-9>=wanted)return result(0);
 double shift=1-std::fmod(start+best,1.);if(shift>=1)shift=0;
 if(shift<=limit+1e-12)return result(shift);
 return margin(limit)>margin(0)?result(limit):result(0);
}
}
