#include "flat-binary.h"
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <iostream>

using namespace maclauncher::arm32;
static uint64_t hostFpcr(){uint64_t value;asm volatile("mrs %0, fpcr":"=r"(value));return value;}
static void hostFpcr(uint64_t value){asm volatile("msr fpcr, %0"::"r"(value));}

int main(int argc,char **argv){
    assert(argc==2);
    const auto saved=hostFpcr();
    constexpr uint64_t hostMode=0x01000000;
    hostFpcr(hostMode);
    Memory memory;Thread thread(memory);FlatBinary image(memory,argv[1]);
    unsigned callbacks=0;
    image.gate(0,memory.import([&](Thread &){assert(hostFpcr()==hostMode);++callbacks;return 0;}));
    std::array<uint32_t,16> data{};
    const auto address=memory.borrow(data.data(),sizeof data,Memory::Read|Memory::Write);
    // Exact bit patterns cover quiet/signaling NaNs, signed zero, infinities,
    // overflow, subnormal inputs/results and halfway rounding in both signs.
    constexpr std::array<std::array<uint32_t,4>,16> cases={{
        {0x3f800000,0x40000000,0x40400000,0x40800000},
        {0x00000000,0x80000000,0x80000000,0x00000000},
        {0x7fc12345,0x3f800000,0x3f800000,0xbf800000},
        {0x7f812345,0x3f800000,0x3f800000,0xbf800000},
        {0xffc12345,0x7fc54321,0x3f800000,0x7f854321},
        {0x00000001,0x007fffff,0x3f800000,0x3f000000},
        {0x80000001,0x807fffff,0x3f800000,0x3f000000},
        {0x00800000,0x80800000,0x3f000000,0x3f000000},
        {0x7f7fffff,0xff7fffff,0x40000000,0x40000000},
        {0x7f800000,0xff800000,0x3f800000,0x3f800000},
        {0x7f800000,0x00000000,0x00000000,0x7f800000},
        {0x3f800000,0xbf800000,0x33800000,0xb3800000},
        {0xbf800000,0x3f800000,0xb3800000,0x33800000},
        {0x3f000001,0x3effffff,0x3f000001,0x3effffff},
        {0x00800001,0x00800001,0x3f000000,0xbf000000},
        {0x3f7fffff,0xbf7fffff,0x33800000,0xb3800000}
    }};
    std::vector<uint32_t> results;
    for(unsigned rounding=0;rounding<4;++rounding)for(unsigned flushNan=0;flushNan<4;++flushNan){
        const uint32_t mode=(rounding<<22)|(flushNan<<24)|0x08000010;
        for(unsigned index=0;index<cases.size();++index){
            data.fill(0);data[0]=mode;std::copy(cases[index].begin(),cases[index].end(),data.begin()+1);
            data[12]=(mode^0x00c00000)&~0x08000010u;
            const std::array arguments={Value::word(address)};
            thread.call(image.entry(ENTRY_fpcr_case),arguments);
            assert(hostFpcr()==hostMode);
            if(index==0){assert(data[5]==0x41300000&&data[6]==0x40800000&&data[7]==0x40c00000&&data[9]==0x40800000);}
            // The input cumulative status must survive NEON/scalar transitions.
            assert((data[8]&0x08000010)==0x08000010);
            assert((data[11]&0x08000010)==0x08000010);
            for(unsigned slot:{5u,6u,7u,8u,9u,10u,11u,13u,14u})results.push_back(data[slot]);
        }
    }
    assert(callbacks==cases.size()*16);
    data={0,0x3f800000,0x40000000,0x40400000,0x40800000};
    bool fault=false;
    try{const std::array arguments={Value::word(address),Value::word(0x12345000)};thread.call(image.entry(ENTRY_fpcr_fault),arguments);}
    catch(const std::runtime_error &){fault=true;}
    assert(fault&&hostFpcr()==hostMode);
    const uint32_t iterations=200000;
    const std::array warm={Value::word(address),Value::word(2)};
    thread.call(image.entry(ENTRY_fpcr_loop),warm);
    std::array<int64_t,3> durations{};
    for(auto &elapsed:durations){
        const std::array arguments={Value::word(address),Value::word(iterations)};
        const auto start=std::chrono::steady_clock::now();
        assert(uint32_t(thread.call(image.entry(ENTRY_fpcr_loop),arguments))==0);
        elapsed=std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now()-start).count();
        assert(hostFpcr()==hostMode&&data[6]==0x40800000&&data[7]==0x40c00000);
    }
    hostFpcr(saved);
    auto sorted=durations;std::sort(sorted.begin(),sorted.end());
    std::cout<<"PASS original ARM32 floating-point blocks preserve values, status and mode boundaries\n";
    std::cout<<"{\"cases\":"<<cases.size()*16<<",\"callbacks\":"<<callbacks<<",\"results\":[";
    for(unsigned n=0;n<results.size();++n)std::cout<<(n?",":"")<<results[n];
    std::cout<<"],\"iterations\":"<<iterations<<",\"medianNs\":"<<sorted[1]<<",\"samplesNs\":["<<durations[0]<<","<<durations[1]<<","<<durations[2]<<"]}\n";
}
