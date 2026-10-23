#include "precise.h"
#include <array>
#include <cassert>
#include <cstdio>
#include <cstring>

struct Owner {
    static constexpr uint64_t base=0x10000000;
    alignas(16384) std::array<uint32_t,4096> code{};
    unsigned maps=0;
};
static int map(void *opaque,uint64_t address,size_t length,unsigned access,KlA64Mapping *result){
    auto &owner=*(Owner*)opaque;
    if(address<Owner::base||address-Owner::base>=sizeof owner.code||length>sizeof owner.code-(address-Owner::base)||(access&~5))return -14;
    ++owner.maps;*result={Owner::base,sizeof owner.code,owner.code.data(),5,KL_A64_MAPPING_EXECUTION_OWNER};return 0;
}
static int revalidate(void *opaque,uint64_t address,size_t length,KlA64Mapping *result){return map(opaque,address,length,4,result);}
static KlA64State state(){
    KlA64State result{};result.pc=Owner::base;result.sp=0x20000000;result.pstate=0xa0000000;
    result.tpidr_el0=0x12345678;result.tpidrro_el0=0x87654321;result.fpcr=0x800000;result.fpsr=0x10;
    for(unsigned i=0;i<31;++i)result.x[i]=0xfedc0000+i;
    for(unsigned i=0;i<32;++i){result.v[i][0]=0x12340000+i;result.v[i][1]=0xabc00000+i;}
    result.x[3]=Owner::base+256;return result;
}
int main(int argc,char **argv){
    const bool baseline=argc==2&&!strcmp(argv[1],"--baseline");
    Owner owner;KlA64PreciseConfig config{};config.owner=&owner;config.map=map;
    config.ctr_el0=0x8444c004;config.cntfrq_el0=1000000000;config.dczid_el0=4;
    auto *cpu=kl_a64_precise_create(config);assert(cpu);
    // Exact recorded instruction plus the other original EL0 cache operations.
    const uint32_t user[]={0xd50b7b23,0xd50b7523,0xd50b7a23,0xd50b7e23,0xd5033b9f,0xd5033fdf};
    for(uint32_t instruction:user){
        owner.code[0]=instruction;owner.code[1]=0xd503201f;
        auto current=state(),before=current;auto result=kl_a64_precise_step(cpu,&current,1);
        if(baseline){
            assert(instruction==0xd50b7b23&&result.kind==KL_A64_EXCEPTION&&current.pc==Owner::base);
            printf("PASS baseline exact DC CVAU raises exception=%u at original PC\n",result.detail);
            kl_a64_precise_destroy(cpu);return 0;
        }
        assert(result.kind==KL_A64_BUDGET&&current.pc==Owner::base+4);
        before.pc=current.pc;assert(!memcmp(&current,&before,sizeof current));
    }
    puts("PASS original EL0 cache maintenance and barriers preserve architectural state");
    // Enabling EL0 UCI must leave privileged whole-cache maintenance forbidden.
    for(uint32_t instruction:{0xd508751fU,0xd5087623U}){
        owner.code[0]=instruction;auto current=state();auto result=kl_a64_precise_step(cpu,&current,2);
        assert(result.kind==KL_A64_EXCEPTION&&current.pc==Owner::base);
    }
    puts("PASS privileged cache operations remain undefined at EL0");
    assert(!kl_a64_precise_set_owned_cache(cpu,revalidate));
    owner.code[0]=0xd50b7b23;owner.code[1]=0xd5033b9f;owner.code[2]=0xd50b7523;
    owner.code[3]=0xd5033fdf;owner.code[4]=0xd28000e0;owner.code[5]=0xd503201f;
    auto current=state();auto result=kl_a64_precise_run_owned(cpu,&current,3,Owner::base,Owner::base+sizeof owner.code,5);
    assert(result.kind==KL_A64_BUDGET&&current.pc==Owner::base+20&&current.x[0]==7);
    const auto before=kl_a64_precise_counters(cpu);
    owner.code[4]=0xd2800160;current=state();
    result=kl_a64_precise_run_owned(cpu,&current,4,Owner::base,Owner::base+sizeof owner.code,5);
    const auto after=kl_a64_precise_counters(cpu);
    assert(result.kind==KL_A64_BUDGET&&current.pc==Owner::base+20&&current.x[0]==11);
    assert(after.revalidated>before.revalidated&&after.source_changed==before.source_changed+1);
    puts("PASS owned source changes revalidate across the original cache-maintenance sequence");
    kl_a64_precise_destroy(cpu);
}
