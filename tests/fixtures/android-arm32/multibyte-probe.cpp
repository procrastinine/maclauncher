#include "native-imports.h"
#include <array>
#include <cassert>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <dlfcn.h>
#include <iostream>
using namespace maclauncher::arm32;
static void *(*characters)(const char *);
static void *(*original)(const char *);
static void *lookup(const char *name){auto address=characters(name);return address?address:original(name);}
int main(int argc,char **argv){
  assert(argc==3);
  auto family=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!family){std::cerr<<dlerror()<<'\n';return 1;}
  auto native=dlopen(argv[2],RTLD_NOW|RTLD_LOCAL);if(!native){std::cerr<<dlerror()<<'\n';return 1;}
  characters=reinterpret_cast<void *(*)(const char *)>(dlsym(family,"klj_ctype_lookup"));
  original=reinterpret_cast<void *(*)(const char *)>(dlsym(native,"kl_shim_lookup"));assert(characters&&original);
  Memory memory;Imports imports(memory,lookup);Thread thread(memory);
  constexpr unsigned stateBytes=4,guard=16;
  std::array<unsigned char,stateBytes+2*guard> storage;storage.fill(0xa7);
  auto state=storage.data()+guard;std::memset(state,0,stateBytes);
  auto stateAddress=memory.borrow(state,stateBytes,Memory::Read|Memory::Write);
  auto guards=[&]{for(unsigned i=0;i<guard;i++)assert(storage[i]==0xa7&&storage[stateBytes+guard+i]==0xa7);};
  auto decode=imports.resolve("mbrtowc"),encode=imports.resolve("wcrtomb"),initial=imports.resolve("mbsinit");assert(decode&&encode&&initial);
  char input[]={char(0xf0),char(0x9f),char(0x99),char(0x82),0};uint32_t character=0;
  auto inputAddress=memory.borrow(input,sizeof(input),Memory::Read);
  auto characterAddress=memory.borrow(&character,sizeof(character),Memory::Read|Memory::Write);
  auto callDecode=[&](uint32_t address,unsigned count){Value args[]={Value::word(characterAddress),Value::word(address),Value::word(count),Value::word(stateAddress)};return uint32_t(thread.call(decode,args));};
  auto callInitial=[&]{Value args[]={Value::word(stateAddress)};return uint32_t(thread.call(initial,args));};
  assert(callInitial());assert(callDecode(inputAddress,2)==uint32_t(-2));guards();assert(!callInitial());
  assert(callDecode(inputAddress+2,2)==2&&character==0x1f642);guards();assert(callInitial());
  std::array<char,8> output{};auto outputAddress=memory.borrow(output.data(),output.size(),Memory::Read|Memory::Write);
  Value encoded[]={Value::word(outputAddress),Value::word(character),Value::word(stateAddress)};
  assert(uint32_t(thread.call(encode,encoded))==4&&!std::memcmp(input,output.data(),4));guards();assert(callInitial());
  input[0]=char(0xff);errno=0;assert(callDecode(inputAddress,1)==UINT32_MAX&&errno==EILSEQ);guards();assert(callInitial());
  bool beyond=false;try{memory.translate(stateAddress+stateBytes,1,Memory::Read);}catch(const Memory::Fault &){beyond=true;}assert(beyond);
  std::cout<<"PASS actual ARM32 four-byte state, partial UTF-8, native conversion and exact guards\n";
}
