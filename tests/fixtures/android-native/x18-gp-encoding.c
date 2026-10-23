#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <libkern/OSCacheControl.h>
#include KL_X18_SOURCE

static void packed_bytes(int fixed) {
    const uint32_t reserved[]={0xcbead646u,0xe9114bc4u,0x1221fb52u,
        0x6a48e243u,0x2ab2d672u,0x3a169a52u,0x6a89b7d2u,
        0xe88ebe52u,0x2b1ed8f2u,0x0af8be42u,0x333088b2u};
    uint32_t code[33];
    for(unsigned i=0;i<33;i++)code[i]=0xd503201fu;
    for(unsigned i=0;i<sizeof reserved/sizeof *reserved;i++)code[i]=reserved[i];
    code[16]=0xaa0003f2u;
    unsigned candidates=kl_x18_count(code,sizeof code);
    if(fixed)assert(candidates==0);else assert(candidates>0);
}

static void execute(uint32_t operation,uint64_t input,uint64_t other,uint64_t expected,uint64_t flags) {
    size_t size=32768;
    uint8_t *memory=mmap(NULL,size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(memory!=MAP_FAILED);
    uint32_t *code=(void *)memory,*pool=(void *)(memory+16384);unsigned k=0;
    code[k++]=enc_movz(16,0x1616,0);code[k++]=enc_movz(17,0x1717,0);
    code[k++]=0xaa0103f2u; // mov x18,x1
    k+=enc_mov_imm64(2,other,code+k);
    code[k++]=0xeb01003fu; // cmp x1,x1: NZCV=0x60000000
    code[k++]=0xd53b4204u; // mrs x4,nzcv
    code[k++]=operation;
    code[k++]=0xd53b4205u; // mrs x5,nzcv
    code[k++]=enc_str(18,0,0);code[k++]=enc_str(4,0,8);code[k++]=enc_str(5,0,16);
    code[k++]=enc_str(16,0,24);code[k++]=enc_str(17,0,32);code[k++]=0xd65f03c0u;
    kl_x18_stats stats;size_t used;
    assert(!kl_x18_emit(code,k*4,(uintptr_t)code,pool,16384,(uintptr_t)pool,&stats,&used));
    assert(!stats.refused&&stats.patched>=2);
    assert(!mprotect(memory,size,PROT_READ|PROT_EXEC));sys_icache_invalidate(memory,size);
    uint64_t output[5]={0};((void (*)(uint64_t *,uint64_t))code)(output,input);
    if(output[0]!=expected||output[2]!=flags)fprintf(stderr,"word=%08x value=%#llx expected=%#llx flags=%#llx expected-flags=%#llx\n",operation,(unsigned long long)output[0],(unsigned long long)expected,(unsigned long long)output[2],(unsigned long long)flags);
    assert(output[0]==expected&&output[1]==0x60000000&&output[2]==flags);
    assert(output[3]==0x1616&&output[4]==0x1717);assert(!munmap(memory,size));
}

int main(int argc,char **argv) {
    assert(argc==2);int fixed=atoi(argv[1]);packed_bytes(fixed);
    if(!fixed){puts("PASS previous decoder reproduced reserved GP words as translation candidates");return 0;}
    execute(0x0b027e52u,1,1,0x80000001,0x60000000); // ADD W, LSL #31
    execute(0xcb82fe52u,10,UINT64_MAX,11,0x60000000); // SUB X, ASR #63
    execute(0x8b225252u,11,3,59,0x60000000); // ADD extended, UXTW #4
    execute(0x12001e52u,0x12345621,0,0x21,0x60000000); // AND W immediate
    execute(0xb2403e52u,0x12340000,0,0x1234ffff,0x60000000); // ORR X immediate
    execute(0x531f7e52u,0x80000000,0,1,0x60000000); // UBFM W boundary
    execute(0x1a020252u,5,7,13,0x60000000); // ADC W
    execute(0xba00064fu,0xb,0,0xb,0xb0000000); // RMIF x18,#0,#15
    execute(0xba12042fu,0xb000000000ull,0,0xb000000000ull,0xb0000000); // RMIF x1,#36,#15
    execute(0x3a000a4du,0x80,0,0x80,0xb0000000); // SETF8 w18
    execute(0x3a004a4du,0x8000,0,0x8000,0xb0000000); // SETF16 w18
    execute(0x9b027e52u,5,7,35,0x60000000); // MUL X
    execute(0x9b227e52u,0xfffffffe,3,UINT64_MAX-5,0x60000000); // SMADDL X
    execute(0x9bc27e52u,UINT64_MAX,2,1,0x60000000); // UMULH X
    execute(0x9b427e52u,1ull<<63,2,UINT64_MAX,0x60000000); // SMULH X
    execute(0x9a820252u,10,3,10,0x60000000); // CSEL X, EQ
    execute(0xfa420240u,10,3,10,0x20000000); // CCMP X, EQ
    puts("PASS reserved GP data preserved and 17 native arithmetic/flag veneers preserve registers and NZCV");
    return 0;
}
