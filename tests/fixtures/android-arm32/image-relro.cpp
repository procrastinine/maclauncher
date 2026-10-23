#include "arm32.h"
#include <cassert>
#include <cstring>
#include <fstream>
#include <iterator>
#include <vector>
#include <cstdio>
using namespace maclauncher::arm32;
static uint32_t word(Memory &memory,uint32_t at){uint32_t value;std::memcpy(&value,memory.translate(at,4,Memory::Read),4);return value;}
static bool writable(Memory &memory,uint32_t at){try{memory.translate(at,4,Memory::Write);return true;}catch(const Memory::Fault &){return false;}}
int main(int argc,char **argv) {
    assert(argc==2);std::ifstream input(argv[1],std::ios::binary);assert(input);
    std::vector<uint8_t> bytes{std::istreambuf_iterator<char>(input),{}};
    Memory memory;Thread thread(memory);unsigned callbacks=0;
    auto observe=thread.import([&](Thread &call)->uint64_t{
        ++callbacks;auto relocated=call.argument(0),value=call.argument(1);
        assert(word(memory,relocated)==value&&word(memory,value)==17);
        assert(!writable(memory,relocated)&&writable(memory,value));return 7;
    });
    Image image(memory,bytes,0x10000000);
    auto relocated=image.symbol("relocated"),value=image.symbol("writable_value"),result=image.symbol("constructor_result");
    assert(relocated&&value&&result&&writable(memory,relocated));
    image.relocate([&](std::string_view name){assert(name=="relro_observe");return observe;});
    assert(word(memory,relocated)==value&&word(memory,value)==17&&!callbacks);
    assert(!writable(memory,relocated));image.initialize(thread);
    assert(callbacks==1&&word(memory,value)==18&&word(memory,result)==7);
    bool denied=false;const Value argument=Value::word(relocated);
    try{thread.call(image.symbol("write_slot"),std::span(&argument,1));}
    catch(const std::runtime_error &failure){denied=std::string(failure.what()).find("memory protection fault")!=std::string::npos;}
    assert(denied&&word(memory,relocated)==value);
    assert(!writable(memory,relocated));*static_cast<uint32_t *>(memory.translate(value,4,Memory::Write))=19;
    assert(word(memory,value)==19);
    puts("PASS ELF32 relocation precedes read-only constructors, denied stores and writable neighbors");
}
