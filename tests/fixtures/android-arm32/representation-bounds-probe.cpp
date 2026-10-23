#include "native-imports.h"
#include "imports-shapes.h"
#include <cassert>
#include <cstring>
#include <dlfcn.h>
#include <iostream>
using namespace maclauncher::arm32;

static void exact(Memory &memory,uint32_t address,unsigned bytes){
    assert(address&&bytes);
    memory.translate(address,bytes,Memory::Read);
    bool beyond=false;
    try{memory.translate(address+bytes,1,Memory::Read);}catch(const Memory::Fault &){beyond=true;}
    assert(beyond&&"Converted representations must expose their exact guest extent");
}
int main(int argc,char **argv){
    assert(argc==2);
    void *native=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!native){std::cerr<<dlerror()<<'\n';return 1;}
    auto lookup=reinterpret_cast<void *(*)(const char *)>(dlsym(native,"kl_shim_lookup"));assert(lookup);
    Memory memory;uint32_t object=0,table=0;
    {
        Imports imports(memory,lookup);Thread thread(memory);
        imports.setThreadFactory([&]{return std::make_shared<Thread>(memory);});
        struct {uint32_t value,guard;} output{0,0x13579abc};
        uint32_t slot=memory.borrow(&output,sizeof output,Memory::Read|Memory::Write);
        auto gate=imports.resolve("slCreateEngine");assert(gate);
        std::array<Value,6> arguments{Value::word(slot),Value::word(0),Value::word(0),Value::word(0),Value::word(0),Value::word(0)};
        assert(thread.call(gate,arguments)==0&&output.guard==0x13579abc);
        object=output.value;
        // Both extents come from the actual ABI: an ARM32 pointer cell and the
        // original Clang-described interface record, not host allocation pages.
        exact(memory,object,sizeof(uint32_t));
        std::memcpy(&table,memory.translate(object,sizeof(uint32_t),Memory::Read),sizeof table);
        exact(memory,table,shapes::objectBytes);
        auto methods=static_cast<const uint32_t *>(memory.translate(table,shapes::objectBytes,Memory::Read));
        uint32_t realize=methods[shapes::objectRealize/4],destroy=methods[shapes::objectDestroy/4];
        std::array<Value,2> realizeArguments{Value::word(object),Value::word(0)};
        assert(thread.call(realize,realizeArguments)==0);
        std::array<Value,1> destroyArguments{Value::word(object)};thread.call(destroy,destroyArguments);
        memory.unmap(slot);
    }
    for(auto address:{object,table}){
        bool retired=false;
        try{memory.translate(address,1,Memory::Read);}catch(const Memory::Fault &){retired=true;}
        assert(retired&&"The representation owner retires every typed view");
    }
    std::cout<<"PASS exact original ARM32 pointer/table bounds and retirement\n";
}
