#pragma once
#include "arm32.h"
#include <array>
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdio>

// One existing CPU owner and the same register/stack call shape in both VM
// bindings. Timing compares argument acquisition, not game or GPU throughput.
inline void argumentSpanProof(maclauncher::arm32::Memory &memory,
                              maclauncher::arm32::Thread &thread) {
 using namespace maclauncher::arm32;
 const std::array values={Value::word(2),Value::word(3),Value::word(5),
  Value::word(7),Value::word(11),Value::word(13),Value::word(17),Value::word(19),Value::word(23)};
 const auto single=memory.import([&](Thread &caller){
  uint64_t result=0;for(unsigned i=0;i<values.size();++i)result+=caller.argument(i);return result;
 });
 const auto batched=memory.import([&](Thread &caller){
  std::array<uint32_t,9> words;caller.arguments(0,words);
  uint64_t result=0;for(unsigned i=0;i<words.size();++i){assert(words[i]==values[i].bits);result+=words[i];}return result;
 });
 const auto crossing=memory.import([&](Thread &caller){
  std::array<uint32_t,5> words;caller.arguments(3,words);
  for(unsigned i=0;i<words.size();++i)assert(words[i]==values[i+3].bits);
  caller.arguments(UINT32_MAX,{});return uint64_t(1);
 });
 assert(thread.call(crossing,values)==1);
 constexpr unsigned count=20000;
 const auto measure=[&](uint32_t gate){
  for(unsigned i=0;i<32;++i)assert(thread.call(gate,values)==100);
  const auto begin=std::chrono::steady_clock::now();
  for(unsigned i=0;i<count;++i)assert(thread.call(gate,values)==100);
  return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now()-begin).count();
 };
 std::array<long long,3> singles{},batches{};
 for(unsigned i=0;i<3;++i){singles[i]=measure(single);batches[i]=measure(batched);}
 std::sort(singles.begin(),singles.end());std::sort(batches.begin(),batches.end());
 std::printf("PASS shared argument span: calls=%u words=9 scalarMedianNs=%lld batchMedianNs=%lld\n",count,singles[1],batches[1]);
 memory.retireImport(single);memory.retireImport(batched);memory.retireImport(crossing);
}
