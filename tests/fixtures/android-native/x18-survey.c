#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include KL_X18_SOURCE

static uint32_t randomWord(uint32_t *state){*state^=*state<<13;*state^=*state>>17;*state^=*state<<5;return *state;}
int main(void){
    klx_info branch;
    const uint32_t reserved_gp[]={0xcbead646u,0xe9114bc4u,0x1221fb52u,
        0x6a48e243u,0x2ab2d672u,0x3a169a52u,0x6a89b7d2u,
        0xe88ebe52u,0x2b1ed8f2u,0x0af8be42u,0x333088b2u,
        0x1b95dedbu,0x5bda50c8u,0x1bad6207u,0x3b0df255u,
        0xda759ee7u,0xfbc90cbcu,0x7b7b462bu,0x3a6635d0u};
    for(unsigned i=0;i<sizeof reserved_gp/sizeof *reserved_gp;i++){
        klx_decode(reserved_gp[i],&branch);assert(!branch.ok&&!branch.nfields);
        assert(klx_unallocated(reserved_gp[i]));
    }
    // Both flag-only extensions remain allocated, with no GP destination.
    klx_decode(0xba00064fu,&branch);assert(branch.ok&&branch.nfields==1&&!branch.gp_written);
    klx_decode(0xba12040fu,&branch);assert(branch.ok&&!branch.nfields&&!branch.gp_written);
    klx_decode(0x3a000a4du,&branch);assert(branch.ok&&branch.nfields==1&&!branch.gp_written);
    // Fixed Rt2 bits in CAS/CASP and ordered loads/stores are not GP operands.
    // The first word is retained packed input, not an allocated A64 CAS.
    const uint32_t reserved_atomic[]={0x08b9c9fau,0xc8a24a60u,0xc89f4a60u,
        0xc8d24a60u,0x48224a60u,0x48237c60u,0x48227c61u};
    for(unsigned i=0;i<sizeof reserved_atomic/sizeof *reserved_atomic;i++){
        klx_decode(reserved_atomic[i],&branch);assert(!branch.ok&&!branch.nfields);
    }
    // Original A64 SIMD structures have GP base/post-index operands, but
    // reserved encodings in packed executable data must stay byte-identical.
    const uint32_t structures[]={0x4c407240u,0x4cdf7240u,0x4cd27000u,
        0x4c400240u,0x4d40c240u,0x4d401240u,0x4d405240u,0x4d408240u};
    for(unsigned i=0;i<sizeof structures/sizeof *structures;i++){
        klx_decode(structures[i],&branch);assert(branch.ok&&branch.nfields==1);
    }
    const uint32_t reserved[]={0x4cb2e3f7u,0x4c401240u,0x4c403240u,
        0x4c405240u,0x4c409240u,0x4c40b240u,0x4c40c240u,
        0x4c40d240u,0x4c40e240u,0x4c40f240u,0x4c607240u,
        0x4c527240u,0x0c400e40u,0x4d405640u,0x4d408a40u,
        0x4d409640u,0x4d00c240u,0x4d40d240u};
    for(unsigned i=0;i<sizeof reserved/sizeof *reserved;i++){
        klx_decode(reserved[i],&branch);assert(!branch.ok&&!branch.nfields);
    }
    for(unsigned reg=0;reg<31;reg++) {
        klx_decode(0xd61f0000u|(reg<<5),&branch);
        assert(branch.ok&&branch.nfields==(reg==18));
        klx_decode(0xd63f0000u|(reg<<5),&branch);
        assert(branch.ok&&branch.nfields==(reg==18));
        klx_decode(0xd65f0000u|(reg<<5),&branch);
        assert(branch.ok&&branch.nfields==(reg==18));
        klx_decode(0xd71f0800u|(reg<<5)|18,&branch);
        assert(branch.ok&&branch.nfields==1+(reg==18));
    }
    for(unsigned reg=0;reg<32;reg++) {
        klx_decode(0xd7838000u|(18<<5)|reg,&branch);assert(!branch.ok&&!branch.nfields);
        klx_decode(0xd67ace5cu,&branch);assert(!branch.ok&&!branch.nfields);
    }
    // A typed function start prevents a preceding literal/banner from voting
    // on its prologue. The unbounded API still classifies the same bytes as data.
    uint32_t boundaryWords[40];for(unsigned i=0;i<40;i++)boundaryWords[i]=0xd503201fu;
    for(unsigned i=0;i<12;i++)boundaryWords[i]=0x00010203u;
    boundaryWords[17]=0xd53bd048u;boundaryWords[18]=0xaa0003f2u;
    uint64_t marks[]={0x1030,0x1090};klx_code_context context={marks,2,0x1000,NULL,0};
    assert(kl_x18_is_data(boundaryWords,sizeof boundaryWords,17));
    assert(!kl_x18_is_data_context(boundaryWords,sizeof boundaryWords,17,&context));
    assert(kl_x18_count_context(boundaryWords,sizeof boundaryWords,&context)>kl_x18_count(boundaryWords,sizeof boundaryWords));
    uint32_t state=0x4872f3b1u;unsigned skipped=0;
    for(unsigned i=0;i<4000000;++i){
        uint32_t word=randomWord(&state);klx_info decoded;klx_decode(word,&decoded);
        if(!klj_x18_candidate(word)){assert(!decoded.nfields&&!decoded.sysreg);++skipped;}
    }
    assert(skipped>3000000);
    for(unsigned rt=0;rt<32;++rt)assert(klj_x18_candidate(0xd53b0020u|rt));
    enum {WORDS=4096,POOL=WORDS*KLX_VEN_MAX_INSN};
    uint32_t a[WORDS],b[WORDS],pa[POOL],pb[POOL];
    // Include code, constants, x18 and CTR instructions; original data-window
    // classification remains authoritative on both entry paths.
    const uint32_t instructions[]={0xd503201fu,0xaa1203e0u,0xaa0003f2u,0xd53b0020u,0x91000652u,0xf9400252u,0xd65f03c0u};
    for(unsigned i=0;i<WORDS;++i)a[i]=i<WORDS/2?instructions[i%7]:randomWord(&state);
    memcpy(b,a,sizeof a);memset(pa,0,sizeof pa);memset(pb,0,sizeof pb);
    unsigned data,ctr,want=klx_survey(a,sizeof a,&data,&ctr),reference=0,referenceData=0,referenceCtr=0;
    for(unsigned i=0;i<WORDS;++i){klx_info in;klx_decode(a[i],&in);if(!in.nfields&&!in.sysreg)continue;if(klx_looks_like_data(a,WORDS,i)){referenceData+=!!in.nfields;continue;}reference+=!!in.nfields;referenceCtr+=!!in.sysreg;}
    assert(want==reference&&data==referenceData&&ctr==referenceCtr);
    kl_x18_stats sa,sb;size_t ua=0,ub=0;
    int ra=kl_x18_emit(a,sizeof a,0x100000,pa,sizeof pa,0x200000,&sa,&ua);
    int rb=klj_x18_emit_surveyed(b,sizeof b,0x100000,pb,sizeof pb,0x200000,&sb,&ub,want,data,ctr,NULL);
    assert(ra==rb&&ua==ub&&!memcmp(&sa,&sb,sizeof sa)&&!memcmp(a,b,sizeof a)&&!memcmp(pa,pb,sizeof pa));
    puts("PASS original decoder candidates, data classification and byte-identical surveyed veneers");
}
