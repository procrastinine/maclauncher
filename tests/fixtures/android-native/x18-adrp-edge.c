#include <assert.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <libkern/OSCacheControl.h>
#ifdef KL_X18_CORE_SOURCE
#include KL_X18_CORE_SOURCE
static unsigned test_slot;
static void initialize(void) {
    pthread_key_t key;assert(!pthread_key_create(&key,NULL));test_slot=(unsigned)key;
    assert(test_slot<4096);void *value=(void *)(uintptr_t)0x12345678;
    assert(!pthread_setspecific(key,value));uint64_t tp;
    __asm__ volatile("mrs %0,tpidrro_el0":"=r"(tp));assert(((void **)tp)[test_slot]==value);
}
static int rewrite(uint32_t *code,size_t size,uint32_t *pool,size_t capacity) {
    size_t used=0;unsigned patched=0;
    for(size_t k=0;k<size/4;k++)if(klx_core_classify(code[k])) {
        uint64_t site=(uintptr_t)(code+k),at=(uintptr_t)(pool+used);
        int count=klx_core_emit(code[k],site,at,test_slot,0,pool+used,capacity-used);
        if(count<0)return -1;uint32_t branch;assert(enc_b(site,at,&branch));
        code[k]=branch;used+=(size_t)count;patched++;
    }
    assert(patched==2&&used<=24);return 0;
}
#else
#include KL_X18_SOURCE
static void initialize(void){assert(!kl_x18_init());}
static int rewrite(uint32_t *code,size_t size,uint32_t *pool,size_t capacity) {
    kl_x18_stats stats;size_t used=0;
    assert(!kl_x18_emit(code,size,(uintptr_t)code,pool,capacity*4,(uintptr_t)pool,&stats,&used));
    if(stats.refused)return -1;assert(stats.patched==2&&used<=96);return 0;
}
#endif

static uint64_t original_page(uint32_t word,uint64_t pc) {
    uint32_t raw=(((word>>5)&0x7ffffu)<<2)|((word>>29)&3u);
    int64_t pages=(int64_t)(raw^0x100000u)-0x100000;
    return (pc&~4095ULL)+(uint64_t)(pages*4096);
}
int main(int argc,char **argv) {
    assert(argc==2);int adapted=atoi(argv[1]);initialize();
    const size_t distance=32*1024*1024,total=distance*2+16384;
    /* Positive and negative architectural edges, with the island on either
     * side. The first word is a retained final-publication rejection. */
    const uint32_t words[]={0xd07f9e52,0x90800012};
    for(unsigned sign=0;sign<2;sign++)for(unsigned above=0;above<2;above++) {
        uint8_t *memory=mmap(NULL,total,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(memory!=MAP_FAILED);
        uint32_t *code=(void *)(memory+distance),*pool=(void *)(memory+(above?distance*2:0));
        unsigned k=0;code[k++]=enc_movz(16,0x1616,0);code[k++]=enc_movz(17,0x1717,0);
        code[k++]=0xeb00001fu; /* cmp x0,x0 */
        code[k++]=0xd53b4204u; /* mrs x4,nzcv */
        unsigned site=k;code[k++]=words[sign];code[k++]=0xd53b4205u;
        code[k++]=enc_stp(16,17,0)&~(31u<<5); /* stp x16,x17,[x0] */
        code[k++]=enc_str(18,0,16);
        code[k++]=0xa9019404u; /* stp x4,x5,[x0,#24] */
        code[k++]=0xd65f03c0u;
        uint64_t expected=original_page(words[sign],(uintptr_t)(code+site));
        int overflows=(sign&&above)||(!sign&&!above);
        int result=rewrite(code,k*4,pool,128);
        if(!adapted&&overflows){assert(result==-1);assert(!munmap(memory,total));continue;}
        assert(!result);assert(!mprotect(code,16384,PROT_READ|PROT_EXEC));
        assert(!mprotect(pool,16384,PROT_READ|PROT_EXEC));sys_icache_invalidate(code,k*4);sys_icache_invalidate(pool,512);
        uint64_t output[5]={0};((void (*)(uint64_t *))code)(output);
        if(output[0]!=0x1616||output[1]!=0x1717||output[2]!=expected)
            fprintf(stderr,"word=%08x above=%u scratch=%llx/%llx page=%llx expected=%llx\n",words[sign],above,
                (unsigned long long)output[0],(unsigned long long)output[1],
                (unsigned long long)output[2],(unsigned long long)expected);
        assert(output[0]==0x1616&&output[1]==0x1717&&output[2]==expected);
        assert(output[3]==0x60000000&&output[4]==0x60000000);assert(!munmap(memory,total));
    }
    puts(adapted?"PASS native ADRP positive/negative edge addresses, both island directions, scratch registers and NZCV":"PASS previous ADRP range-edge veneer rejection reproduced");
}
