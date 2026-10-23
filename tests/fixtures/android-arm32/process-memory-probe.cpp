#include "native-imports.h"
#include "imports-shapes.h"
#include "process-memory-syscalls.h"
#include "../process-memory.h"
#include "../process-ids.h"
#include <array>
#include <cassert>
#include <cerrno>
#include <cstring>
#include <dlfcn.h>
#include <iostream>
#include <vector>
using namespace maclauncher::arm32;
static void *(*original)(const char *);
static ssize_t observed(pid_t pid,const iovec *local,unsigned long lc,const iovec *remote,unsigned long rc,unsigned long flags){
    assert(lc==2&&rc==2&&local[0].iov_len==3&&local[1].iov_len==5&&remote[0].iov_len==2&&remote[1].iov_len==6);
    return klj_process_vm_readv(pid,local,lc,remote,rc,flags);
}
static void *lookup(const char *name){
    if(!std::strcmp(name,"process_vm_readv"))return reinterpret_cast<void *>(observed);
    if(!std::strcmp(name,"process_vm_writev"))return reinterpret_cast<void *>(klj_process_vm_writev);
    if(!std::strcmp(name,"getpid"))return reinterpret_cast<void *>(klj_process_id);
    return original(name);
}
static void field(uint8_t *record,unsigned offset,uint32_t value){std::memcpy(record+offset,&value,4);}
int main(int argc,char **argv){
    assert(argc==3&&klj_process_ids_configure(argv[2])>0&&!klj_process_publish_principal(10023));
    auto library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);assert(library);original=reinterpret_cast<void *(*)(const char *)>(dlsym(library,"kl_shim_lookup"));assert(original);
    Memory memory;Imports imports(memory,lookup);Thread thread(memory);
    std::array<uint8_t,12> output;output.fill(0xa7);char input[]="abcdefgh";
    auto src=memory.borrow(input,8,Memory::Read|Memory::Write),dst=memory.borrow(output.data()+2,8,Memory::Read|Memory::Write);
    std::vector<uint8_t> local(shapes::vectorBytes*2),remote(shapes::vectorBytes*2);
    auto vector=[](std::vector<uint8_t>&storage,unsigned index,uint32_t address,uint32_t length){auto p=storage.data()+index*shapes::vectorBytes;field(p,shapes::vectorBase,address);field(p,shapes::vectorLength,length);};
    vector(local,0,dst,3);vector(local,1,dst+3,5);vector(remote,0,src,2);vector(remote,1,src+2,6);
    auto l=memory.borrow(local.data(),uint32_t(local.size()),Memory::Read),r=memory.borrow(remote.data(),uint32_t(remote.size()),Memory::Read);
    assert(memory.translate(src+2,6,Memory::Read)==input+2);assert(memory.translate(dst+3,5,Memory::Write)==output.data()+5);
    Value args[]={Value::word(uint32_t(klj_process_id())),Value::word(l),Value::word(2),Value::word(r),Value::word(2),Value::word(0)};
    auto read=imports.resolve("process_vm_readv"),write=imports.resolve("process_vm_writev");assert(read&&write);
    auto first=int32_t(thread.call(read,args));if(first!=8||std::memcmp(output.data()+2,"abcdefgh",8)){std::cerr<<"process_vm read="<<first<<" errno="<<errno<<" pid="<<klj_process_id()<<" bytes=";for(unsigned i=2;i<10;i++)std::cerr<<unsigned(output[i])<<',';std::cerr<<'\n';return 1;}
    std::memcpy(output.data()+2,"12345678",8);assert(int32_t(thread.call(write,args))==8&&!std::memcmp(input,"12345678",8));
    const uint32_t code[]={0xe92d40b0,0xe59d4010,0xe59d5014,0xe3007000|((syscalls::read&0xf000)<<4)|(syscalls::read&0xfff),0xef000000,0xe8bd80b0};
    auto raw=memory.allocate(0,sizeof code,Memory::Read|Memory::Write|Memory::Execute);std::memcpy(memory.translate(raw,sizeof code,Memory::Write),code,sizeof code);
    thread.setSyscall([&](Thread &t,uint32_t number){return imports.syscall(t,number);});
    std::memcpy(input,"raw-path",8);assert(int32_t(thread.call(raw,args))==8&&!std::memcmp(output.data()+2,"raw-path",8));
    vector(remote,1,1,6);errno=0;assert(int32_t(thread.call(read,args))==2);
    vector(remote,0,1,2);errno=0;assert(int32_t(thread.call(read,args))==-1&&errno==EFAULT);
    args[2]=Value::word(1025);errno=0;assert(int32_t(thread.call(read,args))==-1&&errno==EINVAL);
    assert(output[0]==0xa7&&output[1]==0xa7&&output[10]==0xa7&&output[11]==0xa7);
    std::cout<<"PASS original ARM32 process_vm iovec projections, read/write/raw SVC path, guards and partial faults\n";
}
