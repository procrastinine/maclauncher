// Copyright (c) MacLauncher contributors. MIT license.
#include "generation-schedule.hpp"
#include "delivery-plan.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>
using namespace macfx;
static double distance(double time,double latch,double period){double phase=std::fmod(time-latch,period);if(phase<0)phase+=period;return std::min(phase,period-phase);}
int main(){
  // Display-limited suppression: the count includes the real image.
  assert(displayVisibleImages(60,1./60,32)==1);
  assert(displayVisibleImages(60,1./30,32)==2);
  assert(displayVisibleImages(60,1./24,32)==2);
  assert(displayVisibleImages(60,1./45,32)==1);
  assert(displayVisibleImages(120,1./30,32)==4);
  assert(displayVisibleImages(120,1./30,3)==3);
  assert(displayVisibleImages(240,1.,32)==32);
  assert(displayVisibleImages(0,1./30,32)==32);
  assert(displayVisibleImages(60,std::nan(""),5)==5&&displayVisibleImages(60,0,5)==5&&displayVisibleImages(60,1./30,0)==0);
  InterpolationPlan four;four.count=4;four.timestamps={.2f,.4f,.6f,.8f};
  auto limited=displayLimitedPhases(four,5);assert(limited.count==4);
  limited=displayLimitedPhases(four,3);assert(limited.count==2&&limited.timestamps[0]==.4f&&limited.timestamps[1]==.6f);
  limited=displayLimitedPhases(four,2);assert(limited.count==1&&(limited.timestamps[0]==.4f||limited.timestamps[0]==.6f));
  assert(displayLimitedPhases(four,1).count==0&&displayLimitedPhases(four,0).count==0);

  // Refresh phase: changes already a quarter refresh clear keep zero delay.
  const double period=1./60;
  std::vector<double> clear{.5*period,1.5*period};
  auto phase=refreshPhaseDelay(clear,clear.size(),0,period);assert(phase.delay==0&&std::abs(phase.margin-.5*period)<1e-12);
  // Changes on the latch points move to the middle of a refresh interval.
  for(const double offset:{0.,.1,.2,.8,.95}){
    std::vector<double> due{offset*period+1,(offset+1)*period+1};
    phase=refreshPhaseDelay(due,due.size(),0,period);
    assert(phase.delay>=0&&phase.delay<period);
    for(const double time:due)assert(distance(time+phase.delay,0,period)>=.25*period-1e-9);
    if(offset<.25||offset>.75)assert(std::abs(distance(due[0]+phase.delay,0,period)-.5*period)<1e-9);
  }
  // 24 fps at 60 Hz: two changes 1.25 refreshes apart cannot both be centered;
  // the delay maximizes the smaller distance, 0.375 of a refresh.
  std::vector<double> uneven{1+.05*period,1+1.3*period};
  phase=refreshPhaseDelay(uneven,uneven.size(),0,period);
  assert(std::abs(phase.margin-.375*period)<1e-9);
  for(const double time:uneven)assert(distance(time+phase.delay,0,period)>=.375*period-1e-9);
  // The latch time includes the measured delay from submission to a refresh.
  std::vector<double> lead{2+.02*period};phase=refreshPhaseDelay(lead,1,.3*period,period);
  assert(distance(lead[0]+phase.delay,.3*period,period)>=.25*period-1e-9);
  assert(refreshPhaseDelay(uneven,0,0,period).delay==0&&refreshPhaseDelay(uneven,uneven.size(),0,0).delay==0);
  std::vector<double> invalid{std::nan("")};assert(refreshPhaseDelay(invalid,1,0,period).delay==0);

  // The delivery plan shifts its whole pending batch by the same delay.
  DeliveryPlan plan;InterpolationPlan one;one.count=1;one.timestamps[0]=.5f;
  assert(plan.replace(1,one,1.0,1./30,2));
  const double before=*plan.nextTime(),delay=plan.alignToRefresh(1.0,period);
  assert(delay>0&&delay<period&&std::abs(*plan.nextTime()-(before+delay))<1e-12);
  assert(distance(*plan.nextTime(),1.0,period)>=.25*period-1e-9);
  auto first=plan.take(10);assert(first&&first->generated<0);

  // A previous delay stays while every change keeps half the wanted distance,
  // and is replaced once a change comes closer than that.
  std::vector<double> single{1+.8*period};
  phase=refreshPhaseDelay(single,1,0,period,.5*period);assert(std::abs(phase.delay-.5*period)<1e-12);
  phase=refreshPhaseDelay(single,1,0,period,.3*period);assert(phase.delay!=.3*period&&distance(single[0]+phase.delay,0,period)>=.25*period-1e-9);
  // The bound limits the delay; past it, the better of none and the bound.
  std::vector<double> late{1+.9*period};
  phase=refreshPhaseDelay(late,1,0,period,-1,.5*period);assert(std::abs(phase.delay-.5*period)<1e-12);
  phase=refreshPhaseDelay(late,1,0,period,-1,0);assert(phase.delay==0);
  phase=refreshPhaseDelay(late,1,0,period,-1,-1);assert(phase.delay==0);

  // D9: source images at the display rate whose completion times jitter
  // around the quarter-refresh threshold. A per-batch choice alternated
  // between no delay and most of a refresh, which reordered real images and
  // put two into one refresh. Every real now keeps its order, its own
  // refresh and its place ahead of the next source image.
  DeliveryPlan realOnly;InterpolationPlan none;double previousDue=0;long previousRefresh=-1;
  for(unsigned i=1;i<=240;++i){
    const double completed=1+i*period+(.74+(i%2?.03:-.03)+(i%7==0?.05:0))*period;
    assert(realOnly.replace(i,none,completed,period,1));realOnly.alignToRefresh(0,period);
    const double due=*realOnly.nextTime();const long refresh=long(std::ceil(due/period));
    assert(due>=completed&&due<=completed+period/2+1e-9);
    assert(due>previousDue&&refresh>previousRefresh);previousDue=due;previousRefresh=refresh;
  }
  // Two images per 60 fps source interval at 120 Hz: the closing real stays
  // half a refresh ahead of the next source image, whatever delay applies.
  DeliveryPlan doubled;const double fast=1./120;
  for(unsigned i=1;i<=60;++i){
    const double completed=2+i/60.+(i%3)*.3*fast;
    assert(doubled.replace(i,one,completed,1./60,2));doubled.alignToRefresh(2+.05*fast,fast);
    auto shown=doubled.take(1e9);assert(shown&&shown->generated<0&&shown->due<=completed+1./60-fast/2+1e-9);
  }
  assert(std::string(displayLimitedReason).find("display refresh")!=std::string::npos);
  puts("display-limited suppression and refresh phase rules hold");
}
