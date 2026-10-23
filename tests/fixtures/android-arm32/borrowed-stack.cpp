#include "arm32.h"
#include <cassert>
#include <cstdio>
#include <cstring>
using namespace maclauncher::arm32;

int main() {
  Memory memory;
  uint32_t stack=memory.allocate(0,8192,Memory::Read|Memory::Write);
  memory.protect(stack,4096,0); // Bionic's guard belongs inside its stack extent.
  uint32_t code=memory.allocate(0,4096,Memory::Read|Memory::Write|Memory::Execute);
  const uint32_t instructions[]={0xe1a0000d,0xe12fff1e}; // mov r0,sp; bx lr
  std::memcpy(memory.translate(code,sizeof instructions,Memory::Write),instructions,sizeof instructions);
  {
    Thread thread(memory);
    thread.useStack(stack,8192);
    assert(thread.stackTop()==stack+8192);
    auto sp=thread.call(code);
    assert(sp>=stack+4096 && sp<stack+8192 && !(sp&7));
  }
  // Destroying the translator must not free the original Bionic allocation.
  *static_cast<unsigned char *>(memory.translate(stack+8191,1,Memory::Write))=0x53;
  bool guarded=false;
  try { (void)memory.translate(stack,1,Memory::Read); }
  catch(const Memory::Fault &) { guarded=true; }
  assert(guarded);
  memory.unmap(stack,8192);
  puts("PASS original guarded stack is borrowed and remains owned by its allocator");
}
