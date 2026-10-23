#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <sys/mman.h>
#include <libkern/OSCacheControl.h>
#include KL_X18_SOURCE

static uint32_t adr(unsigned reg,int32_t displacement){
    uint32_t immediate=(uint32_t)displacement&0x1fffff;
    return 0x10000000u|((immediate&3)<<29)|((immediate>>2)<<5)|reg;
}
int main(int argc,char **argv){
    assert(argc==2);int adapted=atoi(argv[1]);size_t size=6*1024*1024;
    for(int variant=0;variant<2;++variant){
        uint8_t *memory=mmap(NULL,size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(memory!=MAP_FAILED);
        uint32_t *code=(void *)(memory+2*1024*1024),*pool=(void *)(memory+(variant?4*1024*1024:0));
        code[0]=0xd2800000u|(0x1234u<<5)|16;code[1]=0xd2800000u|(0x5678u<<5)|17;
        int32_t displacement=variant?-0xfffff:0x2e8;code[2]=adr(18,displacement);
        code[3]=0xa9000000u|(17u<<10)|16; // stp x16,x17,[x0]
        code[4]=0xf9000000u|(2u<<10)|18; // str x18,[x0,#16]
        code[5]=0xd65f03c0u;
        uint64_t expected=(uintptr_t)(code+2)+(int64_t)displacement;
        kl_x18_stats stats;size_t used=0;
        assert(!kl_x18_emit(code,24,(uintptr_t)code,pool,512,(uintptr_t)pool,&stats,&used));
        if(!adapted){assert(stats.refused==1&&code[2]==adr(18,displacement));assert(!munmap(memory,size));continue;}
        assert(stats.refused==0&&stats.patched==2&&used<=64);
        assert(!mprotect(memory,size,PROT_READ|PROT_EXEC));sys_icache_invalidate(memory,size);
        uint64_t output[3]={0};((void (*)(uint64_t *))code)(output);
        assert(output[0]==0x1234&&output[1]==0x5678&&output[2]==expected);
        assert(!munmap(memory,size));
    }
    puts(adapted?"PASS actual ADR veneer target, live scratch registers and thread slot":"PASS original ADR refusal preserved");
}
