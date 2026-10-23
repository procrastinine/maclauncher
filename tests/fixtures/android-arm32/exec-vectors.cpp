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
    ++calls;assert(!std::strcmp(path,"/system/bin/original"));
    if(calls==1){
        assert(!std::strcmp(arguments[0],"arbitrary argv zero")&&!std::strcmp(arguments[1],"argument:日本語")&&!arguments[2]);
        assert(!std::strcmp(environment[0],"RAW=one=two")&&!environment[1]);
    }else assert(!arguments[0]&&!environment[0]);
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
    std::cout<<"PASS original ARM32 exec vectors retain guest strings and fault before native ownership\n";
}
