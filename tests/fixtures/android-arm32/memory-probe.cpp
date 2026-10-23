#include "arm32.h"
#include <algorithm>
#include <array>
#include <cassert>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <latch>
#include <random>
#include <set>
#include <sys/mman.h>
#include <thread>
#include <vector>
using namespace maclauncher::arm32;
namespace {
constexpr unsigned rw=Memory::Read|Memory::Write;
template<class F> void faults(F action){bool failed=false;try{action();}catch(const Memory::Fault&){failed=true;}assert(failed);}
void semantics(){
  Memory memory;
  Thread thread(memory);
  const auto code=memory.allocate(0x30000000,4096,rw|Memory::Execute);
  const uint32_t instructions[]={0xe5900000,0xe12fff1e,0xe5801000,0xe12fff1e};
  std::memcpy(memory.translate(code,sizeof instructions,Memory::Write),instructions,sizeof instructions);
  auto load=[&](uint32_t address){const std::array args={Value::word(address)};return uint32_t(thread.call(code,args));};
  auto store=[&](uint32_t address,uint32_t value){const std::array args={Value::word(address),Value::word(value)};thread.call(code+8,args);};
  auto cpuFault=[&](auto action){bool failed=false;try{action();}catch(const std::runtime_error &){failed=true;}assert(failed);};
  memory.map(0x200000,12288,rw);
  auto *owned=static_cast<uint8_t*>(memory.translate(0x200000,12288,rw));
  store(0x200000,0x12345678);assert(load(0x200000)==0x12345678);
  assert(memory.addressOf(owned+12287)==0x202fff);
  assert(memory.addressOf(owned+12288)==0);
  memory.protect(0x201000,4096,Memory::Read);
  cpuFault([&]{store(0x201000,7);});
  cpuFault([&]{store(0x200ffe,7);}); // Cross-page writes retain both page permissions.
  assert(load(0x200ffe)==0);
  faults([&]{memory.translate(0x200fff,2,Memory::Write);});
  assert(memory.translate(0x200fff,2,Memory::Read)==owned+4095);
  memory.unmap(0x201000,4096);
  cpuFault([&]{load(0x201000);});
  assert(memory.addressOf(owned+4095)==0x200fff);
  assert(memory.addressOf(owned+4096)==0);
  assert(memory.addressOf(owned+8192)==0x202000);
  faults([&]{memory.translate(0x201000,1,Memory::Read);});
  memory.unmap(0x200000);memory.unmap(0x202000);
  memory.map(0x200000,4096,rw);store(0x200000,0x87654321);assert(load(0x200000)==0x87654321);memory.unmap(0x200000);
  assert(memory.addressOf(owned)==0 && memory.addressOf(owned+8192)==0);

  std::vector<uint8_t> bytes(32768);
  const auto first=memory.borrow(bytes.data()+8,17,rw);
  const auto second=memory.borrow(bytes.data(),4096,rw);
  assert(first<second && memory.addressOf(bytes.data()+8)==first);
  assert(memory.addressOf(bytes.data()+24)==first+16);
  assert(memory.addressOf(bytes.data()+25)==second+25);
  faults([&]{memory.translate(first+16,2,Memory::Read);});
  cpuFault([&]{load(first+16);}); // Partial borrowed pages always use exact bounds.
  int retired=0;
  auto owner=std::shared_ptr<void>(bytes.data(),[&](void*){++retired;});
  const auto lower=memory.mapNative(bytes.data(),12288,rw,owner,0x10000000,true);
  owner.reset();
  assert(memory.addressOf(bytes.data()+8)==lower+8);
  memory.translate(lower+4096,1,Memory::Read); // Populate the lookup hint before splitting it.
  memory.unmap(lower+4096,4096);
  assert(retired==0 && memory.addressOf(bytes.data()+8192)==lower+8192);
  assert(memory.addressOf(bytes.data()+4096)==0);
  const auto replacement=memory.mapNative(bytes.data()+16384,4096,rw,{},lower,true);
  assert(replacement==lower && memory.translate(lower,1,Memory::Read)==bytes.data()+16384);
  assert(memory.addressOf(bytes.data()+8)==first);
  memory.unmap(lower+8192);assert(retired==1);
  memory.unmap(lower);memory.unmap(first);
  assert(memory.addressOf(bytes.data()+8)==second+8);
  memory.unmap(second);assert(memory.addressOf(bytes.data()+8)==0);

  struct Alias{uint32_t base;size_t offset,size;};
  std::vector<Alias> aliases;
  std::minstd_rand random(5219);
  for(size_t i=0;i<512;++i){
    const size_t offset=random()%1024,size=1+random()%256;
    aliases.push_back({memory.borrow(bytes.data()+offset,uint32_t(size),rw),offset,size});
  }
  auto verify=[&]{
    for(size_t offset=0;offset<1280;++offset){
      uint32_t expected=0;
      for(const auto &alias:aliases)if(offset>=alias.offset && offset-alias.offset<alias.size){
        const uint32_t value=alias.base+uint32_t(offset-alias.offset);
        if(!expected || value<expected)expected=value;
      }
      assert(memory.addressOf(bytes.data()+offset)==expected);
    }
  };
  verify();
  for(size_t i=0;i<aliases.size();i+=3){memory.unmap(aliases[i].base);aliases[i].size=0;}
  verify();
  for(const auto &alias:aliases)memory.unmap(alias.base);
  assert(memory.addressOf(bytes.data())==0);
  std::cout<<"PASS indexed ARM32 mapping identity, aliases, exact bounds, protection, split/replacement and retirement\n";
}
void compact(){
  Memory memory;
  // Leave only 64 KiB of guest address space above the borrowed-buffer base.
  // The large untouched mapping reserves virtual addresses, not physical RAM.
  memory.map(0x50010000,0xaffe0000,rw);
  memory.map(0xffff1000,0xf000,rw);
  alignas(4096) std::array<uint8_t,4096*32> cells{};
  std::vector<uint32_t> bases;
  for(unsigned i=0;i<4096;i++){
    auto *native=cells.data()+i*32+16;*native=uint8_t(i);
    auto address=memory.borrow(native,1,rw);
    assert(address>=0x50000000 && address<0x50010000 && !(address%16));
    assert(*static_cast<uint8_t *>(memory.translate(address,1,Memory::Read))==uint8_t(i));
    faults([&]{memory.translate(address,2,Memory::Read);});
    bases.push_back(address);
  }
  std::set<uint32_t> released;
  for(unsigned i=0;i<4096;i+=2){released.insert(bases[i]);memory.unmap(bases[i]);}
  for(unsigned i=0;i<4096;i+=2){
    const auto address=memory.borrow(cells.data()+i*32+16,1,rw);
    assert(released.erase(address)==1);
    assert(memory.translate(address,1,rw)==cells.data()+i*32+16);
  }
  assert(released.empty());
  bool exhausted=false;
  try {memory.allocate(0x50000000,4096,rw);}
  catch(const std::runtime_error &error){
    const std::string detail=error.what();
    exhausted=detail.find("request=4096")!=std::string::npos&&detail.find("mappings=")!=std::string::npos;
  }
  assert(exhausted);
  // A page-range release can retire many compact buffers. Adjacent free
  // ranges coalesce so a larger page mapping can reuse that capacity.
  memory.unmap(0x50000000,8192);
  assert(memory.allocate(0x50000000,8192,rw)==0x50000000);
  std::cout<<"PASS compact borrowed buffers retain bounds, alignment and reuse in a bounded ARM32 address space\n";
}
void benchmark(){
  Memory memory;
  std::vector<uint8_t> bytes(8192*32);
  uint32_t last=0;
  auto allocations=std::chrono::steady_clock::now();
  for(size_t i=0;i<8192;++i)last=memory.borrow(bytes.data()+i*32,32,rw);
  constexpr size_t iterations=200000;
  uint64_t total=0;
  auto start=std::chrono::steady_clock::now();
  for(size_t i=0;i<iterations;++i)total+=memory.addressOf(bytes.data()+(i%8192)*32+7);
  const auto pointer=std::chrono::steady_clock::now();
  for(size_t i=0;i<iterations*10;++i)total+=*static_cast<uint8_t*>(memory.translate(last+7,1,Memory::Read));
  const auto end=std::chrono::steady_clock::now();
  std::cout<<"borrow_ns="<<std::chrono::duration_cast<std::chrono::nanoseconds>(start-allocations).count()/8192
    <<" addressOf_ns="<<std::chrono::duration_cast<std::chrono::nanoseconds>(pointer-start).count()/iterations
    <<" translate_ns="<<std::chrono::duration_cast<std::chrono::nanoseconds>(end-pointer).count()/(iterations*10)<<" checksum="<<total<<"\n";
}
void fragmented(){
  Memory memory;
  constexpr unsigned count=32768;
  auto *bytes=static_cast<uint8_t *>(mmap(nullptr,size_t(count)*4096,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0));
  assert(bytes!=MAP_FAILED);
  std::vector<uint32_t> bases;
  const auto start=std::chrono::steady_clock::now();
  for(unsigned i=0;i<count;++i){
    const auto address=memory.borrow(bytes+size_t(i)*4096,1,rw);
    assert(!(address%4096));
    assert(memory.translate(address,1,rw)==bytes+size_t(i)*4096);
    faults([&]{memory.translate(address,2,Memory::Read);});
    bases.push_back(address);
  }
  for(unsigned i=0;i<count;i+=2)memory.unmap(bases[i]);
  for(unsigned i=0;i<count;i+=2){
    const auto address=memory.borrow(bytes+size_t(i)*4096,1,rw);
    assert(!(address%4096));
    assert(memory.translate(address,1,rw)==bytes+size_t(i)*4096);
    bases[i]=address;
  }
  for(auto address:bases)memory.unmap(address);
  const auto reused=memory.allocate(0x50000000,4096,rw);
  assert(reused>=0x50000000&&!(reused%4096));
  assert(memory.translate(reused,4096,rw)!=nullptr);
  munmap(bytes,size_t(count)*4096);
  std::cout<<"PASS fragmented borrowed ranges retain native identity, alignment, bounds and reuse; elapsed_ms="
    <<std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count()<<"\n";
}
void concurrent(){
  Memory memory;
  const auto code=memory.allocate(0x30000000,4096,rw|Memory::Execute);
  const uint32_t instructions[]={0xe5900000,0xe12fff1e,
    0xe1902f9f,0xe2822001,0xe1803f92,0xe3530000,0x1afffffa,0xe1a00002,0xe12fff1e};
  std::memcpy(memory.translate(code,sizeof instructions,Memory::Write),instructions,sizeof instructions);
  memory.protect(code,4096,Memory::Read|Memory::Execute);
  uint32_t value=0x12345678;
  const auto address=memory.borrow(&value,sizeof value,Memory::Read);
  uint32_t counter=0;const auto counterAddress=memory.borrow(&counter,sizeof counter,rw);
  std::latch start(5);
  std::vector<std::thread> readers;
  for(unsigned n=0;n<4;++n)readers.emplace_back([&]{
    Thread thread(memory);start.arrive_and_wait();
    const std::array args={Value::word(address)};
    const std::array increment={Value::word(counterAddress)};
    for(unsigned i=0;i<2000;++i){
      assert(uint32_t(thread.call(code,args))==value);thread.call(code+8,increment);
    }
  });
  start.arrive_and_wait();
  for(unsigned i=0;i<2000;++i){
    uint32_t temporary=i;const auto alias=memory.borrow(&temporary,sizeof temporary,rw);
    assert(memory.addressOf(&temporary)==alias);memory.unmap(alias);
  }
  for(auto &reader:readers)reader.join();
  assert(counter==8000);
  std::array<uint8_t,8> unaligned{};
  const auto unalignedAddress=memory.borrow(unaligned.data()+1,4,rw);
  {Thread thread(memory);const std::array args={Value::word(unalignedAddress)};
   for(unsigned i=1;i<=32;++i)assert(uint32_t(thread.call(code+8,args))==i);}
  uint32_t result;std::memcpy(&result,unaligned.data()+1,4);assert(result==32);
  memory.unmap(address);memory.unmap(counterAddress);memory.unmap(unalignedAddress);memory.unmap(code);
  std::cout<<"PASS concurrent original ARM32 readonly loads retain bounds during mapping churn\n";
}
void budgets(){
  Memory memory;Thread thread(memory);
  const auto code=memory.allocate(0x30000000,4096,rw|Memory::Execute);
  // Original A32 decrement/branch loop, then return the requested value.
  const uint32_t instructions[]={0xe2511001,0x1afffffd,0xe12fff1e};
  std::memcpy(memory.translate(code,sizeof instructions,Memory::Write),instructions,sizeof instructions);
  memory.protect(code,4096,Memory::Read|Memory::Execute);
  const std::array args={Value::word(47),Value::word(10000)};
  for(uint64_t budget:{uint64_t(0),uint64_t(100)}){
    bool exhausted=false;
    try{thread.call(code,args,budget);}
    catch(const std::runtime_error &error){exhausted=std::string_view(error.what())=="ARM32 instruction budget exhausted";}
    assert(exhausted);
  }
  for(uint64_t budget:{uint64_t(100000),uint64_t(INT64_MAX),uint64_t(INT64_MAX)+1,UINT64_MAX})
    assert(uint32_t(thread.call(code,args,budget))==47);
  assert(uint32_t(thread.call(code,args))==47);
  std::cout<<"PASS original ARM32 finite and unsigned instruction budgets preserve exhaustion and later calls\n";
}
}
int main(int argc,char **argv){if(argc>1 && std::string_view(argv[1])=="compact")compact();else if(argc>1 && std::string_view(argv[1])=="fragmented")fragmented();else if(argc>1 && std::string_view(argv[1])=="concurrent")concurrent();else if(argc>1 && std::string_view(argv[1])=="budgets")budgets();else if(argc>1)benchmark();else semantics();}
