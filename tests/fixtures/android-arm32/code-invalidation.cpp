#include "arm32.h"
#include <array>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string_view>
using namespace maclauncher::arm32;
namespace {
constexpr unsigned rw=Memory::Read|Memory::Write;
void instructions(void *bytes,unsigned answer){
  const uint32_t code[]={0xe3a00000u|answer,0xe12fff1eu}; // mov r0,#answer; bx lr
  std::memcpy(bytes,code,sizeof code);
}
void write(Memory &memory,uint32_t address,unsigned answer){instructions(memory.translate(address,8,Memory::Write),answer);}
void denied(Thread &thread,uint32_t address){
  bool failed=false;uint64_t result=0;try{result=thread.call(address,{},1000);}catch(const std::runtime_error&){failed=true;}
  if(!failed)std::fprintf(stderr,"Denied fetch at 0x%08x returned %llu\n",address,static_cast<unsigned long long>(result));
  assert(failed);
}
}
int main(int argc,char **argv){
  const bool baseline=argc>1&&std::string_view(argv[1])=="baseline";
  Memory memory;Thread thread(memory);unsigned notifications=0;
  memory.observe(&notifications,[&](uint32_t,uint32_t){++notifications;});
  const auto code=memory.allocate(0x30000000,4096,rw|Memory::Execute);
  write(memory,code,7);assert(thread.call(code)==7);
  notifications=0;
  const auto started=std::chrono::steady_clock::now();
  for(unsigned i=0;i<10000;++i){
    std::array<uint32_t,4> bytes{};
    const auto data=memory.borrow(bytes.data(),sizeof bytes,rw);
    const auto alias=memory.borrow(bytes.data(),sizeof bytes,rw);
    *static_cast<uint32_t*>(memory.translate(data,4,Memory::Write))=i;
    assert(*static_cast<uint32_t*>(memory.translate(alias,4,Memory::Read))==i);
    memory.retireNative(bytes.data(),sizeof bytes);
    assert(memory.addressOf(bytes.data())==0);
    assert(thread.call(code)==7);
  }
  // JNI/native retirement used to enqueue one invalidation per alias per JIT.
  const auto dataNotifications=notifications;
  const auto elapsed=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();
  auto measurement=[&]{std::printf("{\"retirements\":10000,\"aliasesPerRetirement\":2,\"dataInvalidations\":%u,\"elapsedMs\":%.3f}\n",dataNotifications,elapsed);};
  if(baseline){measurement();std::puts("PASS baseline ARM32 data retirement measurement");return 0;}
  assert(dataNotifications==0);
  const auto data=memory.allocate(0x20000000,4096*3,rw);
  memory.unmap(data+4096,4096);memory.unmap(data);memory.unmap(data+8192);
  assert(notifications==0);

  // Removing a data page between executable pages keeps both compiled blocks.
  const auto mixed=memory.allocate(0x21000000,4096*3,rw);
  write(memory,mixed,11);write(memory,mixed+8192,13);
  memory.protect(mixed,4096,rw|Memory::Execute);
  memory.protect(mixed+8192,4096,rw|Memory::Execute);
  assert(thread.call(mixed)==11&&thread.call(mixed+8192)==13);
  notifications=0;memory.unmap(mixed+4096,4096);
  assert(notifications==0);
  assert(thread.call(mixed)==11&&thread.call(mixed+8192)==13);

  // Permission changes retain denied fetches and invalidate compiled code.
  memory.protect(code,4096,rw);denied(thread,code);
  write(memory,code,17);memory.protect(code,4096,rw|Memory::Execute);
  assert(thread.call(code)==17);
  write(memory,code,19);memory.invalidate(code,8);assert(thread.call(code)==19);
  memory.unmap(code);denied(thread,code);
  memory.map(code,4096,rw|Memory::Execute);write(memory,code,23);
  assert(thread.call(code)==23); // Replaces a cached NoExecuteFault block.

  alignas(4096) std::array<uint32_t,1024> native{};
  instructions(native.data(),29);
  const auto borrowed=memory.borrow(native.data(),sizeof native,rw|Memory::Execute);
  assert(thread.call(borrowed)==29);
  notifications=0;memory.retireNative(native.data(),sizeof native);
  assert(notifications>0&&memory.addressOf(native.data())==0);
  denied(thread,borrowed);
  instructions(native.data(),31);
  const auto replacement=memory.borrow(native.data(),sizeof native,rw|Memory::Execute);
  assert(replacement==borrowed&&thread.call(replacement)==31);
  instructions(native.data(),37);
  memory.mapNative(native.data(),sizeof native,rw|Memory::Execute,{},replacement,true);
  assert(thread.call(replacement)==37);
  memory.unmap(replacement,4096);denied(thread,replacement);

  // Native callbacks can replace code and enter the same CPU recursively.
  // Both nested entry and the original continuation must see the new bytes.
  const auto callback=thread.import([&](Thread &nested)->uint64_t{
    write(memory,code,43);memory.invalidate(code,8);
    assert(nested.call(code)==43);
    write(memory,code,47);memory.invalidate(code,8);
    return 0;
  });
  const auto runner=memory.allocate(0x32000000,4096,rw|Memory::Execute);
  const uint32_t callAndRead[]={0xe92d4010,0xe1a04001,0xe12fff30,0xe12fff34,0xe8bd8010};
  std::memcpy(memory.translate(runner,sizeof callAndRead,Memory::Write),callAndRead,sizeof callAndRead);
  const std::array arguments={Value::word(callback),Value::word(code)};
  assert(thread.call(runner,arguments)==47);
  assert(thread.call(code)==47);
  memory.stopObserving(&notifications);
  measurement();
  std::puts("PASS original ARM32 data retirement, executable lifetimes, permission transitions and cache flush");
}
