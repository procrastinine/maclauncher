#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <libkern/OSCacheControl.h>
#include KL_X18_SOURCE

int main(void) {
    unsigned count=0;
    for(unsigned opc=0;opc<3;++opc)for(int sign=-1;sign<=1;sign+=2)for(int side=0;side<2;++side) {
        size_t size=6*1024*1024;
        uint8_t *memory=mmap(NULL,size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);
        assert(memory!=MAP_FAILED);
        uint32_t *code=(void *)(memory+2*1024*1024),*pool=(void *)(memory+(side?4*1024*1024:0));
        unsigned k=0;
        code[k++]=enc_movz(16,0x1234,0);code[k++]=enc_movz(17,0x5678,0);
        code[k++]=0xeb00001fu; // cmp x0,x0
        code[k++]=0xd53b4202u; // mrs x2,nzcv
        int displacement=sign*0x80000;
        uint64_t *literal=(void *)((uint8_t *)(code+k)+displacement);
        code[k++]=0x18000000u|(opc<<30)|(((uint32_t)(displacement/4)&0x7ffffu)<<5)|18;
        code[k++]=0xd53b4203u; // mrs x3,nzcv
        code[k++]=enc_str(16,0,0);code[k++]=enc_str(17,0,8);code[k++]=enc_str(18,0,16);
        code[k++]=enc_str(2,0,24);code[k++]=enc_str(3,0,32);code[k++]=0xd65f03c0u;
        *literal=0x0123456789abcdefull;
        kl_x18_stats stats;size_t used=0;
        assert(!kl_x18_emit(code,k*4,(uintptr_t)code,pool,512,(uintptr_t)pool,&stats,&used));
        assert(!stats.refused&&stats.patched==2&&used<=2*KLX_VEN_MAX_INSN*4);
        // The veneer reads live literal data; it must not bake in its old value.
        *literal=0xfedcba9887654321ull;
        assert(!mprotect(memory,size,PROT_READ|PROT_EXEC));sys_icache_invalidate(memory,size);
        uint64_t output[5]={0};((void (*)(uint64_t *))code)(output);
        uint64_t expected=opc==0?0x87654321ull:opc==1?*literal:0xffffffff87654321ull;
        assert(output[0]==0x1234&&output[1]==0x5678&&output[2]==expected);
        assert(output[3]==0x60000000u&&output[4]==output[3]);
        assert(!munmap(memory,size));++count;
    }
    printf("PASS %u literal veneers: live memory, W/X extension, original PC, scratch and NZCV\n",count);
}
