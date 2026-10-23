#include "flat-binary.h"
#include "argument-span.h"
#include <array>
#include <cassert>
#include <cstdio>
using namespace maclauncher::arm32;
int main(int argc,char **argv){
  assert(argc==2);static_assert(sizeof(Value)==16);
  Memory memory;Thread thread(memory);FlatBinary image(memory,argv[1]);
  std::array record={Value::word(5),Value{uint64_t(17)|(uint64_t(23)<<32),2,4},Value::word(31)};
  assert(uint32_t(thread.call(image.entry(ENTRY_word_record),record))==5+3*17+7*23+11*31);
  std::array split={Value::word(2),Value::word(3),Value::word(5),Value{uint64_t(7)|(uint64_t(11)<<32),2,4},Value::word(13)};
  assert(uint32_t(thread.call(image.entry(ENTRY_split_record),split))==2+2*3+3*5+5*7+7*11+11*13);
  std::array wide={Value::word(5),Value::wide(0x123456789abcdef0ull),Value::word(9)};
  assert(thread.call(image.entry(ENTRY_aligned_arguments),wide)==0x123456789abcdefeull);
  argumentSpanProof(memory,thread);
  std::puts("PASS original compiler record and wide argument alignment across registers and stack");
}
