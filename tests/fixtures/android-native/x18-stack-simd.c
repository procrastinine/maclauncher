#include <assert.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <string.h>
#if defined(ANDROID_STACK_COMPONENT) || defined(JVM_STACK_COMPONENT)
#define sys_icache_invalidate(p,n) __builtin___clear_cache((char *)(p),(char *)(p)+(n))
static uint32_t enc_movz(unsigned r,unsigned value,unsigned shift){return 0xd2800000u|(shift/16<<21)|(value<<5)|r;}
static uint32_t enc_str(unsigned r,unsigned base,unsigned offset){return 0xf9000000u|((offset/8)<<10)|(base<<5)|r;}
static void initialize(void){}
static void rewrite(uint32_t *code,size_t count,uint32_t *pool){(void)code;(void)count;(void)pool;}
static void invalid_completion(uint32_t *pool){(void)pool;}
#ifdef JVM_STACK_COMPONENT
#include <dlfcn.h>
static void *(*guest_map)(void *,size_t,int,int,int,off_t);
static int (*guest_protect)(void *,size_t,int),(*guest_unmap)(void *,size_t);
#define mmap guest_map
#define mprotect guest_protect
#define munmap guest_unmap
#endif
#else
#include <libkern/OSCacheControl.h>
#ifdef KL_X18_CORE_SOURCE
#include KL_X18_CORE_SOURCE
static unsigned test_slot;
static void initialize(void) {pthread_key_t key;assert(!pthread_key_create(&key,NULL));test_slot=(unsigned)key;assert(test_slot<4096);}
static void rewrite(uint32_t *code,size_t count,uint32_t *pool) {
    unsigned used=0,patched=0;
    for(size_t i=0;i<count;i++)if(klx_core_classify(code[i])) {
        uint64_t site=(uintptr_t)(code+i),at=(uintptr_t)(pool+used);uint32_t branch;
        int n=klx_core_emit(code[i],site,at,test_slot,0,pool+used,128-used);
        assert(n>0&&enc_b(site,at,&branch));code[i]=branch;used+=(unsigned)n;patched++;
    }
    assert(patched==3&&used<=3*KLX_VEN_MAX_INSN);
}
#else
#include KL_X18_SOURCE
static void initialize(void) {assert(!kl_x18_init());}
static void rewrite(uint32_t *code,size_t count,uint32_t *pool) {
    kl_x18_stats stats;size_t used;
    assert(!kl_x18_emit(code,count*4,(uintptr_t)code,pool,512,(uintptr_t)pool,&stats,&used));
    assert(stats.patched==3&&!stats.refused&&used<=3*KLX_VEN_MAX_INSN*4);
}
#endif

static volatile sig_atomic_t completions;
static void invalid_completion(uint32_t *pool) {
    unsigned trap=0;while(trap<128&&(pool[trap]&0xffe0001fu)!=0xd4400000u)trap++;
    assert(trap>=7&&trap<127);uint32_t body[10];memcpy(body,pool+trap-7,sizeof body);
    ucontext_t context={0};__typeof__(*context.uc_mcontext) state={0},before;
    context.uc_mcontext=&state;unsigned immediate=(body[7]>>5)&0xffffu;
    unsigned a=(immediate>>5)&31u,b=immediate&31u;
    state.__ss.__pc=(uintptr_t)(body+7);state.__ss.__sp=0;state.__ss.__x[a]=32;state.__ss.__x[b]=8192;
    before=state;assert(!klx_stack_resume(&context)&&!memcmp(&state,&before,sizeof state));
    uint64_t saved[4]={0x1616,0x1717,0,0};state.__ss.__sp=(uintptr_t)saved;state.__ss.__x[a]=(uintptr_t)saved+32;
    body[0]=0xd503201fu;before=state;assert(!klx_stack_resume(&context)&&!memcmp(&state,&before,sizeof state));
    state.__ss.__pc=1;before=state;assert(!klx_stack_resume(&context)&&!memcmp(&state,&before,sizeof state));
}
static void handler(int signal,siginfo_t *info,void *context) {
    (void)info;assert(signal==SIGILL);
    ucontext_t *uc=context;uint64_t old_frame=uc->uc_mcontext->__ss.__sp;
    assert(klx_stack_resume(context));completions++;
    assert(uc->uc_mcontext->__ss.__x[16]==0x1616&&uc->uc_mcontext->__ss.__x[17]==0x1717);
    // A newly delivered signal may reuse released stack storage. Completion
    // has already restored both scratch registers before exposing the new SP.
    if(uc->uc_mcontext->__ss.__sp>old_frame+32)memset((void *)(uintptr_t)old_frame,0xa5,16);
}
#endif

