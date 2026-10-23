// Run the shared production Imports conversion with the original generated
// declarations; the receiving functions record the Bionic64 ABI operands.
#include "arm32.h"
#include "native-imports.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include ARM32_IMPORTS_SOURCE

using namespace maclauncher::arm32;
static uintptr_t observedHandle;
static unsigned observedFlags,calls;
static void *open(const char *,int flags){observedFlags=unsigned(flags);++calls;return nullptr;}
static void *openExt(const char *,int flags,const void *){return open(nullptr,flags);}
static void *symbol(void *handle,const char *){observedHandle=reinterpret_cast<uintptr_t>(handle);++calls;return nullptr;}
static void *versioned(void *handle,const char *,const char *){return symbol(handle,nullptr);}
static void *lookup(const char *name){
 if(!std::strcmp(name,"dlopen"))return reinterpret_cast<void *>(open);
 if(!std::strcmp(name,"android_dlopen_ext"))return reinterpret_cast<void *>(openExt);
 if(!std::strcmp(name,"dlsym"))return reinterpret_cast<void *>(symbol);
 if(!std::strcmp(name,"dlvsym"))return reinterpret_cast<void *>(versioned);
 return nullptr;
}
int main(){
 Memory memory;Thread thread(memory);Imports imports(memory,lookup);
 imports.setThreadFactory([&]{return std::make_shared<Thread>(memory);});
 char text[]="original";auto string=memory.borrow(text,sizeof text,Memory::Read);
 auto call=[&](const char *name,std::initializer_list<Value> args){auto gate=imports.resolve(name);assert(gate);auto before=calls;thread.call(gate,std::span(args.begin(),args.size()));assert(calls==before+1);};
 for(auto name:{"dlsym","dlvsym"})for(auto pair:{std::pair{guest_RTLD_DEFAULT,host_RTLD_DEFAULT},std::pair{guest_RTLD_NEXT,host_RTLD_NEXT}}){
  call(name,{Value::word(uint32_t(pair.first)),Value::word(string),Value::word(string)});assert(observedHandle==pair.second);
 }
 // Cover all combinations from the complete original flag declaration family,
 // including zero-valued NOW and LOCAL. Unknown bits stay for the owner to reject.
 const unsigned count=sizeof loaderFlags/sizeof *loaderFlags;
 for(auto name:{"dlopen","android_dlopen_ext"})for(unsigned bits=0;bits<(1u<<count);++bits){
  uint32_t guest=0,host=0;
  for(unsigned i=0;i<count;i++)if(bits&(1u<<i)){guest|=loaderFlags[i].guest;if(loaderFlags[i].guest)host|=loaderFlags[i].host;}
  if(!(guest&guest_RTLD_LAZY))host|=host_RTLD_NOW;
  call(name,{Value::word(string),Value::word(guest),Value::word(0)});assert(observedFlags==host);
 }
 std::puts("PASS original LP32/LP64 loader handles and complete flag family through shared Imports");
}
