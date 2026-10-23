#include "native-imports.h"
#include "imports-shapes.h"
#include <algorithm>
#include <array>
#include <bit>
#include <cassert>
#include <cstring>
#include <cwchar>
#include <dlfcn.h>
#include <iostream>
#include <fstream>
#include <iterator>
#include <fcntl.h>
#include <unistd.h>
using namespace maclauncher::arm32;
static void *(*sharedLookup)(const char *);
static FILE *openedStream;
static FILE *openStream(const char *name,const char *mode){
  using Open=FILE *(*)(const char *,const char *);
  openedStream=reinterpret_cast<Open>(sharedLookup("fopen"))(name,mode);
  return openedStream;
}
static int arrayBuffer, elementBuffer;
static const void *observed;
static std::array<float,4> color;
static unsigned socketLength;
static int bindValue(int,const void *,unsigned length){socketLength=length;return -7;}
static int socketName(int,void *,unsigned *length){socketLength=*length;*length=0x80000011u;return 0;}
using Handler=void(*)(int);
static unsigned nativeCallbackValue;
static void nativeCallback(int value){nativeCallbackValue=unsigned(value);}
static Handler installedCallback=nativeCallback;
static Handler exchangeCallback(int,Handler replacement){auto previous=installedCallback;installedCallback=replacement;return previous;}
static void getInteger(unsigned name,int *value){*value=name==0x8894?arrayBuffer:elementBuffer;}
static void draw(unsigned,int,unsigned,const void *pointer){observed=pointer;}
static void attribute(unsigned,int,unsigned,unsigned char,int,const void *pointer){observed=pointer;}
static void clearColor(float r,float g,float b,float a){color={r,g,b,a};}
static const unsigned char graphicsVersion[]="OpenGL ES 3.0 shared native context";
static const unsigned char *getString(unsigned name){return name==0x1f02?graphicsVersion:nullptr;}
static const unsigned char *getStringAt(unsigned name,unsigned index){return name==0x1f03 && index==0?graphicsVersion:nullptr;}
struct Timespec { long seconds,nanos; };
static int timeValue(int,Timespec *out){out->seconds=42;out->nanos=123456789;return 0;}
// Original Bionic addrinfo layouts differ by pointer width. A cyclic native
// result exercises publication before recursion without another service owner.
struct NativeAddressInfo {int flags,family,type,protocol;unsigned length;char *canonical;void *address;NativeAddressInfo *next;};
static NativeAddressInfo cyclicAddress{};
static int cyclicLookup(const char *,const char *,const NativeAddressInfo *,NativeAddressInfo **out){cyclicAddress.next=&cyclicAddress;*out=&cyclicAddress;return 0;}
static bool countedInterfaces=false;
static bool scopedIdentifiers=false;
static unsigned countedCalls;
static std::array<const void *,2> expectedIdentifiers;
static std::array<unsigned char,(shapes::SLObjectHostBytes>shapes::XAObjectHostBytes?shapes::SLObjectHostBytes:shapes::XAObjectHostBytes)> countedObjectTable{};
static std::array<unsigned char,(shapes::SLEngineHostBytes>shapes::XAEngineHostBytes?shapes::SLEngineHostBytes:shapes::XAEngineHostBytes)> countedEngineTable{};
static const void *countedObject=countedObjectTable.data(),*countedEngine=countedEngineTable.data();
static unsigned strictInterfaces(unsigned count,const void *const *ids,const unsigned *required){
  ++countedCalls;
  if(!count){assert(!ids||uintptr_t(ids)==1);assert(!required||uintptr_t(required)==1);return 0;}
  assert(count==2);
  if(!ids||!required)return 2;
  for(unsigned i=0;i<count;i++){assert(ids[i]);assert(!std::memcmp(ids[i],expectedIdentifiers[i],16));assert(required[i]==(i==0?1u:0u));}
  return 0;
}
static unsigned strictCreate(void **out,unsigned,const void *,unsigned count,const void *const *ids,const unsigned *required){
  const auto result=strictInterfaces(count,ids,required);if(!result&&out)*out=&countedObject;return result;
}
static unsigned strictQuery(const void *,const void *,void *out){*static_cast<void **>(out)=&countedEngine;return 0;}
static unsigned strictMix(const void *,void **out,unsigned count,const void *const *ids,const unsigned *required){
  const auto result=strictInterfaces(count,ids,required);if(!result&&out)*out=&countedObject;return result;
}
static void *lookup(const char *name){
  if(scopedIdentifiers&&(!std::strncmp(name,"SL_IID_",7)||!std::strncmp(name,"XA_IID_",7)))return nullptr;
  if(countedInterfaces&&(!std::strcmp(name,"slCreateEngine")||!std::strcmp(name,"xaCreateEngine")))return reinterpret_cast<void *>(strictCreate);
  // This strict native-width owner also supplies its XA identifiers. Their
  // payload uses original UUID bytes; no native OpenMAX implementation runs.
  if(countedInterfaces&&!std::strcmp(name,"XA_IID_ENGINE"))return &expectedIdentifiers[0];
  if(countedInterfaces&&!std::strcmp(name,"XA_IID_AUDIOIODEVICECAPABILITIES"))return &expectedIdentifiers[1];
  if(!std::strcmp(name,"fopen"))return reinterpret_cast<void *>(openStream);
  if(!std::strcmp(name,"bind"))return reinterpret_cast<void *>(bindValue);
  if(!std::strcmp(name,"getsockname"))return reinterpret_cast<void *>(socketName);
  if(!std::strcmp(name,"signal"))return reinterpret_cast<void *>(exchangeCallback);
  if(!std::strcmp(name,"glGetIntegerv"))return reinterpret_cast<void *>(getInteger);
  if(!std::strcmp(name,"glDrawElements"))return reinterpret_cast<void *>(draw);
  if(!std::strcmp(name,"glVertexAttribPointer"))return reinterpret_cast<void *>(attribute);
  if(!std::strcmp(name,"glClearColor"))return reinterpret_cast<void *>(clearColor);
  if(!std::strcmp(name,"glGetString"))return reinterpret_cast<void *>(getString);
  if(!std::strcmp(name,"glGetStringi"))return reinterpret_cast<void *>(getStringAt);
  if(!std::strcmp(name,"clock_gettime"))return reinterpret_cast<void *>(timeValue);
  if(!std::strcmp(name,"getaddrinfo"))return reinterpret_cast<void *>(cyclicLookup);
  return sharedLookup(name);
}
static void countedInterfaceViews(){
  countedInterfaces=true;
  for(unsigned family=0;family<2;family++){
    countedObjectTable.fill(0);countedEngineTable.fill(0);
    const auto query=reinterpret_cast<void *>(strictQuery),mix=reinterpret_cast<void *>(strictMix);
    const auto queryHost=family?shapes::XAObjectGetInterfaceHost:shapes::SLObjectGetInterfaceHost;
    const auto mixHost=family?shapes::XAEngineCreateOutputMixHost:shapes::SLEngineCreateOutputMixHost;
    std::memcpy(countedObjectTable.data()+queryHost,&query,sizeof query);std::memcpy(countedEngineTable.data()+mixHost,&mix,sizeof mix);
    const char *names[2][2]={{"SL_IID_ENGINE","SL_IID_AUDIOIODEVICECAPABILITIES"},{"XA_IID_ENGINE","XA_IID_AUDIOIODEVICECAPABILITIES"}};
    for(unsigned index=0;index<2;index++){auto slot=sharedLookup(names[0][index]);assert(slot);std::memcpy(&expectedIdentifiers[index],slot,sizeof(void *));}
    Memory memory;Imports imports(memory,lookup);Thread thread(memory);
    auto call=[&](uint32_t gate,std::initializer_list<Value> args){return thread.call(gate,std::span(args.begin(),args.size()));};
    struct {uint32_t pointer,guard;} output{0,0x1234abcd};auto out=memory.borrow(&output,sizeof output,Memory::Read|Memory::Write);
    std::array<uint32_t,2> ids{},required{1,0};
    for(unsigned index=0;index<2;index++){auto slot=imports.resolve(names[family][index]);assert(slot);std::memcpy(&ids[index],memory.translate(slot,4,Memory::Read),4);}
    auto identifiers=memory.borrow(ids.data(),sizeof ids,Memory::Read),requirements=memory.borrow(required.data(),sizeof required,Memory::Read);
    auto create=imports.resolve(family?"xaCreateEngine":"slCreateEngine");assert(create);
    auto invokeCreate=[&](unsigned count,uint32_t id,uint32_t req){return call(create,{Value::word(out),Value::word(0),Value::word(0),Value::word(count),Value::word(id),Value::word(req)});};
    assert(invokeCreate(2,identifiers,requirements)==0&&output.pointer&&output.guard==0x1234abcd);
    const auto object=output.pointer;uint32_t table=0;std::memcpy(&table,memory.translate(object,4,Memory::Read),4);
    const auto queryOffset=family?shapes::XAObjectGetInterface:shapes::SLObjectGetInterface;
    uint32_t queryGate=0;std::memcpy(&queryGate,memory.translate(table+queryOffset,4,Memory::Read),4);
    assert(call(queryGate,{Value::word(object),Value::word(ids[0]),Value::word(out)})==0&&output.pointer);
    const auto engine=output.pointer;std::memcpy(&table,memory.translate(engine,4,Memory::Read),4);
    const auto mixOffset=family?shapes::XAEngineCreateOutputMix:shapes::SLEngineCreateOutputMix;
    uint32_t mixGate=0;std::memcpy(&mixGate,memory.translate(table+mixOffset,4,Memory::Read),4);
    assert(call(mixGate,{Value::word(engine),Value::word(out),Value::word(2),Value::word(identifiers),Value::word(requirements)})==0);
    // Zero count preserves pointer bits without touching even an unmapped byte.
    assert(invokeCreate(0,1,1)==0);assert(invokeCreate(0,0,0)==0);
    // Original error handling receives null arrays; no synthetic contents.
    output.pointer=0xfeedbeef;assert(invokeCreate(2,0,requirements)==2&&output.pointer==0xfeedbeef);
    assert(invokeCreate(2,identifiers,0)==2&&output.pointer==0xfeedbeef);
    for(bool shortIdentifiers:{false,true}){
      auto shortArray=memory.borrow(shortIdentifiers?ids.data():required.data(),4,Memory::Read);
      const auto before=countedCalls;bool bounded=false;
      try{invokeCreate(2,shortIdentifiers?shortArray:identifiers,shortIdentifiers?requirements:shortArray);}catch(const Memory::Fault &){bounded=true;}
      assert(bounded&&countedCalls==before&&output.guard==0x1234abcd);
    }
  }
  countedInterfaces=false;
}
static void interfaceViews(){
  Memory memory;
  uint32_t engine=0,table=0,cycle=0;
  {
    Imports imports(memory,lookup);Thread thread(memory);
    imports.setThreadFactory([&]{return std::make_shared<Thread>(memory);});
    auto call=[&](uint32_t gate,std::initializer_list<Value> args={}){assert(gate);return thread.call(gate,std::span(args.begin(),args.size()));};
    struct {uint32_t value,guard;} output{0,0x1234abcd};
    auto slot=memory.borrow(&output,sizeof output,Memory::Read|Memory::Write);
    auto create=imports.resolve("slCreateEngine");assert(create);
    assert(call(create,{Value::word(slot),Value::word(0),Value::word(0),Value::word(0),Value::word(0),Value::word(0)})==0);
    engine=output.value;assert(engine&&output.guard==0x1234abcd);
    // Dereference the original pointer-to-pointer interface exactly as ARM32
    // native code does. The table contains typed executable import gates.
    std::memcpy(&table,memory.translate(engine,4,Memory::Read),4);assert(table);
    auto methods=static_cast<const uint32_t *>(memory.translate(table,shapes::objectBytes,Memory::Read));
    auto realize=methods[shapes::objectRealize/4],state=methods[shapes::objectState/4],destroy=methods[shapes::objectDestroy/4],query=methods[shapes::objectQuery/4];
    memory.translate(realize,4,Memory::Execute);
    assert(call(realize,{Value::word(engine),Value::word(0)})==0);
    output.value=0;
    assert(call(state,{Value::word(engine),Value::word(slot)})==0&&output.value==2&&output.guard==0x1234abcd);
    assert(call(create,{Value::word(slot),Value::word(0),Value::word(0),Value::word(0),Value::word(0),Value::word(0)})==0&&output.value==engine&&output.guard==0x1234abcd);
    auto identifierSlot=imports.resolve("SL_IID_ENGINE");assert(identifierSlot);
    uint32_t identifier=0;std::memcpy(&identifier,memory.translate(identifierSlot,4,Memory::Read),4);
    output.value=0;
    assert(call(query,{Value::word(engine),Value::word(identifier),Value::word(slot)})==0&&output.value&&output.guard==0x1234abcd);
    auto engineInterface=output.value;
    // UUID-by-value retains the same canonical native interface identity.
    std::array<unsigned char,16> copiedIdentifier{};std::memcpy(copiedIdentifier.data(),memory.translate(identifier,16,Memory::Read),16);
    auto copied=memory.borrow(copiedIdentifier.data(),copiedIdentifier.size(),Memory::Read);
    assert(call(query,{Value::word(engine),Value::word(copied),Value::word(slot)})==0&&output.value==engineInterface&&output.guard==0x1234abcd);
    uint32_t engineTable=0;std::memcpy(&engineTable,memory.translate(engineInterface,4,Memory::Read),4);
    auto engineMethods=static_cast<const uint32_t *>(memory.translate(engineTable,shapes::engineBytes,Memory::Read));
    output.value=0;
    assert(call(engineMethods[shapes::engineOutputMix/4],{Value::word(engineInterface),Value::word(slot),Value::word(0),Value::word(0),Value::word(0)})==0&&output.value&&output.guard==0x1234abcd);
    auto mix=output.value;uint32_t mixTable=0;std::memcpy(&mixTable,memory.translate(mix,4,Memory::Read),4);
    auto mixMethods=static_cast<const uint32_t *>(memory.translate(mixTable,shapes::objectBytes,Memory::Read));
    assert(call(mixMethods[shapes::objectRealize/4],{Value::word(mix),Value::word(0)})==0);
    call(mixMethods[shapes::objectDestroy/4],{Value::word(mix)});
    auto otherSlot=imports.resolve("SL_IID_VOLUME");assert(otherSlot);uint32_t other=0;std::memcpy(&other,memory.translate(otherSlot,4,Memory::Read),4);
    output.value=0xfeedbeef;
    assert(call(query,{Value::word(engine),Value::word(other),Value::word(slot)})!=0&&output.value==0xfeedbeef&&output.guard==0x1234abcd);
    call(destroy,{Value::word(engine)});
    auto addresses=imports.resolve("getaddrinfo");assert(addresses);
    assert(call(addresses,{Value::word(0),Value::word(0),Value::word(0),Value::word(slot)})==0);
    cycle=output.value;uint32_t next=0;std::memcpy(&next,memory.translate(cycle+shapes::addressNext,4,Memory::Read),4);assert(next==cycle&&output.guard==0x1234abcd);
    assert(call(addresses,{Value::word(0),Value::word(0),Value::word(0),Value::word(slot)})==0&&output.value==cycle);
  }
  // These are representations, not the native resources. Their single Imports
  // owner retires all of its storage; no stale aliases survive that owner.
  for(auto address:{engine,table,cycle}){bool retired=false;try{memory.translate(address,4,Memory::Read);}catch(const Memory::Fault &){retired=true;}assert(retired);}
}
static void scopedInterfaceViews(){
  scopedIdentifiers=true;
  Memory memory;Imports imports(memory,lookup);Thread thread(memory);
  auto call=[&](uint32_t gate,std::initializer_list<Value> args={}){assert(gate);return thread.call(gate,std::span(args.begin(),args.size()));};
  struct {uint32_t value,guard;} output{0,0x1234abcd};
  auto slot=memory.borrow(&output,sizeof output,Memory::Read|Memory::Write);
  assert(call(imports.resolve("slCreateEngine"),{Value::word(slot),Value::word(0),Value::word(0),Value::word(0),Value::word(0),Value::word(0)})==0);
  const auto object=output.value;uint32_t table=0;std::memcpy(&table,memory.translate(object,4,Memory::Read),4);
  uint32_t realize=0,query=0,destroy=0;
  std::memcpy(&realize,memory.translate(table+shapes::objectRealize,4,Memory::Read),4);
  std::memcpy(&query,memory.translate(table+shapes::objectQuery,4,Memory::Read),4);
  std::memcpy(&destroy,memory.translate(table+shapes::objectDestroy,4,Memory::Read),4);
  assert(call(realize,{Value::word(object),Value::word(0)})==0);
  // Relocation and dlsym retain the namespace's actual provider. It need not
  // also be globally visible when the erased GetInterface output is adapted.
  const auto identifierSlot=imports.resolve("SL_IID_ENGINE",sharedLookup("SL_IID_ENGINE"));assert(identifierSlot);
  uint32_t identifier=0;std::memcpy(&identifier,memory.translate(identifierSlot,4,Memory::Read),4);
  output.value=0;
  assert(call(query,{Value::word(object),Value::word(identifier),Value::word(slot)})==0&&output.value&&output.guard==0x1234abcd);
  const auto engine=output.value;std::memcpy(&table,memory.translate(engine,4,Memory::Read),4);
  memory.translate(table,shapes::engineBytes,Memory::Read);
  std::array<unsigned char,16> copied{};std::memcpy(copied.data(),memory.translate(identifier,copied.size(),Memory::Read),copied.size());
  auto copy=memory.borrow(copied.data(),copied.size(),Memory::Read);
  output.value=0;
  assert(call(query,{Value::word(object),Value::word(copy),Value::word(slot)})==0&&output.value==engine&&output.guard==0x1234abcd);
  bool bounded=false;try{memory.translate(engine,5,Memory::Read);}catch(const Memory::Fault&){bounded=true;}assert(bounded);
  uint32_t mixGate=0;std::memcpy(&mixGate,memory.translate(table+shapes::engineOutputMix,4,Memory::Read),4);
  output.value=0;
  assert(call(mixGate,{Value::word(engine),Value::word(slot),Value::word(0),Value::word(0),Value::word(0)})==0&&output.value&&output.guard==0x1234abcd);
  const auto mix=output.value;uint32_t mixTable=0,mixDestroy=0;std::memcpy(&mixTable,memory.translate(mix,4,Memory::Read),4);
  std::memcpy(&mixDestroy,memory.translate(mixTable+shapes::objectDestroy,4,Memory::Read),4);call(mixDestroy,{Value::word(mix)});
  const auto unsupportedSlot=imports.resolve("SL_IID_VOLUME",sharedLookup("SL_IID_VOLUME"));assert(unsupportedSlot);
  uint32_t unsupported=0;std::memcpy(&unsupported,memory.translate(unsupportedSlot,4,Memory::Read),4);output.value=0xfeedbeef;
  assert(call(query,{Value::word(object),Value::word(unsupported),Value::word(slot)})!=0&&output.value==0xfeedbeef&&output.guard==0x1234abcd);
  call(destroy,{Value::word(object)});
  scopedIdentifiers=false;
}
int main(int argc,char **argv){
  assert(argc>=2&&argc<=4);auto runtime=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!runtime){std::cerr<<dlerror()<<'\n';return 1;}
  if(const char *helper=getenv("ANDROID_ARM32_FORMAT_HELPER")){if(!dlopen(helper,RTLD_NOW|RTLD_GLOBAL)){std::cerr<<dlerror()<<'\n';return 1;}}
  sharedLookup=reinterpret_cast<void *(*)(const char *)>(dlsym(runtime,"kl_shim_lookup"));assert(sharedLookup);
  if(argc==3&&!std::strcmp(argv[2],"--media-counts")){
    countedInterfaceViews();std::cout<<"PASS original SL/XA counted interface arrays, native method gates, empty/null inputs and exact bounds\n";return 0;
  }
  if(argc==3&&!std::strcmp(argv[2],"--media-scoped")){
    scopedInterfaceViews();std::cout<<"PASS original scoped OpenSL IID output and exact interface bounds\n";return 0;
  }
  interfaceViews();
  Memory memory;Imports imports(memory,lookup);Thread thread(memory);
  auto guard=imports.resolve("__stack_chk_guard");assert(guard);
  uint32_t narrowGuard=0;std::memcpy(&narrowGuard,memory.translate(guard,4,Memory::Read),4);
  assert(narrowGuard==uint32_t(*static_cast<uintptr_t *>(sharedLookup("__stack_chk_guard"))) && narrowGuard!=0);
  assert(imports.resolve("__stack_chk_guard")==guard);
  imports.setThreadFactory([&]{return std::make_shared<Thread>(memory);});
  auto call=[&](const char *name,std::initializer_list<Value> args={}){auto gate=imports.resolve(name);assert(gate);return thread.call(gate,std::span(args.begin(),args.size()));};
  // Bionic preserves signed ARM32 socklen_t and unsigned ARM64 socklen_t.
  // Both scalar arguments and pointer outputs keep all32 original bits.
  assert(uint32_t(call("bind",{Value::word(0),Value::word(0),Value::word(0x80000001u)}))==uint32_t(-7));
  assert(socketLength==0x80000001u);
  unsigned socketBytes=0x80000003u;auto socketSize=memory.borrow(&socketBytes,sizeof socketBytes,Memory::Read|Memory::Write);
  assert(call("getsockname",{Value::word(0),Value::word(0),Value::word(socketSize)})==0);
  assert(socketLength==0x80000003u&&socketBytes==0x80000011u);
  // FILE is an opaque native resource, not a copyable Bionic/Darwin record.
  // Its original stdio owner must see the same identity across all imports.
  char streamName[]="/tmp/android-arm32-stdio-XXXXXX";
  int streamFd=mkstemp(streamName);assert(streamFd>=0);
  const char contents[]="container-prefix:archive-data";
  assert(write(streamFd,contents,sizeof contents)==ssize_t(sizeof contents));close(streamFd);
  char readMode[]="rb";
  auto streamPath=memory.borrow(streamName,sizeof streamName,Memory::Read);
  auto streamMode=memory.borrow(readMode,sizeof readMode,Memory::Read);
  auto stream=uint32_t(call("fopen",{Value::word(streamPath),Value::word(streamMode)}));assert(stream&&openedStream);
  assert(memory.translate(stream,1,Memory::Read)==openedStream);
  assert(call("fseek",{Value::word(stream),Value::word(17),Value::word(SEEK_SET)})==0);
  assert(call("ftell",{Value::word(stream)})==17);
  char readBytes[sizeof contents]{};auto readBuffer=memory.borrow(readBytes,sizeof readBytes,Memory::Read|Memory::Write);
  assert(call("fread",{Value::word(readBuffer),Value::word(1),Value::word(12),Value::word(stream)})==12);
  assert(!std::memcmp(readBytes,"archive-data",12));
  assert(call("fseeko64",{Value::word(stream),Value::wide(0),Value::word(SEEK_SET)})==0);
  assert(call("ftello64",{Value::word(stream)})==0);
  assert(call("fclose",{Value::word(stream)})==0);unlink(streamName);
  bool streamRetired=false;try{memory.translate(stream,1,Memory::Read);}catch(const Memory::Fault &){streamRetired=true;}
  assert(streamRetired);
  auto nativeGate=uint32_t(call("signal",{Value::word(10),Value::word(1)}));
  assert(installedCallback==reinterpret_cast<Handler>(uintptr_t(1)));
  memory.translate(nativeGate,4,Memory::Execute);
  const std::array<Value,1> callbackArguments{Value::word(73)};thread.call(nativeGate,callbackArguments);assert(nativeCallbackValue==73);
  assert(call("signal",{Value::word(10),Value::word(nativeGate)})==1&&installedCallback==nativeCallback);
  assert(call("signal",{Value::word(10),Value::word(UINT32_MAX)})==nativeGate&&installedCallback==reinterpret_cast<Handler>(UINTPTR_MAX));
  assert(call("signal",{Value::word(10),Value::word(nativeGate)})==UINT32_MAX&&installedCallback==nativeCallback);
  auto streams=imports.resolve("__sF");assert(streams);
  for(unsigned n=0;n<3;n++)assert(call("fileno",{Value::word(streams+n*84)})==n);
  auto optarg=imports.resolve("optarg"),optind=imports.resolve("optind");assert(optarg&&optind);
  char command[]="probe",option[]="-a",argument[]="payload",spec[]="a:";
  uint32_t argv32[]={memory.borrow(command,sizeof command,Memory::Read),memory.borrow(option,sizeof option,Memory::Read),memory.borrow(argument,sizeof argument,Memory::Read),0};
  uint32_t argvAddress=memory.borrow(argv32,sizeof argv32,Memory::Read|Memory::Write),specAddress=memory.borrow(spec,sizeof spec,Memory::Read);
  assert(call("getopt",{Value::word(3),Value::word(argvAddress),Value::word(specAddress)})=='a');
  assert(memory.string(*static_cast<uint32_t *>(memory.translate(optarg,4,Memory::Read)))==argument);
  for(auto requested:{0u,1u,17u,63u}) {
    auto allocated=uint32_t(call("malloc",{Value::word(requested)}));assert(allocated);
    auto usable=uint32_t(call("malloc_usable_size",{Value::word(allocated)}));assert(usable>=requested);
    auto bytes=static_cast<unsigned char *>(memory.translate(allocated,usable,Memory::Write));
    std::memset(bytes,0x63,usable);if(usable)assert(bytes[usable-1]==0x63);
    const size_t extent=(std::max(size_t(1),size_t(usable))+shapes::allocationAlignment-1)&~size_t(shapes::allocationAlignment-1);
    bool beyond=false;try{memory.translate(allocated,extent+1,Memory::Read);}catch(const Memory::Fault &){beyond=true;}
    // A compact neighboring region may start at allocated+usable. The span
    // rooted in this allocation stops after its native alignment unit.
    assert(beyond);
    call("free",{Value::word(allocated)});
    bool released=false;try{memory.translate(allocated,1,Memory::Read);}catch(const Memory::Fault &){released=true;}
    assert(released);
  }
  auto pointer=uint32_t(call("malloc",{Value::word(64)}));assert(pointer);
  char text[]="1234567890123";auto source=memory.borrow(text,sizeof text,Memory::Read|Memory::Write);
  assert(call("memcpy",{Value::word(pointer),Value::word(source),Value::word(sizeof text)})==pointer);
  assert(!std::strcmp(static_cast<char *>(memory.translate(pointer,64,Memory::Read)),text));
  assert(call("strtoll",{Value::word(pointer),Value::word(0),Value::word(10)})==1234567890123ULL);
  assert(call("strtol",{Value::word(pointer),Value::word(0),Value::word(10)})==uint32_t(1234567890123ULL));
  pointer=uint32_t(call("realloc",{Value::word(pointer),Value::word(128)}));assert(pointer);
  assert(!std::strcmp(static_cast<char *>(memory.translate(pointer,128,Memory::Read)),text));
  call("free",{Value::word(pointer)});
  bool retired=false;try{memory.translate(pointer,1,Memory::Read);}catch(const std::runtime_error &){retired=true;}assert(retired);
  auto output=memory.allocate(0x20000000,4096,Memory::Read|Memory::Write);
  // TLS values are opaque, including inaccessible guest addresses. Native
  // storage and callbacks preserve their bits without demanding readable data.
  assert(call("pthread_key_create",{Value::word(output),Value::word(0)})==0);
  auto key=*static_cast<uint32_t *>(memory.translate(output,4,Memory::Read));
  auto inaccessible=memory.allocate(0x40000000,4096,0);
  for(auto token:{uint32_t(0),uint32_t(0xfeed1234),inaccessible}){
    assert(call("pthread_setspecific",{Value::word(key),Value::word(token)})==0);
    assert(call("pthread_getspecific",{Value::word(key)})==token);
  }
  assert(call("pthread_key_delete",{Value::word(key)})==0);memory.unmap(inaccessible);
  unsigned char borrowedByte=0;
  auto oneByte=memory.borrow(&borrowedByte,1,Memory::Read,"native buffer fixture");
  bool originReported=false;
  try{memory.translate(oneByte+1,1,Memory::Read);}catch(const std::runtime_error &error){
    auto detail=std::string(error.what());originReported=detail.find("accessible=1")!=detail.npos && detail.find("origin=native buffer fixture")!=detail.npos;
  }
  assert(originReported);memory.unmap(oneByte);
  // Mapping extent and guest page ownership are independent of macOS pages.
  auto mapped=uint32_t(call("__mmap2",{Value::word(0),Value::word(12288),Value::word(3),Value::word(0x22),Value::word(UINT32_MAX),Value::word(0)}));
  assert(mapped!=UINT32_MAX && mapped%4096==0);
  std::memset(memory.translate(mapped,12288,Memory::Write),0x5a,12288);
  assert(call("mprotect",{Value::word(mapped+4096),Value::word(4096),Value::word(1)})==0);
  bool protectedPage=false;try{memory.translate(mapped+4096,1,Memory::Write);}catch(const std::runtime_error&){protectedPage=true;}assert(protectedPage);
  assert(*static_cast<unsigned char *>(memory.translate(mapped+8192,1,Memory::Write))==0x5a);
  assert(call("munmap",{Value::word(mapped+4096),Value::word(4096)})==0);
  bool hole=false;try{memory.translate(mapped+4096,1,Memory::Read);}catch(const std::runtime_error&){hole=true;}assert(hole);
  assert(*static_cast<unsigned char *>(memory.translate(mapped,1,Memory::Read))==0x5a);
  assert(*static_cast<unsigned char *>(memory.translate(mapped+8192,1,Memory::Read))==0x5a);
  auto replacement=uint32_t(call("mmap",{Value::word(mapped+4096),Value::word(4096),Value::word(3),Value::word(0x32),Value::word(UINT32_MAX),Value::word(0)}));
  assert(replacement==mapped+4096 && *static_cast<unsigned char *>(memory.translate(replacement,1,Memory::Read))==0);
  assert(call("mmap",{Value::word(mapped),Value::word(4096),Value::word(3),Value::word(0x100022),Value::word(UINT32_MAX),Value::word(0)})==UINT32_MAX);
  assert(*static_cast<unsigned char *>(memory.translate(mapped,1,Memory::Read))==0x5a);
  assert(call("munmap",{Value::word(mapped),Value::word(12288)})==0);
  bool mappingRetired=false;try{memory.translate(mapped+8192,1,Memory::Read);}catch(const std::runtime_error&){mappingRetired=true;}assert(mappingRetired);
  auto executable=uint32_t(call("mmap64",{Value::word(0),Value::word(4096),Value::word(3),Value::word(0x22),Value::word(UINT32_MAX),Value::wide(0)}));
  const uint32_t return42[]={0xe3a0002a,0xe12fff1e};std::memcpy(memory.translate(executable,sizeof return42,Memory::Write),return42,sizeof return42);
  assert(call("mprotect",{Value::word(executable),Value::word(4096),Value::word(5)})==0);
  assert(thread.call(executable)==42);assert(call("munmap",{Value::word(executable),Value::word(4096)})==0);
  char fileName[]="/tmp/android-arm32-map-XXXXXX";int file=mkstemp(fileName);assert(file>=0);unlink(fileName);
  std::array<unsigned char,8192> fileBytes{};fileBytes.fill(0x17);fileBytes[4096]=0x71;assert(write(file,fileBytes.data(),fileBytes.size())==ssize_t(fileBytes.size()));
  auto fileMap=uint32_t(call("__mmap2",{Value::word(0),Value::word(4096),Value::word(1),Value::word(2),Value::word(unsigned(file)),Value::word(1)}));
  assert(fileMap!=UINT32_MAX && *static_cast<unsigned char *>(memory.translate(fileMap,1,Memory::Read))==0x71);
  assert(call("munmap",{Value::word(fileMap),Value::word(4096)})==0);close(file);
  assert(call("mmap",{Value::word(0),Value::word(0),Value::word(3),Value::word(0x22),Value::word(UINT32_MAX),Value::word(0)})==UINT32_MAX);
  // Loader address queries must reach the original owner even when the value
  // does not identify readable memory. Android reports absence, not a fault.
  std::memset(memory.translate(output,16,Memory::Write),0x10,16);
  assert(call("dladdr",{Value::word(0x10),Value::word(output)})==0);
  for(unsigned i=0;i<16;i++)assert(static_cast<unsigned char *>(memory.translate(output,16,Memory::Read))[i]==0x10);
  assert(call("dladdr",{Value::word(0),Value::word(output)})==0);
  call("posix_memalign",{Value::word(output),Value::word(16),Value::word(128)});
  std::memcpy(&pointer,memory.translate(output,4,Memory::Read),4);assert(pointer);
  assert(uintptr_t(memory.translate(pointer,128,Memory::Write))%16==0);call("free",{Value::word(pointer)});
  call("clock_gettime",{Value::word(0),Value::word(output)});
  auto values=static_cast<int32_t *>(memory.translate(output,8,Memory::Read));assert(values[0]==42 && values[1]==123456789);
  // Original Bionic signal sets change representation between the ABIs. Both
  // APIs enter the same signal owner, including their normal copy-back paths.
  std::memset(memory.translate(output,16,Memory::Write),0xcc,16);
  assert(call("sigemptyset",{Value::word(output)})==0);
  assert(call("sigaddset",{Value::word(output),Value::word(10)})==0);
  assert(call("sigismember",{Value::word(output),Value::word(10)})==1);
  assert(*static_cast<uint32_t *>(memory.translate(output,4,Memory::Read))==(1u<<9));
  assert(*static_cast<uint32_t *>(memory.translate(output+4,4,Memory::Read))==0xcccccccc);
  assert(call("sigemptyset64",{Value::word(output)})==0);
  assert(call("sigaddset64",{Value::word(output),Value::word(48)})==0);
  assert(call("sigismember64",{Value::word(output),Value::word(48)})==1);
  uint64_t wideMask=0;std::memcpy(&wideMask,memory.translate(output,8,Memory::Read),8);assert(wideMask==(1ULL<<47));
  auto action=output+32,previous=output+64,queried=output+96;
  auto installAction=[&](uint32_t handler,uint32_t flags){
    const uint32_t words[]={handler,1u<<11,flags,0};std::memcpy(memory.translate(action,sizeof words,Memory::Write),words,sizeof words);
    assert(call("sigaction",{Value::word(10),Value::word(action),Value::word(previous)})==0);
    assert(call("sigaction",{Value::word(10),Value::word(0),Value::word(queried)})==0);
    auto result=static_cast<uint32_t *>(memory.translate(queried,16,Memory::Read));
    assert(result[0]==handler && result[1]==(1u<<11) && (result[2]&4)==(flags&4));
  };
  installAction(1,0); // SIG_IGN is an ABI sentinel, not a readable pointer.
  assert(call("sigaction",{Value::word(10),Value::word(previous),Value::word(0)})==0);
  unsigned delivered=0;
  auto signalHandler=memory.import([&](Thread &current){delivered=current.argument(0);return 0;});
  installAction(signalHandler,0);
  assert(call("raise",{Value::word(10)})==0 && delivered==10);
  assert(call("sigaction",{Value::word(10),Value::word(previous),Value::word(0)})==0);
  installAction(signalHandler,4); // The three-argument union member round-trips.
  assert(call("sigaction",{Value::word(10),Value::word(previous),Value::word(0)})==0);
  call("glClearColor",{Value::word(std::bit_cast<uint32_t>(.25f)),Value::word(std::bit_cast<uint32_t>(.5f)),Value::word(std::bit_cast<uint32_t>(.75f)),Value::word(std::bit_cast<uint32_t>(1.f))});
  assert((color==std::array<float,4>{.25f,.5f,.75f,1.f}));
  auto version=uint32_t(call("glGetString",{Value::word(0x1f02)}));
  assert(memory.string(version)==reinterpret_cast<const char *>(graphicsVersion));
  assert(memory.translate(version,sizeof graphicsVersion,Memory::Read)==graphicsVersion);
  assert(call("glGetStringi",{Value::word(0x1f03),Value::word(0)})==version);
  assert(call("glGetString",{Value::word(0)})==0);
  assert(call("glGetStringi",{Value::word(0x1f03),Value::word(1)})==0);
  call("glDrawElements",{Value::word(4),Value::word(3),Value::word(0x1403),Value::word(source)});assert(observed==text);
  elementBuffer=1;call("glDrawElements",{Value::word(4),Value::word(3),Value::word(0x1403),Value::word(12)});assert(observed==reinterpret_cast<void *>(12));
  call("glVertexAttribPointer",{Value::word(0),Value::word(3),Value::word(0x1406),Value::word(0),Value::word(12),Value::word(source)});assert(observed==text);
  arrayBuffer=1;call("glVertexAttribPointer",{Value::word(0),Value::word(3),Value::word(0x1406),Value::word(0),Value::word(12),Value::word(24)});assert(observed==reinterpret_cast<void *>(24));
  auto code=memory.allocate(0x30000000,4096,Memory::Read|Memory::Write|Memory::Execute);
  const uint32_t compare[]={0xe5900000,0xe5911000,0xe0400001,0xe12fff1e};std::memcpy(memory.loadAddress(code,sizeof compare),compare,sizeof compare);
  int unsorted[]={8,3,9,1};auto array=memory.borrow(unsorted,sizeof unsorted,Memory::Read|Memory::Write);
  call("qsort",{Value::word(array),Value::word(4),Value::word(4),Value::word(code)});
  assert((std::array{unsorted[0],unsorted[1],unsorted[2],unsorted[3]}==std::array{1,3,8,9}));
  assert(imports.resolve("__cxa_finalize"));
  // These families use the original shared services. Protect adjacent ARM32
  // values while widened native scanf/flock records are copied back.
  char scanText[]="2147483646 12345 65000 1.5 cat",scanFormat[]="%ld %zu %hu %lf %3s";
  auto scanInput=memory.borrow(scanText,sizeof scanText,Memory::Read),scanSpec=memory.borrow(scanFormat,sizeof scanFormat,Memory::Read);
  struct {int32_t value;uint32_t guard;} longValue{0,0x12345678};
  struct {uint32_t value,guard;} sizeValue{0,0xabcdef01};
  struct {uint16_t value,guard;} shortValue{0,0xcafe};double realValue=0;
  struct {char value[4];uint32_t guard;} stringValue{{0},0x87654321};
  auto longAddress=memory.borrow(&longValue,sizeof longValue,Memory::Read|Memory::Write),sizeAddress=memory.borrow(&sizeValue,sizeof sizeValue,Memory::Read|Memory::Write),shortAddress=memory.borrow(&shortValue,sizeof shortValue,Memory::Read|Memory::Write),realAddress=memory.borrow(&realValue,sizeof realValue,Memory::Read|Memory::Write),stringAddress=memory.borrow(&stringValue,sizeof stringValue,Memory::Read|Memory::Write);
  assert(call("sscanf",{Value::word(scanInput),Value::word(scanSpec),Value::word(longAddress),Value::word(sizeAddress),Value::word(shortAddress),Value::word(realAddress),Value::word(stringAddress)})==5);
  assert(longValue.value==2147483646&&longValue.guard==0x12345678&&sizeValue.value==12345&&sizeValue.guard==0xabcdef01&&shortValue.value==65000&&shortValue.guard==0xcafe&&realValue==1.5&&!std::strcmp(stringValue.value,"cat")&&stringValue.guard==0x87654321);
  wchar_t firstWide[]=L"abc",secondWide[]=L"abd",wideOutput[8]{};
  auto firstWideAddress=memory.borrow(firstWide,sizeof firstWide,Memory::Read),secondWideAddress=memory.borrow(secondWide,sizeof secondWide,Memory::Read),wideOutputAddress=memory.borrow(wideOutput,sizeof wideOutput,Memory::Read|Memory::Write);
  assert(int32_t(call("wcscoll",{Value::word(firstWideAddress),Value::word(secondWideAddress)}))<0);
  assert(call("wcsxfrm",{Value::word(wideOutputAddress),Value::word(firstWideAddress),Value::word(8)})==3&&!std::wcscmp(wideOutput,firstWide));
  char variadicFile[]="/tmp/android-arm32-varargs-XXXXXX";int originalFile=mkstemp(variadicFile);assert(originalFile>=0);close(originalFile);
  auto variadicFileAddress=memory.borrow(variadicFile,sizeof variadicFile,Memory::Read);int nativeFile=int(call("open",{Value::word(variadicFileAddress),Value::word(2),Value::word(0600)}));assert(nativeFile>=0);
  assert(call("fcntl",{Value::word(unsigned(nativeFile)),Value::word(2),Value::word(1)})==0&&call("fcntl",{Value::word(unsigned(nativeFile)),Value::word(1)})==1);
  struct {int16_t type,whence;int32_t start,length,pid;uint32_t guard;} lockRecord{1,SEEK_SET,3,10,0,0xfeedabcd};
  auto lockAddress=memory.borrow(&lockRecord,sizeof lockRecord,Memory::Read|Memory::Write);
  assert(call("fcntl",{Value::word(unsigned(nativeFile)),Value::word(6),Value::word(lockAddress)})==0);
  lockRecord.type=1;assert(call("fcntl",{Value::word(unsigned(nativeFile)),Value::word(5),Value::word(lockAddress)})==0&&lockRecord.type==2&&lockRecord.guard==0xfeedabcd);
  call("close",{Value::word(unsigned(nativeFile))});unlink(variadicFile);
  int pipes[2][2];assert(!pipe(pipes[0])&&!pipe(pipes[1]));
  int epoll=int(call("epoll_create1",{Value::word(0)}));assert(epoll>=0);
  struct Event {uint32_t flags,padding;uint64_t data;};static_assert(sizeof(Event)==16);
  Event event{1,0,0x123456789abcdef0ULL};auto eventAddress=memory.borrow(&event,sizeof event,Memory::Read|Memory::Write);
  assert(call("epoll_ctl",{Value::word(unsigned(epoll)),Value::word(1),Value::word(unsigned(pipes[0][0])),Value::word(eventAddress)})==0);
  event.data=0xfedcba9876543210ULL;assert(call("epoll_ctl",{Value::word(unsigned(epoll)),Value::word(1),Value::word(unsigned(pipes[1][0])),Value::word(eventAddress)})==0);
  assert(write(pipes[0][1],"a",1)==1&&write(pipes[1][1],"b",1)==1);
  struct {Event events[2];uint64_t guard;} ready{{},0xfeedabcdef123456ULL};auto readyAddress=memory.borrow(&ready,sizeof ready,Memory::Read|Memory::Write);
  assert(call("epoll_wait",{Value::word(unsigned(epoll)),Value::word(readyAddress),Value::word(2),Value::word(100)})==2);
  assert(ready.guard==0xfeedabcdef123456ULL&&ready.events[0].data!=ready.events[1].data);
  for(const auto&item:ready.events)assert(item.data==0x123456789abcdef0ULL||item.data==0xfedcba9876543210ULL);
  call("close",{Value::word(unsigned(epoll))});for(const auto&pair:pipes){close(pair[0]);close(pair[1]);}
  std::cout<<"PASS generated native ABI: shared allocations/copy/free, integer widths, struct copyback, softfp, GL client pointers/offsets, native-to-guest callbacks\n";
}
