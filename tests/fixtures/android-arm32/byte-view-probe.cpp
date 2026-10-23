#include "native-imports.h"
#include "imports-shapes.h"
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <iostream>
#include <unistd.h>
#include <vector>
using namespace maclauncher::arm32;

int main(int argc,char **argv){
    assert(argc==2);
    void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){std::cerr<<dlerror()<<'\n';return 1;}
    auto lookup=reinterpret_cast<void *(*)(const char *)>(dlsym(library,"kl_shim_lookup"));assert(lookup);
    Memory memory;Imports imports(memory,lookup);Thread thread(memory);
    imports.setThreadFactory([&]{return std::make_shared<Thread>(memory);});
    auto invoke=[&](uint32_t gate,std::initializer_list<Value> args){assert(gate);return thread.call(gate,std::span(args.begin(),args.size()));};
    auto call=[&](const char *name,std::initializer_list<Value> args){return invoke(imports.resolve(name),args);};
    auto bytes=[&](uint32_t at,size_t length){return memory.translate(at,length,Memory::Read);};
    uint32_t output=0;auto slot=memory.borrow(&output,sizeof output,Memory::Read|Memory::Write);
    assert(call("slCreateEngine",{Value::word(slot),Value::word(0),Value::word(0),Value::word(0),Value::word(0),Value::word(0)})==0);
    auto object=output;uint32_t table=0;std::memcpy(&table,bytes(object,4),4);
    auto methods=static_cast<const uint32_t *>(bytes(table,shapes::objectBytes));
    uint32_t realize=methods[shapes::objectRealize/4],destroy=methods[shapes::objectDestroy/4];
    std::vector<uint32_t> originalMethods(methods,methods+shapes::objectBytes/4);
    auto compare=memory.allocate(0x30000000,4096,Memory::Read|Memory::Write|Memory::Execute);
    // The comparator reads both complete guest-width cells. Equality is valid
    // for every element, so the original const table remains unchanged.
    const uint32_t comparator[]={0xe5900000,0xe5911000,0xe3a00000,0xe12fff1e};
    std::memcpy(memory.translate(compare,sizeof comparator,Memory::Write),comparator,sizeof comparator);
    call("qsort",{Value::word(table),Value::word(shapes::objectBytes/4),Value::word(4),Value::word(compare)});
    assert(!std::memcmp(bytes(table,shapes::objectBytes),originalMethods.data(),shapes::objectBytes)&&"Byte algorithms use guest element widths and callbacks see the same guest values");
    auto found=uint32_t(call("bsearch",{Value::word(table),Value::word(table),Value::word(shapes::objectBytes/4),Value::word(4),Value::word(compare)}));
    assert(found>=table&&found<table+shapes::objectBytes&&(found-table)%4==0);
    uint32_t sortValues[]={2,1};
    auto sortInput=memory.borrow(sortValues,sizeof sortValues,Memory::Read|Memory::Write,"sort-input");
    const uint32_t failedComparator[]={0xe3a00000,0xe5902000,0xe12fff1e};
    std::memcpy(memory.translate(compare+64,sizeof failedComparator,Memory::Write),failedComparator,sizeof failedComparator);
    bool described=false;
    try{call("qsort",{Value::word(sortInput),Value::word(2),Value::word(4),Value::word(compare+64)});}
    catch(const std::runtime_error &failure){
      const std::string detail=failure.what();
      described=detail.find("address=0x00000000 bytes=4 permission=4")!=std::string::npos&&
        detail.find("callback=0x")!=std::string::npos&&detail.find("arg0(")!=std::string::npos&&
        detail.find("origin=sort-input")!=std::string::npos;
    }
    assert(described&&"Callback failure retains the first fault and original typed input provenance");
    std::memcpy(memory.translate(table,shapes::objectBytes,Memory::Write),originalMethods.data(),shapes::objectBytes);
    std::vector<unsigned char> copy(shapes::objectBytes+8,0xcc);auto target=memory.borrow(copy.data(),copy.size(),Memory::Read|Memory::Write);
    for(auto [address,length]:{std::pair(object,4u),std::pair(table,shapes::objectBytes)}){
        assert(call("memcpy",{Value::word(target),Value::word(address),Value::word(length)})==target);
        assert(!std::memcmp(copy.data(),bytes(address,length),length)&&"Byte copy must observe original guest representation, not native64 storage");
        assert(call("memcmp",{Value::word(address),Value::word(target),Value::word(length)})==0);
        assert(call("memmove",{Value::word(target+1),Value::word(address+1),Value::word(length-1)})==target+1);
        assert(!std::memcmp(copy.data()+1,bytes(address+1,length-1),length-1));
    }
    std::array<unsigned char,10> fill;fill.fill(0xcc);
    auto fillGuest=memory.borrow(fill.data()+1,8,Memory::Write);
    assert(call("memset",{Value::word(fillGuest),Value::word(0x15a),Value::word(8)})==fillGuest);
    assert(fill.front()==0xcc&&fill.back()==0xcc);
    for(unsigned i=1;i<9;i++)assert(fill[i]==0x5a&&"Memory fill requires only write permission and truncates the fill byte in the original libc");
    bool bounded=false;
    try{call("memset",{Value::word(fillGuest+7),Value::word(0),Value::word(2)});}
    catch(const Memory::Fault &failure){bounded=std::string(failure.what()).find("bytes=2 permission=2")!=std::string::npos;}
    assert(bounded&&fill[8]==0x5a&&fill.back()==0xcc&&"Validate the complete fill span before the native owner writes");
    // A real guest BLX must retain its caller and operands when the original
    // byte-span owner rejects an overread. The neighboring alignment padding
    // remains inaccessible and no partial destination write is permitted.
    const auto shortInput=memory.borrow(fill.data()+1,8,Memory::Read,"short-copy-input");
    const uint32_t rejectedCopy[]={0xe92d4000,0xe59fc008,0xe12fff3c,0xe8bd8000,0xe1a00000,imports.resolve("memcpy")};
    const auto rejectedCall=compare+128;
    std::memcpy(memory.translate(rejectedCall,sizeof rejectedCopy,Memory::Write),rejectedCopy,sizeof rejectedCopy);
    const auto before=copy;bool originalCall=false;
    try{invoke(rejectedCall,{Value::word(target),Value::word(shortInput),Value::word(12)});}
    catch(const Memory::Fault &failure){
      char expected[80];std::snprintf(expected,sizeof expected,"[lr=0x%08x r0=0x%08x r1=0x%08x r2=0x0000000c",rejectedCall+12,target,shortInput);
      const std::string detail=failure.what();
      originalCall=detail.find("ARM32 native call memcpy:")!=std::string::npos&&
        detail.find("bytes=12 permission=4")!=std::string::npos&&
        detail.find("origin=short-copy-input")!=std::string::npos&&detail.find(expected)!=std::string::npos;
    }
    assert(originalCall&&copy==before&&"Original caller, fault and exact read bounds survive native reporting");
    const auto empty=fillGuest+8;
    assert(call("memset",{Value::word(empty),Value::word(0),Value::word(0)})==empty);
    for(const auto *name:{"memcpy","memmove"})assert(call(name,{Value::word(empty),Value::word(empty),Value::word(0)})==empty);
    assert(call("memcmp",{Value::word(empty),Value::word(empty),Value::word(0)})==0);
    // Original pointer declaration is mutable; both the raw guest cell and
    // the native getopt owner must see writes through this same representation.
    auto option=reinterpret_cast<char **>(lookup("optarg"));assert(option);auto previous=*option;
    char first[]="first",second[]="second";*option=first;
    auto firstGuest=memory.borrow(first,sizeof first,Memory::Read|Memory::Write),secondGuest=memory.borrow(second,sizeof second,Memory::Read|Memory::Write);
    auto optionSlot=imports.resolve("optarg");assert(optionSlot);
    auto value=[&]{uint32_t result;std::memcpy(&result,bytes(optionSlot,4),4);return result;};
    assert(value()==firstGuest);
    // Native changes still invalidate the representation snapshot, while
    // unchanged owners keep their exact stable guest identity across calls.
    for(unsigned i=0;i<32;i++){call("getpid",{});assert(value()==firstGuest);}
    *option=second;call("getpid",{});assert(value()==secondGuest);
    *option=first;call("getpid",{});assert(value()==firstGuest);
    assert(call("memset",{Value::word(optionSlot),Value::word(0),Value::word(4)})==optionSlot);
    assert(value()==0&&*option==nullptr&&"Memory fill commits the guest pointer cell to its original native owner");
    std::memcpy(copy.data(),&secondGuest,4);
    assert(call("memmove",{Value::word(optionSlot),Value::word(target),Value::word(4)})==optionSlot);
    assert(value()==secondGuest&&*option==second);
    int pipes[2];assert(pipe(pipes)==0);
    assert(call("read",{Value::word(pipes[0]),Value::word(empty),Value::word(0)})==0);
    assert(call("write",{Value::word(pipes[1]),Value::word(empty),Value::word(0)})==0);
    assert(call("write",{Value::word(pipes[1]),Value::word(optionSlot),Value::word(4)})==4);
    uint32_t received=0;assert(read(pipes[0],&received,4)==4&&received==secondGuest);
    assert(write(pipes[1],&firstGuest,4)==4);
    assert(call("read",{Value::word(pipes[0]),Value::word(optionSlot),Value::word(4)})==4);
    assert(value()==firstGuest&&*option==first);
    std::vector<unsigned char> vector(shapes::vectorBytes);
    uint32_t length=4;std::memcpy(vector.data()+shapes::vectorBase,&optionSlot,4);std::memcpy(vector.data()+shapes::vectorLength,&length,4);
    auto vectorGuest=memory.borrow(vector.data(),vector.size(),Memory::Read|Memory::Write);
    assert(call("writev",{Value::word(pipes[1]),Value::word(vectorGuest),Value::word(1)})==4);
    assert(read(pipes[0],&received,4)==4&&received==firstGuest);
    assert(write(pipes[1],&secondGuest,4)==4);
    assert(call("readv",{Value::word(pipes[0]),Value::word(vectorGuest),Value::word(1)})==4);
    assert(value()==secondGuest&&*option==second);
    uint32_t ignored=13,zero=0;std::memcpy(vector.data()+shapes::vectorBase,&ignored,4);std::memcpy(vector.data()+shapes::vectorLength,&zero,4);
    assert(call("writev",{Value::word(pipes[1]),Value::word(vectorGuest),Value::word(1)})==0);
    close(pipes[0]);close(pipes[1]);*option=previous;
    // Reading raw bytes must not replace the original interface's native self.
    assert(invoke(realize,{Value::word(object),Value::word(0)})==0);
    invoke(destroy,{Value::word(object)});
    std::cout<<"PASS ARM32 byte views, aliases, vector IO and original typed interfaces\n";
}
