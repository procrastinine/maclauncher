#include "native-imports.h"
#include "bitset-shapes.h"
#include <algorithm>
#include <array>
#include <cassert>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <dlfcn.h>
#include <fcntl.h>
#include <iostream>
#include <sys/resource.h>
#include <unistd.h>
#include <vector>
using namespace maclauncher::arm32;
static constexpr unsigned guard=16;
struct Buffer {
  std::vector<unsigned char> bytes;
  unsigned size;
  explicit Buffer(unsigned size):bytes(size+2*guard,0xa7),size(size){std::fill(bytes.begin()+guard,bytes.end()-guard,0);}
  unsigned char *data(){return bytes.data()+guard;}
  void bit(unsigned index){assert(index<size*8);data()[index/8]|=uint8_t(1u<<(index%8));}
  void valid()const{for(unsigned i=0;i<guard;i++)assert(bytes[i]==0xa7&&bytes[bytes.size()-1-i]==0xa7);}
};
int main(int argc,char **argv){
  assert(argc==2);auto library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){std::cerr<<dlerror()<<'\n';return 1;}
  auto lookup=reinterpret_cast<void *(*)(const char *)>(dlsym(library,"kl_shim_lookup"));assert(lookup);
  auto selectNative=reinterpret_cast<int(*)(int,void *,void *,void *,void *)>(lookup("select"));assert(selectNative);
  rlimit limit{};assert(getrlimit(RLIMIT_NOFILE,&limit)==0);if(limit.rlim_cur<1024){limit.rlim_cur=1024;assert(setrlimit(RLIMIT_NOFILE,&limit)==0);}
  int pipefd[2];assert(pipe(pipefd)==0);char byte='x';assert(write(pipefd[1],&byte,1)==1);
  Memory memory;Imports imports(memory,lookup);Thread thread(memory);auto gate=imports.resolve("select");assert(gate);
  for(unsigned bit:{31u,32u,63u,64u,127u,511u,1023u}){
    assert(bit<shapes::guestBytes*8);int fd=fcntl(pipefd[0],F_DUPFD,int(bit));assert(fd==int(bit));
    for(bool fail:{false,true}){
      std::array<Buffer,3> guest={Buffer(shapes::guestBytes),Buffer(shapes::guestBytes),Buffer(shapes::guestBytes)};
      std::array<Buffer,3> native={Buffer(shapes::hostBytes),Buffer(shapes::hostBytes),Buffer(shapes::hostBytes)};
      for(auto &set:guest)set.bit(bit);for(auto &set:native)set.bit(bit);
      Buffer guestTime(shapes::guestTime),nativeTime(shapes::hostTime);
      auto flags=Memory::Read|Memory::Write;
      std::array<uint32_t,3> pointers;for(unsigned i=0;i<3;i++)pointers[i]=memory.borrow(guest[i].data(),guest[i].size,flags);
      auto timeout=memory.borrow(guestTime.data(),guestTime.size,flags);int count=fail?-1:int(bit+1);errno=0;
      int expected=selectNative(count,native[0].data(),native[1].data(),native[2].data(),nativeTime.data());const int error=errno;errno=0;
      Value args[]={Value::word(uint32_t(count)),Value::word(pointers[0]),Value::word(pointers[1]),Value::word(pointers[2]),Value::word(timeout)};
      auto actual=int32_t(thread.call(gate,args));
      if(actual!=expected||errno!=error){std::cerr<<"select differs at bit "<<bit<<", fail="<<fail<<": "<<actual<<'/'<<errno<<" vs "<<expected<<'/'<<error<<'\n';return 1;}
      if(!fail&&expected<=0){std::cerr<<"Original select did not report the ready pipe at bit "<<bit<<": "<<expected<<'/'<<error<<'\n';return 1;}else if(fail)assert(expected==-1);
      for(unsigned i=0;i<3;i++){
        guest[i].valid();native[i].valid();
        if(std::memcmp(guest[i].data(),native[i].data(),shapes::guestBytes)){std::cerr<<"Packed bitmap differs at original bit "<<bit<<", set "<<i<<", fail="<<fail<<'\n';return 1;}
        bool beyond=false;try{memory.translate(pointers[i],shapes::guestBytes+1,Memory::Read);}catch(const Memory::Fault &){beyond=true;}assert(beyond);
        memory.unmap(pointers[i]);
      }
      guestTime.valid();nativeTime.valid();memory.unmap(timeout);
    }
    close(fd);
  }
  close(pipefd[0]);close(pipefd[1]);
  std::cout<<"PASS original packed fd_set select bits, exact spans, guards and errors\n";
}
