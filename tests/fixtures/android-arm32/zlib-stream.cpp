#include "arm32.h"
#include "native-imports.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <vector>
#include ARM32_IMPORTS_SOURCE

using namespace maclauncher::arm32;
static unsigned nativeCalls;
static z_streamp retainedInflate;
static int inflate1(z_streamp s,const char *v,int n){++nativeCalls;assert(n==sizeof(z_stream));int result=inflateInit_(s,v,n);if(result==Z_OK)retainedInflate=s;return result;}
static int inflateStep(z_streamp s,int flush){assert(s==retainedInflate);return inflate(s,flush);}
static int inflate2(z_streamp s,int w,const char *v,int n){++nativeCalls;assert(n==sizeof(z_stream));return inflateInit2_(s,w,v,n);}
static int backInit(z_streamp s,int w,unsigned char *b,const char *v,int n){++nativeCalls;assert(n==sizeof(z_stream));return inflateBackInit_(s,w,b,v,n);}
static int deflate1(z_streamp s,int l,const char *v,int n){++nativeCalls;assert(n==sizeof(z_stream));return deflateInit_(s,l,v,n);}
static int deflate2(z_streamp s,int l,int m,int w,int b,int st,const char *v,int n){++nativeCalls;assert(n==sizeof(z_stream));return deflateInit2_(s,l,m,w,b,st,v,n);}
static void *lookup(const char *name){
  if(!std::strcmp(name,"inflateInit_"))return reinterpret_cast<void *>(inflate1);
  if(!std::strcmp(name,"inflate"))return reinterpret_cast<void *>(inflateStep);
  if(!std::strcmp(name,"inflateInit2_"))return reinterpret_cast<void *>(inflate2);
  if(!std::strcmp(name,"inflateBackInit_"))return reinterpret_cast<void *>(backInit);
  if(!std::strcmp(name,"deflateInit_"))return reinterpret_cast<void *>(deflate1);
  if(!std::strcmp(name,"deflateInit2_"))return reinterpret_cast<void *>(deflate2);
  return dlsym(RTLD_DEFAULT,name);
}
int main(){
  Memory memory;Thread thread(memory);Imports imports(memory,lookup);
  imports.setThreadFactory([&]{return std::make_shared<Thread>(memory);});
  auto fn=std::find_if(std::begin(functions),std::end(functions),[](const auto &f){return std::string_view(f.name)=="inflateInit_";});assert(fn!=std::end(functions));
  const auto &signature=types[fn->type],&stream=types[types[signature.parameters[0]].element];
  assert(stream.guestSize==56&&stream.hostSize==sizeof(z_stream));
  std::vector<uint8_t> storage(stream.guestSize);auto address=memory.borrow(storage.data(),storage.size(),Memory::Read|Memory::Write);
  auto field=[&](const char *name)->const Field &{auto f=std::find_if(stream.fields,stream.fields+stream.fieldCount,[&](const auto &f){return std::string_view(f.name)==name;});assert(f!=stream.fields+stream.fieldCount);return *f;};
  auto set=[&](const char *name,uint32_t value){const auto &f=field(name);write(storage.data()+f.guestOffset/8,value,types[f.type].guestSize);};
  auto get=[&](const char *name){const auto &f=field(name);return read(storage.data()+f.guestOffset/8,types[f.type].guestSize);};
  char version[]=ZLIB_VERSION,badVersion[]="0.0";auto v=memory.borrow(version,sizeof version,Memory::Read),bad=memory.borrow(badVersion,sizeof badVersion,Memory::Read);
  std::array<uint8_t,32768> window{};auto win=memory.borrow(window.data(),window.size(),Memory::Read|Memory::Write);
  auto call=[&](const char *name,std::vector<uint32_t> args){auto gate=imports.resolve(name);assert(gate);std::vector<Value> values;for(auto x:args)values.push_back(Value::word(x));return int32_t(thread.call(gate,values));};
  for(const auto *name:{"inflateInit_","inflateInit2_","inflateBackInit_","deflateInit_","deflateInit2_"}){
    const bool back=std::string_view(name)=="inflateBackInit_",deflate=std::string_view(name).starts_with("deflate");
    std::vector<uint32_t> args{address};if(std::string_view(name)=="inflateInit2_")args.push_back(15);if(back){args.push_back(15);args.push_back(win);}if(deflate)args.push_back(uint32_t(-1));if(std::string_view(name)=="deflateInit2_"){args.push_back(Z_DEFLATED);args.push_back(15);args.push_back(8);args.push_back(Z_DEFAULT_STRATEGY);}args.push_back(v);args.push_back(stream.guestSize);
    for(uint32_t invalid:{0u,55u,57u,uint32_t(sizeof(z_stream)),UINT32_MAX}){std::fill(storage.begin(),storage.end(),0xa5);auto before=storage;auto badArgs=args;badArgs.back()=invalid;unsigned calls=nativeCalls;errno=EDOM;assert(call(name,badArgs)==Z_VERSION_ERROR&&errno==EDOM);assert(nativeCalls==calls&&storage==before);}
    std::fill(storage.begin(),storage.end(),0);auto badArgs=args;badArgs[badArgs.size()-2]=bad;assert(call(name,badArgs)==Z_VERSION_ERROR);assert(call(name,args)==Z_OK);
    assert(call(back?"inflateBackEnd":deflate?"deflateEnd":"inflateEnd",{address})==Z_OK);
  }
  const char input[]="Original zlib record conversion and persistent stream ownership";std::array<uint8_t,512> compressed{},output{};
  auto in=memory.borrow(const_cast<char *>(input),sizeof input,Memory::Read),out=memory.borrow(compressed.data(),compressed.size(),Memory::Read|Memory::Write),decoded=memory.borrow(output.data(),output.size(),Memory::Read|Memory::Write);
  std::fill(storage.begin(),storage.end(),0);assert(call("deflateInit_",{address,6,v,uint32_t(stream.guestSize)})==Z_OK);set("next_in",in);set("avail_in",sizeof input);set("next_out",out);set("avail_out",compressed.size());assert(call("deflate",{address,Z_FINISH})==Z_STREAM_END);unsigned count=get("total_out");assert(count>0);assert(call("deflateEnd",{address})==Z_OK);
  std::fill(storage.begin(),storage.end(),0);assert(call("inflateInit_",{address,v,uint32_t(stream.guestSize)})==Z_OK);
  // Keep competing same-size allocations live. A transient z_stream copy can
  // otherwise accidentally reuse its previous address and mask the original
  // zlib identity check. These allocations are unrelated to the stream owner.
  std::vector<std::vector<uint8_t>> competing;
  for(unsigned n=0;n<128;n++)competing.emplace_back(sizeof(z_stream),uint8_t(n));
  set("next_in",out);set("avail_in",count);set("next_out",decoded);set("avail_out",output.size());assert(call("inflate",{address,Z_FINISH})==Z_STREAM_END);assert(get("total_out")==sizeof input&&!std::memcmp(input,output.data(),sizeof input));
  // Copy initializes an independent original state which also retains its
  // destination record. Reset and another streaming call must use that same
  // identity; End retires its conversion without retiring caller storage.
  std::vector<uint8_t> copiedStorage(stream.guestSize);
  auto copied=memory.borrow(copiedStorage.data(),copiedStorage.size(),Memory::Read|Memory::Write);
  assert(call("inflateCopy",{copied,address})==Z_OK);
  assert(call("inflateReset",{copied})==Z_OK);
  assert(call("inflateEnd",{copied})==Z_OK);
  assert(call("inflateEnd",{address})==Z_OK);
  const auto settledMappings=memory.mappings().size();
  for(unsigned n=0;n<32;n++){
    std::fill(storage.begin(),storage.end(),0);assert(call("inflateInit_",{address,v,uint32_t(stream.guestSize)})==Z_OK);
    assert(call("inflateEnd",{address})==Z_OK);
  }
  assert(memory.mappings().size()==settledMappings);
  assert(memory.translate(address,storage.size(),Memory::Read|Memory::Write)==storage.data());
  assert(memory.translate(copied,copiedStorage.size(),Memory::Read|Memory::Write)==copiedStorage.data());
  // A stream can reuse the same guest bytes after its original End call.
  std::fill(storage.begin(),storage.end(),0);assert(call("inflateInit_",{address,v,uint32_t(stream.guestSize)})==Z_OK);
  set("next_in",out);set("avail_in",count);set("next_out",decoded);set("avail_out",8);
  assert(call("inflate",{address,Z_NO_FLUSH})==Z_OK);assert(get("total_out")==8);
  set("next_out",decoded+8);set("avail_out",output.size()-8);
  assert(call("inflate",{address,Z_FINISH})==Z_STREAM_END);assert(get("total_out")==sizeof input);
  assert(call("inflateEnd",{address})==Z_OK);
  std::puts("PASS original zlib five initialization ABIs, invalid sizes/version, stable record identity, copy/End/reuse and streaming compression round trip");
}
