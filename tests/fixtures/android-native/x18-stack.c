#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <libkern/OSCacheControl.h>
#include KL_X18_SOURCE

static uint32_t pair(unsigned opc,int load,int pre,int delta){
    unsigned scale=opc==2?8:4;
    return 0x28000000u|(opc<<30)|((pre?3u:1u)<<23)|((unsigned)load<<22)|
        (((uint32_t)(delta/(int)scale)&127u)<<15)|(18u<<10)|(31u<<5)|17;
}
static uint32_t single(unsigned size,unsigned opc,int pre,int delta){
    return 0x38000000u|(size<<30)|(opc<<22)|(((uint32_t)delta&511u)<<12)|
        ((pre?3u:1u)<<10)|(31u<<5)|18;
}
static uint32_t load_signed_offset(unsigned size,unsigned reg,unsigned base,int offset){
    return 0x38400000u|(size<<30)|(((uint32_t)offset&511u)<<12)|(base<<5)|reg;
}
static void check(uint32_t instruction,int delta,int pre,unsigned bytes,int load,int paired,int signed_load){
    size_t size=32768;uint8_t *memory=mmap(NULL,size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);
    assert(memory!=MAP_FAILED);uint32_t *code=(void *)memory,*pool=(void *)(memory+16384);unsigned k=0;
    code[k++]=0x910003e5u; // mov x5,sp
    code[k++]=0xd10003ffu|(1024u<<10); // reserve guest working frame
    code[k++]=0x910003e6u; // mov x6,sp, the original instruction's base
    for(unsigned reg=8;reg<=17;++reg)code[k++]=enc_movz(reg,0x1000+reg,0);
    const uint64_t initial=0xfedcba9876543210ull;
    k+=enc_mov_imm64(18,initial,code+k);
    const uint64_t loaded0=bytes==8?0x8765432101234567ull:0x87654321u;
    const uint64_t loaded1=bytes==8?0x89abcdef01234567ull:0x89abcdefu;
    int address=pre?delta:0;
    k+=enc_mov_imm64(1,loaded0,code+k);k+=enc_mov_imm64(2,loaded1,code+k);
    unsigned shift=bytes==8?3:bytes==4?2:bytes==2?1:0;
    // Set backing memory with ordinary stores, independent of the rewritten operation.
    code[k++]=0x38000000u|(shift<<30)|(((uint32_t)address&511u)<<12)|(6u<<5)|1;
    if(paired)code[k++]=0x38000000u|(shift<<30)|(((uint32_t)(address+(int)bytes)&511u)<<12)|(6u<<5)|2;
    code[k++]=0xeb01003fu; // cmp x1,x1: stable NZCV through the veneer
    code[k++]=0xd53b4204u; // mrs x4,nzcv
    code[k++]=instruction;
    code[k++]=0xd53b4207u; // mrs x7,nzcv
    // Observe any released stack storage before a later instruction may reuse it.
    code[k++]=load_signed_offset(shift,1,6,address);
    if(paired)code[k++]=load_signed_offset(shift,2,6,address+(int)bytes);
    for(unsigned reg=8;reg<=18;++reg)code[k++]=enc_str(reg,0,(reg-8)*8);
    code[k++]=enc_str(4,0,88);code[k++]=enc_str(7,0,96);
    code[k++]=0x910003e3u; // mov x3,sp
    code[k++]=0xcb060063u; // sub x3,x3,x6
    code[k++]=enc_str(3,0,104);
    code[k++]=enc_str(1,0,112);
    if(paired)code[k++]=enc_str(2,0,120);
    code[k++]=0x910000bfu; // mov sp,x5
    code[k++]=0xd65f03c0u;
    kl_x18_stats stats;size_t used=0;
    assert(!kl_x18_emit(code,k*4,(uintptr_t)code,pool,16384,(uintptr_t)pool,&stats,&used));
    assert(!stats.refused&&stats.patched>=3&&used<=stats.sites*KLX_VEN_MAX_INSN*4);
    for(unsigned n=0;n<used/4;++n){klx_info decoded;klx_decode(pool[n],&decoded);assert(!decoded.nfields);}
    assert(!mprotect(memory,size,PROT_READ|PROT_EXEC));sys_icache_invalidate(memory,size);
    uint64_t output[16]={0};((void (*)(uint64_t *))code)(output);
    uint64_t mask=bytes==8?UINT64_MAX:((1ull<<(bytes*8))-1);
    uint64_t expected18=load?(paired?loaded1:loaded0)&mask:initial;
    uint64_t expected17=load&&paired?loaded0&mask:0x1011;
    if(signed_load){expected18=(uint64_t)(int64_t)(int32_t)expected18;if(paired)expected17=(uint64_t)(int64_t)(int32_t)expected17;}
    for(unsigned reg=8;reg<17;++reg)assert(output[reg-8]==0x1000+reg);
    assert(output[9]==expected17&&output[10]==expected18);
    assert(output[11]==output[12]&&output[11]==0x60000000u);
    assert((int64_t)output[13]==delta);
    assert(output[14]==((load?loaded0:paired?0x1011:initial)&mask));
    if(paired)assert(output[15]==((load?loaded1:initial)&mask));
    assert(!munmap(memory,size));
}
int main(void){
    unsigned count=0;
    for(int pre=0;pre<2;++pre)for(int sign=-1;sign<=1;sign+=2)for(int load=0;load<2;++load){
        for(unsigned opc=0;opc<=2;opc+=2){int delta=sign*32;check(pair(opc,load,pre,delta),delta,pre,opc==2?8:4,load,1,0);++count;}
        for(unsigned size=0;size<4;++size){int delta=sign*16;check(single(size,load,pre,delta),delta,pre,1u<<size,load,0,0);++count;}
        if(load){int delta=sign*16;check(pair(1,1,pre,delta),delta,pre,4,1,1,1);++count;
            check(single(2,2,pre,delta),delta,pre,4,1,0,1);++count;}
    }
    // The exact pair emitted by conventional Android function prologues/epilogues.
    check(0xa9bf4bf1u,-16,1,8,0,1,0);check(0xa8c14bf1u,16,0,8,1,1,0);count+=2;
    printf("PASS %u actual stack-writeback veneers: memory, SP, shadow x18, scratch and NZCV\n",count);
}
