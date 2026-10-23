#include "arm32.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <time.h>
#include <vector>
using namespace maclauncher::arm32;
static std::vector<uint8_t> bytes(const char *file){std::ifstream input(file,std::ios::binary);assert(input);return {std::istreambuf_iterator<char>(input),{}};}
static double cpuMs(){timespec value{};assert(!clock_gettime(CLOCK_THREAD_CPUTIME_ID,&value));return value.tv_sec*1000.0+value.tv_nsec/1e6;}
static std::string name(unsigned index){char buffer[32];std::snprintf(buffer,sizeof buffer,"exported_%04u",index);return buffer;}
int main(int argc,char **argv){
    assert(argc==3);const auto library=bytes(argv[1]),dependent=bytes(argv[2]);Memory memory;const auto before=memory.mappings().size();uint64_t checksum=0;double lookup=0,relocation=0;
    {
        Image provider(memory,library,0x10000000,{});
        assert(provider.symbol("exported_alias")==provider.symbol("exported_0000"));
        assert(provider.symbol("weak_alias")==provider.symbol("exported_0000"));
        assert(provider.symbol("absolute_marker")==0x12345);
        assert(!provider.symbol("hidden_symbol"));
        const auto versioned=provider.symbol("versioned_api");assert(versioned==provider.symbol("version_one")||versioned==provider.symbol("version_two"));checksum+=versioned;
        const auto begin=cpuMs();
        for(unsigned round=0;round<2;round++)for(unsigned i=0;i<1024;i++){
            const auto key=name(i),extended=key+"extra";const auto address=provider.symbol(std::string_view(extended.data(),key.size()));assert(address);checksum+=address;
            assert(!provider.symbol(key+"_missing"));
        }
        lookup=cpuMs()-begin;
        const auto linking=cpuMs();
        for(unsigned round=0;round<4;round++){
            Image consumer(memory,dependent,0x20000000,[&](std::string_view key){return provider.symbol(key);});
            const auto pointers=consumer.symbol("import_pointers");assert(pointers);
            for(unsigned i=0;i<512;i++){uint32_t value;std::memcpy(&value,memory.loadAddress(pointers+4*i,4),4);assert(value==provider.symbol(name(i)));checksum+=value;}
            uint32_t weak;std::memcpy(&weak,memory.loadAddress(consumer.symbol("optional_pointer"),4),4);assert(!weak);
        }
        relocation=cpuMs()-linking;
    }
    assert(memory.mappings().size()==before);
    std::printf("{\"lookupCpuMs\":%.3f,\"relocationCpuMs\":%.3f,\"lookups\":4096,\"relocatedSymbols\":2048,\"checksum\":%llu}\n",lookup,relocation,(unsigned long long)checksum);
    std::puts("PASS original ELF hash layouts retain exported aliases, version-name selection, weak imports, exact names, real relocations and image retirement");
}
