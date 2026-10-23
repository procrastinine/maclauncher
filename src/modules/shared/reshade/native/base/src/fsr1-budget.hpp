#pragma once
#include <atomic>
#include <cstddef>
#include <stdexcept>
namespace macfx::fsr1 {
class ScratchBudgetBusy final : public std::runtime_error {
public: ScratchBudgetBusy():std::runtime_error("FSR scratch memory budget is full"){}
};
// Independent of the encoder owner; queued GPU resources keep their own charge.
class ScratchBudget {
public:
 static constexpr size_t maximum=256u*1024u*1024u;
 explicit ScratchBudget(size_t count):bytes(count){
  if(!count||count>maximum)throw std::runtime_error("FSR scratch image exceeds the memory budget");
  size_t value=live.load(std::memory_order_relaxed);
  do {if(value>maximum-count)throw ScratchBudgetBusy();}
  while(!live.compare_exchange_weak(value,value+count,std::memory_order_relaxed));
 }
 ~ScratchBudget(){live.fetch_sub(bytes,std::memory_order_relaxed);}
 ScratchBudget(const ScratchBudget&)=delete;ScratchBudget&operator=(const ScratchBudget&)=delete;
 static size_t retainedBytes(){return live.load(std::memory_order_relaxed);}
private:
 size_t bytes;inline static std::atomic<size_t>live{0};
};
}
