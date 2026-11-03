#include "source-timing.hpp"
#include "delivery-plan.hpp"
#include <cassert>
#include <cstdio>
#include <limits>

int main() {
 using namespace macfx;
 const auto close=[](double a,double b){return std::abs(a-b)<1e-9;};
 struct Phases {unsigned count=3;float timestamps[3]={.25f,.5f,.75f};} phases;
 // A sample-and-hold source has sparse distinct PTS. A nominal decoded frame
 // duration cannot shrink the interval between these actual endpoints.
 for(double media:{1./24.,.5,2.,8.}) for(double speed:{.125,.5,1.,2.}) {
  const double wall=media/speed;
  const auto timing=decodedContentInterval(media,1./60.,wall,1./60.);
  assert(close(timing.media,media)&&close(timing.playback,wall));
  DeliveryPlan playback;
  const double endpoint=20,sourceDeadline=40;
  assert(playback.replace(1,phases,sourceDeadline,wall,32,false,sourceDeadline+wall,true));
  assert(!playback.take(sourceDeadline));
  for(unsigned index=0;index<4;++index) {
   const double phase=double(index+1)/4;
   const double due=sourceDeadline+wall*phase;
   assert(!playback.take(due-wall/100));
   const auto output=playback.take(due+1e-10);assert(output);
   assert(output->generated==(index<3?int(index):-1));
   // The export writer writes each generated phase at its media timestamp.
   // Inverting the live deadline with playback speed gives that same PTS.
   const double exported=generationPhaseTime(endpoint,media,phase);
   const double displayed=endpoint-media+(output->due-sourceDeadline)*speed;
   assert(close(exported,displayed));
   assert(close(exported,endpoint-media+media*phase));
  }
  assert(!playback.nextTime());
 }
 // First/duplicate/unknown PTS cannot manufacture a speed from zero or NaN.
 for(double delta:{0.,-1.,std::numeric_limits<double>::quiet_NaN()}) {
  auto first=decodedContentInterval(delta,.5,0.,1./60.);
  assert(first.media==.5&&first.playback==.5);
 }
 const auto unknown=decodedContentInterval(0,0,0,1./60.);
 assert(unknown.media==1./60.&&unknown.playback==1./60.);
 // Ordinary game pauses still obey their existing bounded interval contract.
 assert(measuredSourcePeriod(20,10,.02)==1);
 DeliveryPlan game;assert(!game.replace(1,phases,10,2));
 assert(game.replace(1,phases,10,1));
 std::puts("video generation timing: pass");
}
