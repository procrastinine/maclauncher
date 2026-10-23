#include "arm32.h"
#include "native-imports.h"
#include <array>
#include <cassert>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <string>
using namespace maclauncher::arm32;
static unsigned calls=0,queryLookups=0,queries=0,otherLookups=0,otherQueries=0;static bool bound=false;
static constexpr unsigned length=12;
static void shader(unsigned,int count,const char *const *sources,const int *lengths){
  assert(count==int(length)&&sources);
  for(unsigned i=0;i<length;i++){assert(sources[i]);assert(std::string(sources[i])=="shader-"+std::to_string(i));if(lengths)assert(lengths[i]==int(std::strlen(sources[i])));}
  ++calls;
}
static void uniforms(unsigned,int count,const char *const *names,unsigned *indices){
  assert(count==int(length));for(unsigned i=0;i<length;i++){assert(std::string(names[i])=="shader-"+std::to_string(i));indices[i]=100+i;}++calls;
}
static void query(unsigned binding,int *value){assert(binding==0x8895);++queries;*value=bound?1:0;}
static void otherQuery(unsigned binding,int *value){assert(binding==0x8895);++otherQueries;*value=bound?1:0;}
static void multi(unsigned,const int *counts,unsigned,const void *const *indices,int count){
  assert(count==int(length));for(unsigned i=0;i<length;i++){assert(counts[i]==int(i+1));if(bound)assert(uintptr_t(indices[i])==(i+1)*16);else assert(*static_cast<const char *>(indices[i])=='s');}++calls;
}
static void data(unsigned,ptrdiff_t size,const void *bytes,unsigned){assert(size==64&&!bytes);++calls;}
static void *lookup(const char *name){
  if(!std::strcmp(name,"glShaderSource"))return reinterpret_cast<void *>(shader);
  if(!std::strcmp(name,"glGetUniformIndices"))return reinterpret_cast<void *>(uniforms);
  if(!std::strcmp(name,"glGetIntegerv")){++queryLookups;errno=EINTR;return reinterpret_cast<void *>(query);}
  if(!std::strcmp(name,"glMultiDrawElementsEXT"))return reinterpret_cast<void *>(multi);
  if(!std::strcmp(name,"glBufferData"))return reinterpret_cast<void *>(data);
  return nullptr;
}
static void *otherLookup(const char *name){
  if(!std::strcmp(name,"glGetIntegerv")){++otherLookups;return reinterpret_cast<void *>(otherQuery);}
  return lookup(name);
}
int main(){
  Memory memory;Thread thread(memory);Imports imports(memory,lookup);
  std::array<std::string,length> strings;std::array<uint32_t,length> pointers,offsets;std::array<int,length> sizes,counts;std::array<unsigned,length> outputs;
  for(unsigned i=0;i<length;i++){strings[i]="shader-"+std::to_string(i);pointers[i]=memory.borrow(strings[i].data(),strings[i].size()+1,Memory::Read);offsets[i]=(i+1)*16;sizes[i]=strings[i].size();counts[i]=i+1;outputs[i]=0;}
  auto outer=memory.borrow(pointers.data(),sizeof pointers,Memory::Read),lengths=memory.borrow(sizes.data(),sizeof sizes,Memory::Read),indices=memory.borrow(outputs.data(),sizeof outputs,Memory::Read|Memory::Write),countArray=memory.borrow(counts.data(),sizeof counts,Memory::Read),offsetArray=memory.borrow(offsets.data(),sizeof offsets,Memory::Read);
  auto invoke=[&](const char *name,std::initializer_list<Value> arguments){thread.call(imports.resolve(name),std::span(arguments.begin(),arguments.size()));};
  invoke("glShaderSource",{Value::word(1),Value::word(length),Value::word(outer),Value::word(lengths)});
  invoke("glShaderSource",{Value::word(1),Value::word(length),Value::word(outer),Value::word(0)});
  invoke("glGetUniformIndices",{Value::word(1),Value::word(length),Value::word(outer),Value::word(indices)});
  for(unsigned i=0;i<length;i++)assert(outputs[i]==100+i);
  errno=EBUSY;
  invoke("glMultiDrawElementsEXT",{Value::word(4),Value::word(countArray),Value::word(0x1403),Value::word(outer),Value::word(length)});
  assert(errno==EBUSY);
  bound=true;
  invoke("glMultiDrawElementsEXT",{Value::word(4),Value::word(countArray),Value::word(0x1403),Value::word(offsetArray),Value::word(length)});
  invoke("glBufferData",{Value::word(0x8892),Value::word(64),Value::word(0),Value::word(0x88e4)});
  assert(calls==6);
  bool fault=false;try{invoke("glShaderSource",{Value::word(1),Value::word(length+1),Value::word(outer),Value::word(0)});}catch(const Memory::Fault&){fault=true;}
  assert(fault&&calls==6);
  // Native-call plans retain the resolver of their own Imports owner, while
  // EBO state remains dynamic on every draw, including after another owner.
  bound=false;
  for(unsigned i=0;i<64;i++)invoke("glMultiDrawElementsEXT",{Value::word(4),Value::word(countArray),Value::word(0x1403),Value::word(outer),Value::word(length)});
  {
    Imports other(memory,otherLookup);
    const auto draw=other.resolve("glMultiDrawElementsEXT");
    bound=true;
    std::array args{Value::word(4),Value::word(countArray),Value::word(0x1403),Value::word(offsetArray),Value::word(length)};
    thread.call(draw,args);
  }
  bound=true;
  invoke("glMultiDrawElementsEXT",{Value::word(4),Value::word(countArray),Value::word(0x1403),Value::word(offsetArray),Value::word(length)});
  std::fprintf(stderr,"GL provider lookups=%u other=%u live_queries=%u other=%u calls=%u\n",queryLookups,otherLookups,queries,otherQueries,calls);
  assert(calls==72&&queryLookups==1&&otherLookups==1&&queries==67&&otherQueries==1);
  std::puts("PASS original Khronos counted pointer arrays, later counts, nested offsets, outputs, null buffers and exact bounds");
  std::puts("PASS original GL provider resolved once per native plan with live binding state and separate owners");
}
