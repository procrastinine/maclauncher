#pragma once
#include "arm32.h"
#include "fixture-entries.h"
#include <cassert>
#include <cstring>
#include <fstream>
#include <iterator>

struct FlatBinary {
    maclauncher::arm32::Memory& memory;
    static constexpr uint32_t base=0x10000000;
    explicit FlatBinary(maclauncher::arm32::Memory& target,const char* path):memory(target){
        std::ifstream input(path,std::ios::binary);
        std::vector<uint8_t> bytes{std::istreambuf_iterator<char>(input),{}};assert(!bytes.empty());
        memory.map(base,(bytes.size()+4095)&~size_t(4095),maclauncher::arm32::Memory::Read|maclauncher::arm32::Memory::Write|maclauncher::arm32::Memory::Execute);
        std::memcpy(memory.loadAddress(base,bytes.size()),bytes.data(),bytes.size());
    }
    uint32_t entry(unsigned index){uint32_t value;std::memcpy(&value,memory.translate(base+4*index,4,maclauncher::arm32::Memory::Read),4);return value;}
    void gate(unsigned index,uint32_t address){
        if(!index)memory.map(0x21000000,4096,maclauncher::arm32::Memory::Read|maclauncher::arm32::Memory::Execute);
        const uint32_t jump[]={0xe51ff004,address}; // ldr pc,[pc,#-4]
        std::memcpy(memory.loadAddress(0x21000000+16*index,sizeof jump),jump,sizeof jump);
    }
};
