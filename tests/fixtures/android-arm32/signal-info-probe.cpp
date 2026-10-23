#include "arm32.h"
#include <cassert>
#include <cstdio>
#include <fstream>
#include <iterator>
#define private public
#include "native-imports.h"
#undef private
#include ARM32_IMPORTS_SOURCE
using namespace maclauncher::arm32;
static void*lookup(const char*){return nullptr;}
static std::vector<uint8_t> bytes(const char*path){std::ifstream f(path,std::ios::binary);assert(f);return {std::istreambuf_iterator<char>(f),{}};}
int main(int argc,char**argv){
 assert(argc==3);auto guest=bytes(argv[1]),host=bytes(argv[2]);
 unsigned info=0,action=0;for(unsigned i=0;i<std::size(types);i++){
  if(std::string_view(types[i].name)=="siginfo_t")info=i;
  if(std::string_view(types[i].name)=="struct sigaction")action=i;
 }
 assert(info&&action);const auto&t=types[info];assert(t.guestSize==128&&t.hostSize==128);
 assert(!guest.empty()&&guest.size()==host.size()&&guest.size()%128==0);
 Memory memory;Imports imports(memory,lookup);Imports::Impl::Transfer transfer(*imports.impl);
 for(size_t i=0;i<guest.size();i+=128)for(bool toHost:{false,true}){
  std::array<uint8_t,144> output;output.fill(0xa5);const auto&from=toHost?guest:host;const auto&expected=toHost?host:guest;
  transfer.convert(info,from.data()+i,output.data()+8,toHost);
  for(unsigned j=0;j<8;j++)assert(output[j]==0xa5&&output[136+j]==0xa5);
  if(std::memcmp(output.data()+8,expected.data()+i,128)){
   for(unsigned j=0;j<128;j++)if(output[j+8]!=expected[i+j])std::fprintf(stderr,"record%zu toHost%d byte%u got%02x expected%02x\n",i/128,toHost,j,output[j+8],expected[i+j]);
   assert(false);
  }
 }
 // Fault addresses use the existing Memory alias; inaccessible addresses above
 // remain data, never an attempted mapped-byte read or newly borrowed owner.
 auto addr=Imports::Impl::Transfer::signalPath(info,"_sifields._sigfault._addr");
 auto sample=std::vector<uint8_t>(guest.begin()+7*128,guest.begin()+8*128);
 uint32_t alias=memory.allocate(0,16,Memory::Read|Memory::Write);void*native=memory.translate(alias,1,0);
 write(sample.data()+addr.guest,alias,4);std::array<uint8_t,128> nativeInfo{};
 transfer.convert(info,sample.data(),nativeInfo.data(),true);assert(read(nativeInfo.data()+addr.host,8)==uintptr_t(native));
 std::array<uint8_t,128> back{};transfer.convert(info,nativeInfo.data(),back.data(),false);assert(read(back.data()+addr.guest,4)==alias);
 // Exercise the original generated three-argument sigaction callback through
 // actual native libffi and the same active Memory/typed representation owner.
 auto handler=Imports::Impl::Transfer::signalPath(action,"sa_sigaction");unsigned signature=types[handler.type].element;
 imports.setThreadFactory([&]{return std::make_shared<Thread>(memory);});unsigned calls=0;uint32_t lastAlias=0;
 auto errorField=Imports::Impl::Transfer::signalPath(info,"si_errno");
 imports.setCallback([&](Thread&,uint32_t,std::span<const Value> values){
  assert(values.size()==3);auto*converted=memory.translate(uint32_t(values[1].bits),128,Memory::Read);
  assert(!std::memcmp(converted,guest.data()+calls*128,128));lastAlias=uint32_t(values[1].bits);
  write(static_cast<uint8_t*>(converted)+errorField.guest,17,4);calls++;return 0;
 });
 auto callback=reinterpret_cast<void(*)(int,void*,void*)>(imports.impl->callback(0x12340000,signature));
 for(size_t i=0;i<host.size();i+=128){
  callback(int(read(host.data()+i,4)),host.data()+i,nullptr);
  assert(read(host.data()+i+errorField.host,4)==17);
  bool retired=false;try{memory.translate(lastAlias,1,0);}catch(const std::runtime_error&){retired=true;}assert(retired);
  assert(imports.impl->data.empty());
 }
 assert(calls==guest.size()/128);
 std::puts("PASS original Android signal union families, both widths, guarded spans, address aliases and native callback ingress");
}
