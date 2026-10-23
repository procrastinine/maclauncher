#include "flat-binary.h"
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <string_view>

using namespace maclauncher::arm32;
int main(int argc,char **argv){
    assert(argc==2||argc==3);
    const bool benchmark=argc==3&&std::string_view(argv[2])=="benchmark";
    Memory memory;Thread thread(memory);FlatBinary image(memory,argv[1]);
    alignas(4096) std::array<uint32_t,32> a{},b{},c{},d{},replacement{};
    for(uint32_t i=0;i<a.size();++i){a[i]=i+1;b[i]=i*3+9;c[i]=i*7+13;replacement[i]=777+i;}
    constexpr unsigned rw=Memory::Read|Memory::Write;
    uint32_t largeValue=0x12345678;
    const auto largeAddress=memory.borrow(&largeValue,sizeof largeValue,Memory::Read);
    const std::array largeArgs={Value::word(largeAddress)};
    assert(uint32_t(thread.call(image.entry(ENTRY_compact_large),largeArgs))==uint32_t(largeValue*512));
    memory.unmap(largeAddress);
    auto widths=[&](uint32_t address,unsigned width,uint64_t value,bool writing){
        const std::array args={Value::word(address),Value::word(width),Value::wide(value),Value::word(writing)};
        return thread.call(image.entry(ENTRY_compact_widths),args);
    };
    auto fault=[&](auto action){bool failed=false;try{action();}catch(const std::runtime_error &){failed=true;}assert(failed);};
    // Compact cells may refer to unaligned native bytes. Each generated width
    // must retain exact logical bounds and the original permission behavior.
    std::array<uint8_t,40> narrow{};narrow.front()=0x51;narrow.back()=0x62;
    const auto narrowAddress=memory.borrow(narrow.data()+1,17,rw);
    for(unsigned width:{1u,2u,4u,8u}){
        const uint64_t value=0xfedcba9876543210ULL&(~uint64_t(0)>>(64-width*8));
        assert(widths(narrowAddress,width,value,true)==value);
        assert(widths(narrowAddress,width,0,false)==value);
        assert(narrow.front()==0x51&&narrow.back()==0x62);
        fault([&]{widths(narrowAddress+17,width,0,false);});
        fault([&]{widths(narrowAddress+17,width,value,true);});
        const auto readonly=memory.borrow(narrow.data()+1,17,Memory::Read);
        assert(widths(readonly,width,0,false)==value);
        fault([&]{widths(readonly,width,value,true);});
        memory.unmap(readonly);
    }
    fault([&]{widths(narrowAddress+16,2,0,false);});
    fault([&]{widths(narrowAddress+16,4,0,true);});
    const auto opaque=memory.borrow(narrow.data()+1,17,0);
    fault([&]{widths(opaque,1,0,false);});fault([&]{widths(opaque,1,0,true);});
    const auto writeonly=memory.borrow(narrow.data()+1,17,Memory::Write);
    assert(widths(writeonly,1,0x73,true)==0x73&&narrow[1]==0x73);
    fault([&]{widths(writeonly,1,0,false);});
    memory.unmap(writeonly);memory.unmap(opaque);memory.unmap(narrowAddress);
    // An odd native pointer cannot be confused with the tagged cell-table
    // form, including interior guest pages of a multi-page native span.
    std::vector<uint8_t> odd(12289);
    const auto oddAddress=memory.borrow(odd.data()+1,12288,rw);
    assert(widths(oddAddress+8192,4,0x87654321,true)==0x87654321);
    assert(widths(oddAddress+8192,4,0,false)==0x87654321);
    memory.unmap(oddAddress);
    // Odd native storage forces the bounded form on every guest page. Its
    // permission index and native byte offset must remain independent.
    const auto protectedAddress=memory.mapNative(odd.data()+1,12288,rw,{});
    memory.protect(protectedAddress+4096,4096,Memory::Read);
    memory.protect(protectedAddress+8192,4096,Memory::Write);
    odd[1+4096+20]=0x84;
    assert(widths(protectedAddress+4096+20,1,0,false)==0x84);
    fault([&]{widths(protectedAddress+4096+20,1,0x25,true);});
    assert(widths(protectedAddress+8192+20,4,0x76543210,true)==0x76543210);
    assert(odd[1+8192+20]==0x10&&odd[1+8192+23]==0x76);
    fault([&]{widths(protectedAddress+8192+20,4,0,false);});
    // Cross-page callbacks must retain their original per-page checks too.
    fault([&]{widths(protectedAddress+4096-4,8,0,true);});
    fault([&]{widths(protectedAddress+8192-4,8,0,false);});
    assert(widths(protectedAddress+20,4,0x12345678,true)==0x12345678);
    memory.unmap(protectedAddress);
    const auto aa=memory.borrow(a.data(),sizeof a,rw),bb=memory.borrow(b.data(),sizeof b,rw),
        cc=memory.borrow(c.data(),sizeof c,rw),dd=memory.borrow(d.data(),sizeof d,rw);
    // Many unrelated mappings match an application with native/JNI resources.
    // They are prepared outside the execution timing and retain exact bounds.
    std::vector<std::array<uint32_t,4>> noise(4096);
    for(auto &buffer:noise)memory.borrow(buffer.data(),sizeof buffer,rw);
    const uint32_t rounds=benchmark?20000:512;
    std::array arguments={Value::word(aa),Value::word(bb),Value::word(cc),Value::word(dd),Value::word(rounds)};
    uint32_t expected=0;
    for(uint32_t round=0;round<rounds;++round)
        for(uint32_t i=0;i<a.size();++i)expected+=(a[i]+b[i])+(c[i]^(round+i));
    // Warm only this import-free guest code before collecting the bounded loop.
    auto warm=arguments;warm[4]=Value::word(1);thread.call(image.entry(ENTRY_compact_loop),warm);
    std::array<int64_t,3> durations{};
    for(auto &elapsed:durations){
        const auto start=std::chrono::steady_clock::now();
        const auto result=uint32_t(thread.call(image.entry(ENTRY_compact_loop),arguments));
        elapsed=std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now()-start).count();
        assert(result==expected);
    }
    for(uint32_t i=0;i<a.size();++i)assert(d[i]==(a[i]+b[i])+(c[i]^((rounds-1)+i)));
    const auto first=a[0]+b[0]+c[0]+d[0];
    image.gate(0,memory.import([&](Thread &){
        // This callback runs after the mapping guard ends. Retirement and an
        // exact-address replacement must never leave a cached Region alive.
        memory.unmap(aa);
        assert(memory.borrow(replacement.data(),sizeof replacement/2,rw)==aa);
        return 0;
    }));
    const std::array transition={Value::word(aa),Value::word(bb),Value::word(cc),Value::word(dd)};
    assert(uint32_t(thread.call(image.entry(ENTRY_compact_transition),transition))==first+replacement[0]+b[0]+c[0]+d[0]);
    bool bounded=false;
    try{const std::array outside={Value::word(aa)};thread.call(image.entry(ENTRY_compact_bounds),outside);}
    catch(const std::runtime_error &error){const std::string_view message=error.what();bounded=message.find("ARM32 access crosses mapping")!=message.npos||message.find("Unmapped ARM32 address")!=message.npos;}
    assert(bounded);
    for(const unsigned count:{1u,4u,32u,128u}){
        std::vector<std::array<uint32_t,32>> buffers(count);
        std::vector<uint32_t> addresses;
        for(auto &buffer:buffers)addresses.push_back(memory.borrow(buffer.data(),sizeof buffer,rw));
        const auto table=memory.borrow(addresses.data(),uint32_t(addresses.size()*sizeof(uint32_t)),Memory::Read);
        const auto reset=[&]{for(unsigned index=0;index<count;++index)for(unsigned slot=0;slot<32;++slot)buffers[index][slot]=(index+1)*(slot+3);};
        reset();auto expectedBuffers=buffers;uint32_t checksum=0;
        const uint32_t manyRounds=benchmark?20000:128;
        for(uint32_t round=0;round<manyRounds;++round)for(unsigned index=0;index<count;++index){
            auto &value=expectedBuffers[index][round&31];value+=index+round+1;checksum+=value;
        }
        const std::array warmMany={Value::word(table),Value::word(count),Value::word(1)};
        thread.call(image.entry(ENTRY_compact_many),warmMany);
        const std::array many={Value::word(table),Value::word(count),Value::word(manyRounds)};
        std::array<int64_t,3> samples{};
        for(auto &elapsed:samples){
            reset();const auto began=std::chrono::steady_clock::now();
            assert(uint32_t(thread.call(image.entry(ENTRY_compact_many),many))==checksum);
            elapsed=std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now()-began).count();
            assert(buffers==expectedBuffers);
        }
        auto sortedMany=samples;std::sort(sortedMany.begin(),sortedMany.end());
        std::cout<<"{\"compactBuffers\":"<<count<<",\"rounds\":"<<manyRounds<<",\"medianNs\":"<<sortedMany[1]
            <<",\"checksum\":"<<checksum<<",\"samplesNs\":["<<samples[0]<<","<<samples[1]<<","<<samples[2]<<"]}\n";
        memory.unmap(table);for(auto address:addresses)memory.unmap(address);
    }
    auto sorted=durations;std::sort(sorted.begin(),sorted.end());
    std::cout<<"PASS actual ARM32 multi-buffer loop retains exact values, host-callback retirement and shortened bounds\n";
    std::cout<<"{\"rounds\":"<<rounds<<",\"iterations\":"<<uint64_t(rounds)*32
        <<",\"medianNs\":"<<sorted[1]<<",\"checksum\":"<<expected<<",\"samplesNs\":["
        <<durations[0]<<","<<durations[1]<<","<<durations[2]<<"]}\n";
}