static void check(uint32_t operation,int delta,int load,int multiple) {
    const int flags=
#ifdef JVM_STACK_COMPONENT
        0x22; // Original Android private/anonymous flags at the public import.
#else
        MAP_PRIVATE|MAP_ANON;
#endif
    uint8_t *memory=mmap(NULL,32768,PROT_READ|PROT_WRITE,flags,-1,0);
    uint8_t *stack=mmap(NULL,65536,PROT_READ|PROT_WRITE,flags,-1,0);
    assert(memory!=MAP_FAILED&&stack!=MAP_FAILED);uint8_t *base=stack+32768;
    uint8_t input[64],expected[64];for(unsigned i=0;i<64;i++)input[i]=(uint8_t)(0x40+i);
    memcpy(expected,input,64);for(unsigned i=0;i<64;i++)base[i]=(uint8_t)(0x80+i);
    if(load){if(multiple)memcpy(expected,base,64);else for(unsigned i=0;i<4;i++)expected[i*16+3]=base[i];}
    uint32_t *code=(void *)memory,*pool=(void *)(memory+16384);unsigned k=0;
    code[k++]=0x910003e5u; // mov x5,sp
    code[k++]=0x9100005fu; // mov sp,x2
    code[k++]=0x910003e6u; // mov x6,sp
    code[k++]=enc_movz(16,0x1616,0);code[k++]=enc_movz(17,0x1717,0);
    code[k++]=0x4c40203fu; // ld1 {v31.16b,v0.16b,v1.16b,v2.16b},[x1]
    code[k++]=0xaa0303f2u; // mov x18,x3
    code[k++]=0xeb00001fu;code[k++]=0xd53b4204u; // compare; save NZCV
    code[k++]=operation;code[k++]=0xd53b4207u;
    // Observe storage released by a positive writeback before another guest
    // veneer legitimately reuses the current red zone.
    code[k++]=0x4c4020c4u;code[k++]=0x91020008u;code[k++]=0x4c002104u;
    code[k++]=enc_str(16,0,0);code[k++]=enc_str(17,0,8);
    code[k++]=enc_str(18,0,16);code[k++]=enc_str(4,0,24);code[k++]=enc_str(7,0,32);
    code[k++]=0x910003e3u;code[k++]=0xcb060063u;code[k++]=enc_str(3,0,40);
    code[k++]=0x91010001u; // add x1,x0,#64
    code[k++]=0x4c00203fu; // st1 same four vector registers,[x1]
    code[k++]=0x910000bfu;code[k++]=0xd65f03c0u;
    rewrite(code,k,pool);invalid_completion(pool);
    assert(!mprotect(memory,32768,PROT_READ|PROT_EXEC));sys_icache_invalidate(memory,32768);
    uint64_t output[24]={0};((void (*)(void *,void *,void *,int64_t))code)(output,input,base,delta);
    assert(output[0]==0x1616&&output[1]==0x1717&&(int64_t)output[2]==delta);
    assert(output[3]==0x60000000&&output[4]==0x60000000&&(int64_t)output[5]==delta);
    assert(!memcmp((uint8_t *)output+64,expected,64));
    const uint8_t *written=(const uint8_t *)output+128;
    if(!load){if(multiple)assert(!memcmp(written,input,64));else for(unsigned i=0;i<4;i++)assert(written[i]==input[i*16+3]);}
    assert(!munmap(memory,32768)&&!munmap(stack,65536));
}

static void check_alu(uint32_t operation,int delta,int bias,int relative,uint64_t operand) {
    const int flags=
#ifdef JVM_STACK_COMPONENT
        0x22;
#else
        MAP_PRIVATE|MAP_ANON;
#endif
    uint8_t *memory=mmap(NULL,32768,3,flags,-1,0),*stack=mmap(NULL,65536,3,flags,-1,0);
    assert(memory!=MAP_FAILED&&stack!=MAP_FAILED);uint8_t *base=stack+32768;
    uint64_t input=relative?(uint64_t)(relative==1?delta:-delta):(uintptr_t)base+(uint64_t)(delta+bias);
    uint32_t *code=(void *)memory,*pool=(void *)(memory+16384);unsigned k=0;
    code[k++]=0x910003e5u;code[k++]=0x9100005fu;
    code[k++]=enc_movz(16,0x1616,0);code[k++]=enc_movz(17,0x1717,0);
    code[k++]=0xaa0303f2u;code[k++]=0xeb00001fu;code[k++]=0xd53b4204u;
    code[k++]=operation;code[k++]=0x910003e3u;code[k++]=0x910000bfu;
    code[k++]=0xd53b4207u;
    code[k++]=enc_str(16,0,0);code[k++]=enc_str(17,0,8);code[k++]=enc_str(18,0,16);
    code[k++]=enc_str(4,0,24);code[k++]=enc_str(7,0,32);code[k++]=enc_str(3,0,40);code[k++]=0xd65f03c0u;
    rewrite(code,k,pool);invalid_completion(pool);
    assert(!mprotect(memory,32768,5));sys_icache_invalidate(memory,32768);
    uint64_t output[6]={0};((void (*)(void *,uint64_t,void *,uint64_t))code)(output,operand,base,input);
    assert(output[0]==0x1616&&output[1]==0x1717&&output[2]==input);
    assert(output[3]==0x60000000&&output[4]==output[3]&&output[5]==(uintptr_t)base+(uint64_t)delta);
    assert(!munmap(memory,32768)&&!munmap(stack,65536));
}

