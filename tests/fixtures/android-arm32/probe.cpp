#include "flat-binary.h"
#include "arm32.h"
#include <bit>
#include <cassert>
#include <cstring>
#include <dlfcn.h>
#include <fstream>
#include <iostream>
#include <iterator>
using namespace maclauncher::arm32;
int main(int argc, char **argv) {
  assert(argc == 3);
  void *runtime = dlopen(argv[2], RTLD_NOW | RTLD_LOCAL);
  assert(runtime);
  auto lookup = (void *(*)(const char *))dlsym(runtime, "kl_shim_lookup");
  assert(lookup);
  auto copy = (void *(*)(void *, const void *, size_t))lookup("memcpy");
  auto tid = (int (*)(void))lookup("gettid");
  assert(copy && tid);
  Memory memory;
  Thread thread(memory);
  thread.setTls(0x12345000);
  assert(*static_cast<const uint32_t *>(memory.translate(0xffff0ffc,4,Memory::Read))==5);
  assert(uint32_t(thread.call(0xffff0fe0))==0x12345000);
  const auto atomic=memory.allocate(0x60000000,4096,Memory::Read|Memory::Write);
  auto *values=static_cast<uint64_t *>(memory.translate(atomic,24,Memory::Write));
  values[0]=7;values[1]=0x123456789abcdef0ull;values[2]=values[1];
  std::array exchange32={Value::word(7),Value::word(11),Value::word(atomic)};
  assert(uint32_t(thread.call(0xffff0fc0,exchange32))==0&&values[0]==11);
  assert(uint32_t(thread.call(0xffff0fc0,exchange32))!=0&&values[0]==11);
  std::array exchange64={Value::word(atomic+8),Value::word(atomic),Value::word(atomic+16)};
  assert(uint32_t(thread.call(0xffff0f60,exchange64))==0&&values[2]==11);
  assert(uint32_t(thread.call(0xffff0f60,exchange64))!=0&&values[2]==11);
  thread.call(0xffff0fa0);
  uint32_t copyGate = thread.import([&](Thread &t) {
    auto n = t.argument(2), destination = t.argument(0);
    copy(t.memory().translate(destination, n, Memory::Write),
         t.memory().translate(t.argument(1), n, Memory::Read), n);
    return destination;
  });
  uint32_t tidGate = thread.import([&](Thread &) { return tid(); });
  uint32_t nested = thread.import([](Thread &t) {
    std::array args = {Value::word(t.argument(1))};
    return uint32_t(t.call(t.argument(0), args));
  });
  thread.setSyscall([&](Thread &, uint32_t number) -> int64_t {
    return number == 224 ? tid() : -38;
  });
  FlatBinary image(memory,argv[1]);image.gate(0,copyGate);image.gate(1,tidGate);image.gate(2,nested);
  std::array sum = {Value::word(5), Value::wide(0x123456789abcdef0ull),
                    Value::word(9)};
  assert(thread.call(image.entry(ENTRY_aligned_arguments), sum) ==
         0x123456789abcdefeull);
  assert(uint32_t(thread.call(image.entry(ENTRY_shared_copy))) == 'A');
  assert(uint32_t(thread.call(image.entry(ENTRY_shared_thread))) ==
         uint32_t(tid()));
  assert(uint32_t(thread.call(image.entry(ENTRY_svc_thread))) == uint32_t(tid()));
  assert(uint32_t(thread.call(image.entry(ENTRY_read_tls))) == 0x12345000);
  std::array arm = {Value::word(11), Value::word(19)};
  assert(uint32_t(thread.call(image.entry(ENTRY_arm_add), arm)) == 30);
  std::array fp = {Value::word(std::bit_cast<uint32_t>(2.5f)),
                   Value::word(std::bit_cast<uint32_t>(4.0f))};
  assert(std::bit_cast<float>(
             uint32_t(thread.call(image.entry(ENTRY_neon_float), fp))) == 13.0f);
  std::array cb = {Value::word(9)};
  assert(uint32_t(thread.call(image.entry(ENTRY_callback_host), cb)) == 66);
  bool fault = false;
  try {
    thread.call(0xdead0000);
  } catch (const std::runtime_error &) {
    fault = true;
  }
  assert(fault);
  std::cout << "PASS A32/Thumb translation, "
               "AAPCS32 wide/stack/float arguments, guest memory, native libc "
               "gates, TLS, SVC and reentrant callbacks\n";
}
