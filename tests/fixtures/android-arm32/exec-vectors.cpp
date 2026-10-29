#include "native-imports.h"
#include <array>
#include <cassert>
#include <cerrno>
#include <cstring>
#include <iostream>
using namespace maclauncher::arm32;
static unsigned calls;
extern "C" int kl_errno_to_linux(int value){assert(value==ENOENT||value==EFAULT);return value==ENOENT?2:14;}
static int execute(const char *path,char *const *arguments,char *const *environment){
    assert(path);assert(arguments);assert(environment);
    ++calls;assert(!std::strcmp(path,"/system/bin/original"));
    if(calls==1||calls==3){
        assert(!std::strcmp(arguments[0],"arbitrary argv zero")&&!std::strcmp(arguments[1],"argument:日本語")&&!arguments[2]);
        assert(!std::strcmp(environment[0],"RAW=one=two")&&!environment[1]);
    }else if(calls==4){assert(!arguments[0]&&!std::strcmp(environment[0],"RAW=one=two")&&!environment[1]);}
    else assert(!arguments[0]&&!environment[0]);
    errno=ENOENT;return -1;
}
static void *lookup(const char *name){return !std::strcmp(name,"execve")?reinterpret_cast<void*>(&execute):nullptr;}
int main(int argc,char **argv){
    assert(argc==2);uint32_t number=static_cast<uint32_t>(std::stoul(argv[1]));
    Memory memory;Imports imports(memory,lookup);Thread thread(memory);
    thread.setSyscall([&](Thread &caller,uint32_t syscall){return imports.syscall(caller,syscall);});
    uint32_t code=memory.allocate(0x10000000,4096,Memory::Read|Memory::Write|Memory::Execute);
    const uint32_t instructions[]={0xe1a07000,0xe1a00001,0xe1a01002,0xe1a02003,0xef000000,0xe12fff1e};
    std::memcpy(memory.translate(code,sizeof instructions,Memory::Write),instructions,sizeof instructions);
    uint32_t data=memory.allocate(0x20000000,4096,Memory::Read|Memory::Write);
    auto text=[&](uint32_t offset,const char *value){std::memcpy(memory.translate(data+offset,std::strlen(value)+1,Memory::Write),value,std::strlen(value)+1);return data+offset;};
    uint32_t path=text(128,"/system/bin/original"),first=text(192,"arbitrary argv zero"),second=text(256,"argument:日本語"),env=text(320,"RAW=one=two");
    uint32_t vectors[]={first,second,0,env,0};std::memcpy(memory.translate(data,sizeof vectors,Memory::Write),vectors,sizeof vectors);
    auto invoke=[&](uint32_t filename,uint32_t arguments,uint32_t environment){
        std::array<Value,4> values={Value::word(number),Value::word(filename),Value::word(arguments),Value::word(environment)};
        return static_cast<int32_t>(thread.call(code,values));
    };
    assert(invoke(path,data,data+12)==-2&&calls==1);
    assert(invoke(path,0,0)==-2&&calls==2);
    assert(invoke(path,0x10,0)==-14&&calls==2);
    vectors[0]=0x10;std::memcpy(memory.translate(data,4,Memory::Write),vectors,4);
    assert(invoke(path,data,0)==-14&&calls==2);
    assert(invoke(0,0,0)==-14&&calls==2);
    assert(invoke(0x10,0,0)==-14&&calls==2);
    vectors[0]=first;std::memcpy(memory.translate(data,4,Memory::Write),vectors,4);
    const uint32_t invalidEnvironment[]={0x10,0};std::memcpy(memory.translate(data+64,sizeof invalidEnvironment,Memory::Write),invalidEnvironment,sizeof invalidEnvironment);
    assert(invoke(path,data,data+64)==-14&&calls==2);
    // A readable first byte is insufficient for an input C string. Its NUL
    // and every pointer-array cell must be readable before ownership crosses.
    uint32_t guarded=memory.allocate(0x30000000,8192,Memory::Read|Memory::Write);
    *static_cast<char *>(memory.translate(guarded+4095,1,Memory::Write))='x';memory.protect(guarded+4096,4096,0);
    vectors[0]=guarded+4095;std::memcpy(memory.translate(data,4,Memory::Write),vectors,4);
    assert(invoke(path,data,0)==-14&&calls==2);
    assert(invoke(guarded+4095,0,0)==-14&&calls==2);
    std::memcpy(memory.translate(guarded+4092,4,Memory::Write),&first,4);
    assert(invoke(path,guarded+4092,0)==-14&&calls==2);
    assert(invoke(path,UINT32_MAX-1,0)==-14&&calls==2);
    memory.map(0xfffff000,4096,Memory::Read|Memory::Write);
    *static_cast<char *>(memory.translate(UINT32_MAX,1,Memory::Write))='x';
    assert(invoke(UINT32_MAX,0,0)==-14&&calls==2);
    vectors[0]=UINT32_MAX;std::memcpy(memory.translate(data,4,Memory::Write),vectors,4);
    assert(invoke(path,data,0)==-14&&calls==2);
    // Adjacent guest mappings need not be contiguous native allocations.
    memory.map(0x31000000,4096,Memory::Read|Memory::Write);memory.map(0x31001000,4096,Memory::Read|Memory::Write);
    const char split[]="arbitrary argv zero";uint32_t splitAddress=0x31001000-7;
    std::memcpy(memory.translate(splitAddress,7,Memory::Write),split,7);
    std::memcpy(memory.translate(0x31001000,sizeof split-7,Memory::Write),split+7,sizeof split-7);
    vectors[0]=splitAddress;std::memcpy(memory.translate(data,4,Memory::Write),vectors,4);
    assert(invoke(path,data,data+12)==-2&&calls==3);
    assert(invoke(path,0,data+12)==-2&&calls==4);
    std::cout<<"PASS original ARM32 exec vectors retain guest strings and fault before native ownership\n";
}
