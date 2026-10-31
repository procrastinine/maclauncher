#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <chrono>
#include <cstddef>
#include <optional>
#include <vector>
namespace macfx {
// Automatic engine choice for one generation row. Candidates are ordered by
// preference. A candidate that falls behind is left at once for the next one;
// a preferred candidate is retried only after ten seconds of continuous
// headroom and at least thirty seconds after it was left. Pure logic: the
// owner supplies each capture's observation and the current time.
class AutomaticGenerationChoice {
public:
 using Clock=std::chrono::steady_clock;
 static constexpr std::chrono::seconds headroomRequired{10},backoff{30};
 explicit AutomaticGenerationChoice(size_t count=0):leftAt(count){}
 size_t active()const noexcept{return current;}
 size_t candidates()const noexcept{return leftAt.size();}
 // usable reports whether a candidate is prepared. behind reports that the
 // active candidate missed its capture interval or rejected the pair as busy;
 // headroom that it finished well inside the interval. A capture with neither
 // restarts the headroom period. Returns true when the active candidate changed.
 template<class Usable>bool observe(bool behind,bool headroom,Clock::time_point now,Usable usable){
  if(leftAt.empty())return false;
  if(behind){
   headroomSince.reset();
   for(size_t next=current+1;next<leftAt.size();++next)if(usable(next)){leftAt[current]=now;current=next;return true;}
   return false;
  }
  if(!headroom){headroomSince.reset();return false;}
  if(!headroomSince)headroomSince=now;
  if(!current||now-*headroomSince<headroomRequired)return false;
  for(size_t preferred=0;preferred<current;++preferred){
   if(leftAt[preferred]&&now-*leftAt[preferred]<backoff)continue;
   if(!usable(preferred))continue;
   current=preferred;headroomSince.reset();return true;
  }
  return false;
 }
 // A candidate that cannot run at all is skipped without a back-off.
 template<class Usable>bool settle(Usable usable){
  if(leftAt.empty()||usable(current))return false;
  for(size_t next=0;next<leftAt.size();++next)if(usable(next)){current=next;headroomSince.reset();return true;}
  return false;
 }
private:
 size_t current=0;std::optional<Clock::time_point>headroomSince;std::vector<std::optional<Clock::time_point>>leftAt;
};
}
