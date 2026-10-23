#include "flat-binary.h"
#include "native-imports.h"
#include <array>
#include <cassert>
#include <cerrno>
#include <cstring>
#include <dlfcn.h>
#include <fcntl.h>
#include <fstream>
#include <iostream>
#include <iterator>
#include <pthread.h>
#include <unistd.h>
#include "syscall-test-numbers.h"
#include "prctl-constants.h"
using namespace maclauncher::arm32;
int main(int argc,char **argv){
  assert(argc==3);
  void *core=dlopen(argv[1],RTLD_NOW|RTLD_GLOBAL);if(!core){std::cerr<<dlerror()<<'\n';return 1;}
  auto lookup=reinterpret_cast<void *(*)(const char *)>(dlsym(core,"kl_shim_lookup"));assert(lookup);
  Memory memory;Imports imports(memory,lookup);Thread thread(memory);
  thread.setSyscall([&](Thread &caller,uint32_t number)->int64_t{
    if(number==0xfffffffe){uint32_t total=0;for(unsigned i=0;i<7;i++)total+=caller.syscallArgument(i);return total;}
    return imports.syscall(caller,number);
  });
  FlatBinary image(memory,argv[2]);const auto entry=image.entry(ENTRY_raw_syscall);
  auto area=memory.allocate(0x20000000,4096,Memory::Read|Memory::Write);
  auto invoke=[&](uint32_t number,std::initializer_list<uint32_t> arguments={}){
    std::array<uint32_t,7> registers{};std::copy(arguments.begin(),arguments.end(),registers.begin());
    std::memcpy(memory.translate(area,28,Memory::Write),registers.data(),28);
    std::array<Value,3> values={Value::word(number),Value::word(area),Value::word(area+32)};
    errno=EDOM;auto result=int32_t(thread.call(entry,values));assert(errno==EDOM);
    assert(*static_cast<uint32_t *>(memory.translate(area+32,4,Memory::Read))==registers[1]);
    return result;
  };
  auto expected=reinterpret_cast<int (*)()>(lookup("getpid"));assert(expected);
  const auto libc=imports.resolve("syscall");assert(libc);
  auto libcCall=[&](uint32_t number,std::initializer_list<uint32_t> arguments={}){
    std::array<Value,8> values{};values.fill(Value::word(0));values[0]=Value::word(number);
    unsigned i=1;for(auto value:arguments)values[i++]=Value::word(value);
    return int32_t(thread.call(libc,values));
  };
  errno=EDOM;assert(libcCall(NR_getpid)==expected());assert(errno==EDOM);
  assert(libcCall(0xffffffff)==-1);assert(errno==ENOSYS);
  assert(libcCall(NR_close,{UINT32_MAX})==-1);assert(errno==EBADF);
  assert(invoke(NR_getpid,{0,0x12345678})==expected());
  // The variadic libc declaration has the fixed five-word kernel entry ABI.
  // Both forms must operate on the same real host thread name and preserve
  // the host's unsupported process-security result instead of pretending to
  // grant tracer authority or mutate a private copy of dumpability.
  const auto control=imports.resolve("prctl");assert(control);
  char oldName[64]={0};assert(!pthread_getname_np(pthread_self(),oldName,sizeof(oldName)));
  const char name[]="guest-control-name-is-long";std::memcpy(memory.translate(area+768,sizeof name,Memory::Write),name,sizeof name);
  std::array<Value,5> setName={Value::word(PR_SET_NAME),Value::word(area+768),Value::word(0),Value::word(0),Value::word(0)};
  errno=EDOM;assert(thread.call(control,setName)==0&&errno==EDOM);
  char nativeName[64]={0};assert(!pthread_getname_np(pthread_self(),nativeName,sizeof(nativeName)));assert(!strcmp(nativeName,"guest-control-n"));
  std::memset(memory.translate(area+832,20,Memory::Write),0x65,20);
  assert(invoke(NR_prctl,{PR_GET_NAME,area+832})==0);
  assert(!strcmp(static_cast<const char *>(memory.translate(area+832,16,Memory::Read)),nativeName));
  assert(*static_cast<unsigned char *>(memory.translate(area+848,1,Memory::Read))==0x65);
  assert(libcCall(NR_prctl,{PR_SET_PTRACER,UINT32_MAX})==-1);
  auto unsupportedError=thread.call(imports.resolve("__errno"),{});
  assert(*static_cast<int *>(memory.translate(uint32_t(unsupportedError),4,Memory::Read))==95);
  assert(invoke(NR_prctl,{PR_SET_DUMPABLE,1})==-95);
  assert(invoke(NR_prctl,{PR_GET_DUMPABLE})==-95);
  assert(invoke(NR_prctl,{PR_GET_NAME,0x10})==-14);
  assert(invoke(NR_prctl,{0xffffffff})==-22);
  assert(!pthread_setname_np(oldName));
  assert(invoke(0xfffffffe,{1,2,4,8,16,32,64})==127);
  assert(invoke(0xffffffff,{0,0xfedcba98})==-38);
  assert(invoke(NR_close,{0xffffffff,0x10203040})==-9);
  assert(invoke(NR_clock_gettime,{1,area+64})==0);
  auto time=static_cast<int32_t *>(memory.translate(area+64,8,Memory::Read));assert(time[0]>0&&time[1]>=0&&time[1]<1000000000);
  char filename[]="/tmp/android-arm32-svc-XXXXXX";int file=mkstemp(filename);assert(file>=0);unlink(filename);
  const char text[]="original shared file";std::memcpy(memory.translate(area+128,sizeof text,Memory::Write),text,sizeof text);
  // The wide offset is in r4/r5, with r3 unused. Reading the C stack here
  // would instead write at the wrong location or use an unrelated address.
  assert(invoke(NR_pwrite64,{unsigned(file),area+128,sizeof text,0xdeadbeef,3,1})==sizeof text);
  char actual[sizeof text];assert(pread(file,actual,sizeof actual,off_t(0x100000003))==sizeof actual);
  assert(!std::memcmp(text,actual,sizeof text));
  // libc's variadic entry first shifts the syscall number out of r0, placing
  // these remaining kernel words across r1-r3 and four original C stack slots.
  assert(libcCall(NR_pwrite64,{unsigned(file),area+128,sizeof text,0xdeadbeef,0x103,1})==sizeof text);
  assert(pread(file,actual,sizeof actual,off_t(0x100000103))==sizeof actual);
  assert(!std::memcmp(text,actual,sizeof text));
  assert(invoke(NR__llseek,{unsigned(file),1,3,area+192,0})==0);
  uint64_t position=0;std::memcpy(&position,memory.translate(area+192,8,Memory::Read),8);assert(position==0x100000003);
  assert(invoke(NR_read,{unsigned(file),area+256,sizeof text})==sizeof text);
  assert(!std::memcmp(memory.translate(area+256,sizeof text,Memory::Read),text,sizeof text));
  assert(invoke(NR_read,{unsigned(file),0x10,1})==-14);
  unsigned char byte=0;
  auto shortBuffer=memory.borrow(&byte,1,Memory::Read|Memory::Write,"syscall short buffer");
  assert(invoke(NR_read,{unsigned(file),shortBuffer,4})==-14);memory.unmap(shortBuffer);
  // Vector record arrays retain every element's guest pointer and size.
  const uint32_t vectors[]={area+128,4,area+132,4};
  std::memcpy(memory.translate(area+320,sizeof vectors,Memory::Write),vectors,sizeof vectors);
  assert(lseek(file,0,SEEK_SET)==0);
  assert(invoke(NR_writev,{unsigned(file),area+320,2})==8);
  assert(pread(file,actual,8,0)==8&&!std::memcmp(text,actual,8));
  assert(invoke(NR_close,{unsigned(file)})==0);
  const char path[]="/dev/null";std::memcpy(memory.translate(area+128,sizeof path,Memory::Write),path,sizeof path);
  auto null=invoke(NR_openat,{uint32_t(-100),area+128,0,0});assert(null>=0);assert(invoke(NR_close,{unsigned(null)})==0);
  auto mapped=uint32_t(invoke(NR_mmap2,{0,8192,3,0x22,UINT32_MAX,0}));assert(int32_t(mapped)>0);
  std::memset(memory.translate(mapped,8192,Memory::Write),0x17,8192);
  assert(invoke(NR_mprotect,{mapped,4096,1})==0);
  assert(invoke(NR_munmap,{mapped,8192})==0);
  bool retired=false;try{memory.translate(mapped,1,Memory::Read);}catch(const Memory::Fault &){retired=true;}assert(retired);
  *static_cast<int32_t *>(memory.translate(area+64,4,Memory::Write))=7;
  assert(invoke(NR_futex,{area+64,128,8,0,0,0})==-11);
  assert(invoke(NR_futex,{area+64,129,1,0,0,0})==0);
  std::memset(memory.translate(area+128,8,Memory::Write),0,8);
  assert(invoke(NR_futex,{area+64,128,7,area+128,0,0})==-110);
  assert(libcCall(NR_futex,{area+64,128,7,area+128,0,0})==-1);assert(errno==ETIMEDOUT);
  auto errorCell=thread.call(imports.resolve("__errno"),{});
  assert(*static_cast<int *>(memory.translate(uint32_t(errorCell),4,Memory::Read))==110);
  // Original kernel sigset64 size is validated and copied by the existing
  // signal representation adapter and owner, including the old mask result.
  std::memset(memory.translate(area+256,16,Memory::Write),0,16);
  assert(invoke(NR_rt_sigprocmask,{0,0,area+256,8})==0);
  assert(invoke(NR_rt_sigprocmask,{0,0,area+256,4})==-22);
  assert(invoke(NR_set_tls,{area+512})==0);assert(thread.tls()==area+512);
  std::cout<<"PASS original ARM EABI syscall numbers, raw registers, shared owners and errors\n";
}