static void check_stgp(void) {
    // Independently assembled MTE forms. Publication retains STGP itself;
    // this check does not claim a host without MTE can execute tag stores.
    const uint32_t operations[]={0x68b4cbe7,0x69b4cbe7,0x688bcbe7,0x698bcbe7};
#if !defined(ANDROID_STACK_COMPONENT) && !defined(JVM_STACK_COMPONENT)
    const uint32_t plain[]={0x69004607,0x6934c607,0x69004607,0x690bc607};
    klx_info reserved;assert(!klx_decode(0x6834cbe7,&reserved)&&!reserved.nfields);
#endif
    for(unsigned i=0;i<4;i++) {
        const int flags=
#ifdef JVM_STACK_COMPONENT
            0x22;
#else
            MAP_PRIVATE|MAP_ANON;
#endif
        uint32_t *code=mmap(NULL,32768,3,flags,-1,0);assert(code!=MAP_FAILED);uint32_t *pool=code+4096;
        code[0]=0xaa0303f2u;code[1]=operations[i];code[2]=enc_str(18,0,16);code[3]=0xd65f03c0u;
        rewrite(code,4,pool);
#if !defined(ANDROID_STACK_COMPONENT) && !defined(JVM_STACK_COMPONENT)
        int found=0;for(unsigned k=0;k<128;k++)if(pool[k]==plain[i])found++;
        assert(found==1);
#endif
        assert(!mprotect(code,32768,5));assert((code[1]&0xfc000000u)==0x14000000u);
        assert(!munmap(code,32768));
    }
    puts("PASS four STGP publications retain the original tag-store opcode and 16-byte scaled addressing");
}

int main(int argc,char **argv) {
#ifdef JVM_STACK_COMPONENT
    assert(argc==3);void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!library){fprintf(stderr,"%s\n",dlerror());return 2;}
    void *(*lookup)(const char *)=dlsym(library,"kl_shim_lookup");
    int (*configure)(const char *)=dlsym(library,"klj_process_ids_configure");assert(lookup&&configure&&configure(argv[2])>0);
    guest_map=lookup("mmap");guest_protect=lookup("mprotect");guest_unmap=lookup("munmap");assert(guest_map&&guest_protect&&guest_unmap);
#else
    (void)argc;(void)argv;
#endif
    initialize();
#if !defined(ANDROID_STACK_COMPONENT) && !defined(JVM_STACK_COMPONENT)
    stack_t alternate={.ss_sp=malloc(65536),.ss_size=65536};assert(alternate.ss_sp&&!sigaltstack(&alternate,NULL));
    struct sigaction action={.sa_sigaction=handler,.sa_flags=SA_SIGINFO|SA_ONSTACK};sigemptyset(&action.sa_mask);assert(!sigaction(SIGILL,&action,NULL));
    const uint32_t allocated[]={0x91800012,0x91bf3e40,0xd1810652,0x91820a5f,0xd1830ff2};
    for(unsigned i=0;i<sizeof allocated/sizeof *allocated;i++) {
        klx_info info;assert(klx_decode(allocated[i],&info)&&info.nfields&&!klx_unallocated(allocated[i]));
        const uint32_t reserved[]={1u<<31,1u<<29,1u<<22,1u<<15,1u<<14};
        for(unsigned j=0;j<sizeof reserved/sizeof *reserved;j++){assert(!klx_decode(allocated[i]^reserved[j],&info)&&!info.nfields&&klx_unallocated(allocated[i]^reserved[j]));}
    }
    klx_info info;assert(!klx_decode(0x11cb865f,&info)&&!info.nfields);
#endif
    const uint32_t operations[]={0x0db22fff,0x0df22fff,0x4c9223ff,0x4cd223ff};
    const int deltas[]={-8192,-16,16,8192};
    for(unsigned i=0;i<4;i++)for(unsigned j=0;j<4;j++)check(operations[i],deltas[j],i&1,i>=2);
    for(unsigned j=0;j<4;j++) {
        check_alu(0xd102ea5f,deltas[j],186,0,0); // retained SUB SP,X18,#186
        check_alu(0x9100025f,deltas[j],0,0,0); // ADD SP,X18,#0
        check_alu(0xd140065f,deltas[j],4096,0,0); // shifted immediate
        check_alu(0x8b21d25f,deltas[j],16,0,UINT64_MAX); // signed W extension
        check_alu(0x8b32e3ff,deltas[j],0,1,0); // original SP plus signed X18
        check_alu(0xcb3263ff,deltas[j],0,2,0); // original SP minus X18
    }
    check_stgp();
#if defined(ANDROID_STACK_COMPONENT) || defined(JVM_STACK_COMPONENT)
    puts("PASS delivered publication and original signal owner execute 16 SIMD and 24 ALU stack veneers");
#else
    assert(completions==40);
    puts("PASS 16 SIMD and 24 ALU stack veneers preserve memory, vectors, SP, scratch and NZCV; reserved tagged fields preserved");
#endif
}
