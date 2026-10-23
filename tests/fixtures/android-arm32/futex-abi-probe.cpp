#include "arm32.h"
#include "native-imports.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include ARM32_IMPORTS_SOURCE

using namespace maclauncher::arm32;
static long observed[7];
static std::array<int64_t,2> deadline;
static unsigned calls;
static bool timed;
static long kernel(long number,long address,long operation,long value,long timeout,long second,long bits){
 const long values[]={number,address,operation,value,timeout,second,bits};
 std::memcpy(observed,values,sizeof values);++calls;
 if(timed&&timeout)std::memcpy(deadline.data(),reinterpret_cast<void *>(timeout),sizeof deadline);
 return 0;
}
static void *lookup(const char *name){return std::strcmp(name,"syscall")?nullptr:reinterpret_cast<void *>(kernel);}
int main(){
 Memory memory;Thread thread(memory);Imports imports(memory,lookup);
 const uint32_t gate=imports.resolve("syscall");assert(gate);
 uint32_t word=7,other=11;int32_t narrow[]={1234,5678};int64_t wide[]={0x100000001LL,8765};
 const auto address=memory.borrow(&word,sizeof word,Memory::Read|Memory::Write);
 const auto second=memory.borrow(&other,sizeof other,Memory::Read|Memory::Write);
 const auto timeout32=memory.borrow(narrow,sizeof narrow,Memory::Read);
 const auto timeout64=memory.borrow(wide,sizeof wide,Memory::Read);
 for(uint32_t command:{futex_WAIT,futex_WAKE,futex_REQUEUE,futex_CMP_REQUEUE,futex_WAKE_OP,
   futex_LOCK_PI,futex_UNLOCK_PI,futex_TRYLOCK_PI,futex_WAIT_BITSET,futex_WAKE_BITSET,
   futex_WAIT_REQUEUE_PI,futex_CMP_REQUEUE_PI,futex_LOCK_PI2}){
  timed=command==futex_WAIT||command==futex_WAIT_BITSET||command==futex_LOCK_PI||
    command==futex_LOCK_PI2||command==futex_WAIT_REQUEUE_PI;
  const bool requeue=command==futex_REQUEUE||command==futex_CMP_REQUEUE||command==futex_WAKE_OP||
    command==futex_WAIT_REQUEUE_PI||command==futex_CMP_REQUEUE_PI;
  for(bool time64:{false,true})for(bool nullTime:{false,true}){
   const uint32_t duration=timed?(nullTime?0:time64?timeout64:timeout32):23;
   const Value values[]={Value::word(time64?syscallFutexTime64:syscallFutex),Value::word(address),
    Value::word(command|futex_PRIVATE_FLAG|futex_CLOCK_REALTIME),Value::word(13),
    Value::word(duration),Value::word(requeue?second:0),Value::word(17)};
   const unsigned before=calls;assert(thread.call(gate,values)==0);assert(calls==before+1);
   assert(observed[0]==syscallFutex64&&observed[1]==reinterpret_cast<long>(&word));
   assert(uint32_t(observed[2])==(command|futex_PRIVATE_FLAG|futex_CLOCK_REALTIME));
   assert(observed[3]==13&&observed[5]==(requeue?reinterpret_cast<long>(&other):0)&&observed[6]==17);
   if(!timed||nullTime)assert(observed[4]==duration);
   else assert((deadline==std::array<int64_t,2>{time64?wide[0]:narrow[0],time64?wide[1]:narrow[1]}));
  }
 }
 std::puts("PASS original futex timeout, requeue and PI operands through shared Imports");
}
