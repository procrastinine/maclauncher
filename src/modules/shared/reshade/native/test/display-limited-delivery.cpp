// Copyright (c) MacLauncher contributors. MIT license.
#include "../generation-schedule.hpp"
#include <cstdio>
#include <cstdlib>
#include <vector>
#define CHECK(value) do{if(!(value)){std::fprintf(stderr,"%s:%d: %s\n",__FILE__,__LINE__,#value);std::exit(1);}}while(0)
using namespace macfx;
// A frame's GPU lifetime can cross the next source tick while the display
// still has drawable capacity. A real-only interval must not inherit the
// provider's one-in-flight serialization and reject that next source frame.
unsigned admitted(const GenerationDelivery&mode){
 std::vector<double>ends;unsigned count=0;
 for(unsigned tick=0;tick<600;++tick){
  const double now=tick/60.;ends.erase(std::remove_if(ends.begin(),ends.end(),[&](double end){return end<=now;}),ends.end());
  if(ends.size()<mode.sourceCapacity){ends.push_back(now+.020);++count;}
 }
 return count;
}
int main(){
 const auto baseline=generationDelivery(false,false,60,1./60,3);
 const auto limited=generationDelivery(true,false,60,1./60,3);
 CHECK(!baseline.displayLimited&&!baseline.deferred&&baseline.sourceCapacity==3);
 CHECK(limited.displayLimited&&!limited.deferred&&limited.sourceCapacity==baseline.sourceCapacity);
 CHECK(admitted(baseline)==600&&admitted(limited)==600);
 const GenerationDelivery serialized{true,true,1};CHECK(admitted(serialized)==300);
 // A genuinely interpolated interval keeps provider serialization and paced
 // delivery. Returning to 60 fps immediately restores real-only delivery.
 for(unsigned repeat=0;repeat<3;++repeat){
  const auto interpolated=generationDelivery(true,false,60,1./30,3);
  CHECK(!interpolated.displayLimited&&interpolated.deferred&&interpolated.sourceCapacity==1);
  CHECK(!generationDelivery(true,false,120,1./60,3).displayLimited);
  CHECK(!generationDelivery(true,false,60,1./60,3).deferred);
 }
 const auto subframes=generationDelivery(true,true,60,1./60,2);
 CHECK(subframes.displayLimited&&subframes.deferred&&subframes.sourceCapacity==2);
 CHECK(generationDelivery(false,true,60,1./60,2).deferred);
 CHECK(!generationDelivery(true,false,0,1./60,3).displayLimited);
 CHECK(!generationDelivery(true,false,60,NAN,3).displayLimited);
 CHECK(!generationDelivery(true,false,60,0,3).displayLimited);
 CHECK(generationDelivery(true,false,60,1./60,8).sourceCapacity==4);
 std::puts("display-limited-delivery: pass");
}
