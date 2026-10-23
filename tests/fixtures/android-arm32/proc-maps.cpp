#include "arm32.h"
#include "../proc-maps.h"
#include <algorithm>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <memory>
#include <sys/mman.h>
#include <vector>
using namespace maclauncher::arm32;
int main(){
    Memory memory;constexpr uint32_t base=0x12000000;
    memory.map(base,12288,Memory::Read|Memory::Write);
    const auto previous=memory.mappings();
    const auto native=reinterpret_cast<uintptr_t>(memory.translate(base,1,Memory::Read));assert(native>UINT32_MAX);
    memory.protect(base+4096,4096,Memory::Read|Memory::Execute);
    auto mappings=memory.mappings();
    auto find=[&](uint64_t address){return std::find_if(mappings.begin(),mappings.end(),[&](const auto &row){return row.start<=address&&address<row.end;});};
    assert(find(base)->permission==(Memory::Read|Memory::Write));
    assert(find(base+4096)->permission==(Memory::Read|Memory::Execute));
    assert(find(base+4096)->start==base+4096&&find(base+4096)->end==base+8192);
    assert(std::find_if(previous.begin(),previous.end(),[&](const auto &row){return row.start==base&&row.end==base+12288&&row.permission==(Memory::Read|Memory::Write);})!=previous.end());
    char compact[17]={0};const auto borrowed=memory.borrow(compact,sizeof compact,Memory::Read);mappings=memory.mappings();
    assert(find(borrowed)->end==uint64_t(borrowed)+sizeof compact);
    auto bytes=std::shared_ptr<void>(mmap(nullptr,4096,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0),[](void *p){munmap(p,4096);});
    assert(bytes.get()!=MAP_FAILED);const auto shared=memory.mapNative(bytes.get(),4096,Memory::Read|Memory::Write,bytes,0x14000000,true,false,{},true);
    mappings=memory.mappings();assert(find(shared)->shared);
    memory.unmap(base+4096,4096);mappings=memory.mappings();assert(find(base+4096)==mappings.end());
    std::vector<KljProcMapRegion> rows;
    for(const auto &mapping:mappings){assert(mapping.start<UINT64_C(0x100000000)&&mapping.end<=UINT64_C(0x100000000));assert(native<mapping.start||native>=mapping.end);
      rows.push_back({mapping.start,mapping.end,0,0,0,((mapping.permission&Memory::Read)?1u:0u)|((mapping.permission&Memory::Write)?2u:0u)|((mapping.permission&Memory::Execute)?4u:0u),mapping.shared,nullptr});}
    FILE *file=tmpfile();assert(file&&klj_proc_maps_format(file,rows.data(),rows.size(),nullptr));rewind(file);char line[256];bool sawShared=false;
    while(fgets(line,sizeof line,file)){unsigned long long first=0,last=0;char mode[5];assert(sscanf(line,"%llx-%llx %4s",&first,&last,mode)==3);assert(last<=UINT64_C(0x100000000));if(first==shared){assert(!strcmp(mode,"rw-s"));sawShared=true;}}
    assert(sawShared);fclose(file);
    puts("PASS original ARM32 mapping snapshots, logical permissions, shared flags and native-address exclusion");
}
