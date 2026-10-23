#include "address-space.h"
#include <cassert>
#include <chrono>
#include <cstdio>
#include <random>
#include <string_view>
#include <vector>
using maclauncher::arm32::FreeAddressRanges;
struct Span {uint64_t begin,end;};
struct Allocation {uint32_t address,size;};
static uint64_t aligned(uint64_t value,uint32_t alignment){return (value+alignment-1)&~uint64_t(alignment-1);}
static uint32_t expected(const std::vector<Span> &free,uint32_t preferred,uint32_t size,uint32_t alignment){
  uint64_t bestCapacity=UINT64_MAX,bestBegin=UINT64_MAX,bestAddress=UINT64_MAX;
  for(const auto &span:free){
    const auto base=aligned(span.begin,alignment),capacity=base<span.end?span.end-base:0;
    const auto address=aligned(std::max(span.begin,uint64_t(preferred)),alignment);
    if(capacity>=size&&address<=span.end&&size<=span.end-address&&
       (capacity<bestCapacity||(capacity==bestCapacity&&span.begin<bestBegin))){
      bestCapacity=capacity;bestBegin=span.begin;bestAddress=address;
    }
  }
  assert(bestAddress<=UINT32_MAX);return uint32_t(bestAddress);
}
static std::vector<Span> complement(const std::vector<Allocation> &live){
  auto ordered=live;std::sort(ordered.begin(),ordered.end(),[](auto a,auto b){return a.address<b.address;});
  std::vector<Span> free;uint64_t next=0;
  for(const auto &allocation:ordered){
    assert(next<=allocation.address);if(next<allocation.address)free.push_back({next,allocation.address});
    next=uint64_t(allocation.address)+allocation.size;
  }
  if(next<UINT64_C(0x100000000))free.push_back({next,UINT64_C(0x100000000)});return free;
}
static void semantics(){
  FreeAddressRanges ranges;std::vector<Allocation> live;std::mt19937 random(0x4e444b);
  for(unsigned round=0;round<10000;round++){
    if(!live.empty()&&(random()%3==0||live.size()>200)){
      const auto index=random()%live.size();const auto entry=live[index];ranges.release(entry.address,entry.size);live.erase(live.begin()+index);
    }else{
      const uint32_t preferences[]={0,0x10000000,0x50000000,0x70000000};
      const auto preferred=preferences[random()%4],size=16*(1+random()%512),alignment=16u<<(random()%9);
      const auto reference=expected(complement(live),preferred,size,alignment);
      const auto address=ranges.place(preferred,size,alignment);assert(address==reference);
      assert(address%alignment==0);ranges.reserve(address,size);live.push_back({address,size});
    }
  }
  while(!live.empty()){const auto index=random()%live.size();const auto entry=live[index];ranges.release(entry.address,entry.size);live.erase(live.begin()+index);}
  for(unsigned alignment=16;alignment<=4096;alignment*=2)assert(ranges.place(0,4096,alignment)==0);
  ranges.reserve(0,4096);bool overlap=false;try{ranges.reserve(2048,4096);}catch(const std::runtime_error &){overlap=true;}assert(overlap);
  ranges.release(0,4096);ranges.reserve(0xfffff000,4096);assert(ranges.place(0xffff0000,4096,4096)==0xffff0000);
  std::puts("PASS original best-fit alignment, fragmented allocation and coalesced ownership");
}
static void benchmark(){
  FreeAddressRanges ranges;std::vector<Allocation> live;std::mt19937 random(0x4e444b);
  for(unsigned n=0;n<8192;n++){
    const auto size=16*(1+random()%64);const auto address=ranges.place(0x50000000,size,16);
    ranges.reserve(address,size);live.push_back({address,size});
  }
  constexpr unsigned rounds=200000;uint64_t checksum=0;const auto begin=std::chrono::steady_clock::now();
  for(unsigned n=0;n<rounds;n++){
    auto &entry=live[random()%live.size()];ranges.release(entry.address,entry.size);
    const auto alignment=16u<<(random()%9);entry.size=16*(1+random()%64);
    entry.address=ranges.place(0x50000000,entry.size,alignment);ranges.reserve(entry.address,entry.size);checksum+=entry.address;
  }
  const auto elapsed=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-begin).count();
  std::printf("allocation churn: %u operations %.3f ms checksum %llu\n",rounds,elapsed,static_cast<unsigned long long>(checksum));
}
int main(int argc,char **argv){if(argc>1&&std::string_view(argv[1])=="benchmark")benchmark();else semantics();}
