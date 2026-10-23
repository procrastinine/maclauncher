#include "native-imports.h"
#include "stat-shapes.h"
#include <algorithm>
#include <cassert>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <dlfcn.h>
#include <fcntl.h>
#include <iostream>
#include <string>
#include <vector>
#include <unistd.h>
using namespace maclauncher::arm32;
static void *(*lookup)(const char *);
static uint64_t bits(const unsigned char *bytes,unsigned size){uint64_t value=0;std::memcpy(&value,bytes,size);return value;}
static uint64_t mask(unsigned size){return size==8?UINT64_MAX:(UINT64_C(1)<<(size*8))-1;}

int main(int argc,char **argv){
  assert(argc==3);auto library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){std::cerr<<dlerror()<<'\n';return 1;}
  lookup=reinterpret_cast<void *(*)(const char *)>(dlsym(library,"kl_shim_lookup"));assert(lookup);
  std::string root=argv[2],file=root+"/record.bin",link=root+"/record.link",missing=root+"/missing",relative="record.bin";
  int fd=open(file.c_str(),O_CREAT|O_RDWR|O_TRUNC,0600);assert(fd>=0);const char payload[]="original native filesystem metadata";assert(write(fd,payload,sizeof payload)==ssize_t(sizeof payload));
  assert(symlink("record.bin",link.c_str())==0);int dir=open(root.c_str(),O_RDONLY);assert(dir>=0);
  Memory memory;Imports imports(memory,lookup);Thread thread(memory);
  unsigned exercised=0,missingOwners=0;
  for(const auto &function:stat_shapes::functions){
    auto native=lookup(function.name);
    if(!native){std::cerr<<"Missing original shared native supplier: "<<function.name<<'\n';++missingOwners;continue;}
    auto gate=imports.resolve(function.name);assert(gate);++exercised;
    for(bool fail:{false,true}){
      std::string name=fail?(function.kind==3?"missing":missing):(function.kind==1?link:function.kind==3?relative:file);
      auto guestName=memory.borrow(name.data(),uint32_t(name.size()+1),Memory::Read);
      constexpr unsigned guard=16;std::vector<unsigned char> guest(function.guestSize+2*guard,0xa7),host(function.hostSize+2*guard,0xa7);
      std::fill(guest.begin()+guard,guest.end()-guard,0x6d);std::fill(host.begin()+guard,host.end()-guard,0x6d);
      auto output=memory.borrow(guest.data()+guard,function.guestSize,Memory::Read|Memory::Write);
      auto hostOutput=host.data()+guard;const int selected=fail?-1:fd;errno=0;int expected;
      if(function.kind==2)expected=reinterpret_cast<int(*)(int,void *)>(native)(selected,hostOutput);
      else if(function.kind==3)expected=reinterpret_cast<int(*)(int,const char *,void *,int)>(native)(dir,name.c_str(),hostOutput,0);
      else expected=reinterpret_cast<int(*)(const char *,void *)>(native)(name.c_str(),hostOutput);
      const int nativeError=errno;errno=0;uint64_t actual;
      if(function.kind==2){Value args[]={Value::word(uint32_t(selected)),Value::word(output)};actual=thread.call(gate,args);}
      else if(function.kind==3){Value args[]={Value::word(uint32_t(dir)),Value::word(guestName),Value::word(output),Value::word(0)};actual=thread.call(gate,args);}
      else {Value args[]={Value::word(guestName),Value::word(output)};actual=thread.call(gate,args);}
      assert(int32_t(actual)==expected);if(fail)assert(errno==nativeError&&expected==-1);else assert(expected==0);
      for(unsigned i=0;i<guard;i++)if(guest[i]!=0xa7||guest[guest.size()-1-i]!=0xa7||host[i]!=0xa7||host[host.size()-1-i]!=0xa7){
        std::cerr<<function.name<<" output guard changed, failure="<<fail<<", guard index="<<i<<", guest="<<unsigned(guest[i])<<'/'<<unsigned(guest[guest.size()-1-i])<<", native="<<unsigned(host[i])<<'/'<<unsigned(host[host.size()-1-i])<<'\n';return 1;
      }
      for(unsigned i=0;i<function.count;i++){
        const auto &field=function.fields[i];const auto *value=guest.data()+guard+field.guestOffset;
        if(field.padding){if(!fail)for(unsigned n=0;n<field.guestSize;n++)assert(value[n]==0);continue;}
        auto nativeValue=bits(hostOutput+field.hostOffset,field.hostSize)&mask(field.guestSize);
        if(bits(value,field.guestSize)!=nativeValue){std::cerr<<function.name<<" field "<<field.name<<" mismatch, failure="<<fail<<'\n';return 1;}
      }
      // The borrowed output exposes the original declaration's exact extent.
      bool beyond=false;try{memory.translate(output+function.guestSize,1,Memory::Read);}catch(const Memory::Fault &){beyond=true;}assert(beyond);
      memory.unmap(output);memory.unmap(guestName);
    }
    std::cout<<"PASS original "<<function.name<<" fields, guards and failure semantics"<<std::endl;
  }
  close(dir);close(fd);unlink(link.c_str());unlink(file.c_str());
  if(missingOwners){std::cerr<<"Validated "<<exercised<<" original variants; "<<missingOwners<<" shared native suppliers remain absent\n";return 1;}
  std::cout<<"PASS all original ARM32 stat variants, fields, inode aliases, guards and failure semantics\n";
}
