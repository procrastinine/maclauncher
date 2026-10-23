#include "arm32.h"
#include "native-imports.h"
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <string>
#include <unistd.h>
using namespace maclauncher::arm32;
static std::string readMaps(int descriptor){
    assert(descriptor>=0);std::string result;char block[4096];ssize_t count;
    while((count=read(descriptor,block,sizeof block))>0)result.append(block,size_t(count));assert(count==0);
    assert(result.find("12000000-12003000 rw-p")!=std::string::npos);
    for(const char *line=result.c_str();*line;){unsigned long long begin=0,end=0;assert(sscanf(line,"%llx-%llx",&begin,&end)==2);assert(begin<end&&end<=UINT64_C(0x100000000));line=strchr(line,'\n');assert(line);line++;}
    return result;
}
int main(int argc,char **argv){
    assert(argc==2);void *runtime=dlopen(argv[1],RTLD_NOW|RTLD_GLOBAL);assert(runtime);
    auto lookup=reinterpret_cast<void *(*)(const char *)>(dlsym(runtime,"kl_shim_lookup"));assert(lookup);
    Memory memory;Imports imports(memory,lookup);Thread thread(memory);
    memory.map(0x12000000,12288,Memory::Read|Memory::Write);
    const char name[]="/proc/self/maps",mode[]="r";
    auto path=memory.borrow(const_cast<char *>(name),sizeof name,Memory::Read);
    auto readMode=memory.borrow(const_cast<char *>(mode),sizeof mode,Memory::Read);
    const auto open=imports.resolve("open");assert(open);
    const std::array arguments={Value::word(path),Value::word(0),Value::word(0)};
    int descriptor=int(uint32_t(thread.call(open,arguments)));readMaps(descriptor);close(descriptor);
    auto fopen=imports.resolve("fopen"),fclose=imports.resolve("fclose");assert(fopen&&fclose);
    const std::array streamArguments={Value::word(path),Value::word(readMode)};
    const auto stream=uint32_t(thread.call(fopen,streamArguments));assert(stream);
    auto *file=static_cast<FILE *>(memory.translate(stream,1,Memory::Read));readMaps(fileno(file));
    const std::array closeArguments={Value::word(stream)};assert(thread.call(fclose,closeArguments)==0);
    constexpr uint32_t code=0x15000000;memory.map(code,4096,Memory::Read|Memory::Execute);
    const uint32_t words[]={0xe92d4080,0xe3007142,0xef000000,0xe8bd8080}; // openat SVC322; preserve r7/lr.
    std::memcpy(memory.loadAddress(code,sizeof words),words,sizeof words);
    thread.setSyscall([&](Thread &current,uint32_t number){return imports.syscall(current,number);});
    const std::array syscallArguments={Value::word(uint32_t(-100)),Value::word(path),Value::word(0),Value::word(0)};
    descriptor=int(uint32_t(thread.call(code,syscallArguments)));readMaps(descriptor);close(descriptor);
    puts("PASS shared ARM32 open, fopen and original openat syscall expose only logical maps");
}
