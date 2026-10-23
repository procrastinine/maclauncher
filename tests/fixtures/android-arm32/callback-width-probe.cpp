// Exercise the original generated JNI scalar callback declarations through the
// production native callback ingress. White-box access stays in this fixture.
#include "arm32.h"
#include <cassert>
#include <cstdint>
#include <cstdio>
#define private public
#include "native-imports.h"
#undef private
#include ARM32_IMPORTS_SOURCE

using namespace maclauncher::arm32;
static void *lookup(const char *) { return nullptr; }
template<class T> static void check(Imports &imports,const char *field,T value,uint32_t expected) {
  const Type *table=nullptr;
  for(const auto &type:types)if(type.kind==Kind::Record)
    for(unsigned i=0;i<type.fieldCount;i++)if(std::string_view(type.fields[i].name)=="SetByteField")table=&type;
  assert(table);
  const Field *member=nullptr;
  for(unsigned i=0;i<table->fieldCount;i++)if(std::string_view(table->fields[i].name)==field)member=&table->fields[i];
  assert(member&&types[member->type].kind==Kind::Pointer);
  auto function=types[member->type].element;
  assert(types[function].kind==Kind::Function);
  using Setter=void(*)(void *,void *,void *,T);
  uint32_t observed=0;unsigned calls=0;
  imports.setCallback([&](Thread &,uint32_t,std::span<const Value> args){
    assert(args.size()==4&&args[3].words==1);observed=uint32_t(args[3].bits);++calls;return 0;
  });
  auto entry=reinterpret_cast<Setter>(imports.impl->callback(0x12340000,function));
  entry(nullptr,nullptr,nullptr,value);
  assert(calls==1&&observed==expected);
}
int main(){
  Memory memory;Imports imports(memory,lookup);
  imports.setThreadFactory([&]{return std::make_shared<Thread>(memory);});
  imports.setJniAdapter([](JniValue,uint64_t value,bool){assert(!value);return value;});
  for(auto value:{int8_t(-128),int8_t(-1),int8_t(0),int8_t(127)})check(imports,"SetByteField",value,uint32_t(int32_t(value)));
  for(auto value:{int16_t(-32768),int16_t(-1),int16_t(0),int16_t(32767)})check(imports,"SetShortField",value,uint32_t(int32_t(value)));
  check(imports,"SetCharField",uint16_t(65535),65535);
  check(imports,"SetBooleanField",uint8_t(1),1);
  // OpenMAX's original by-value XADataSink is two words aligned to four
  // bytes. Its descriptor must survive callback ingress independently of size.
  unsigned snapshot=0;
  for(const auto &type:types)if(type.kind==Kind::Record)
    for(unsigned i=0;i<type.fieldCount;i++)if(std::string_view(type.fields[i].name)=="InitiateSnapshot")snapshot=types[type.fields[i].type].element;
  assert(snapshot&&types[snapshot].parameterCount==8);
  const auto &sink=types[types[snapshot].parameters[4]];
  assert(sink.guestSize==8&&sink.guestAlign==4);
  bool recordCalled=false;
  imports.setCallback([&](Thread &,uint32_t,std::span<const Value> values){
    assert(values.size()==8&&values[4].words==2&&values[4].alignment==4);
    recordCalled=true;return 7;
  });
  struct NativeSink {void *locator,*format;};
  using Snapshot=unsigned(*)(void *,unsigned,unsigned,unsigned,NativeSink,void *,void *,void *);
  auto snapshotEntry=reinterpret_cast<Snapshot>(imports.impl->callback(0x12340004,snapshot));
  assert(snapshotEntry(nullptr,1,2,0,{nullptr,nullptr},nullptr,nullptr,nullptr)==7&&recordCalled);
  std::puts("PASS original typed callbacks preserve AAPCS32 signed and unsigned narrow parameter words");
}
