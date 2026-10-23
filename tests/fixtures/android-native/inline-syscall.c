#include <assert.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <libkern/OSCacheControl.h>
#include "inline-syscall.h"

static int (*is_data)(const void *,size_t,size_t),(*error_to_linux)(int);
static int (*is_data_context)(const void *,size_t,size_t,const klx_code_context *);
static int (*read_clock)(int,struct timespec *);
static long (*dispatch)(long,long,long,long,long,long,long);
uint64_t klj_inline_call_slot_offset;
static _Thread_local void *guest_tls;
static int (*pointer_offset)(void);
static int64_t (*pointer_stub)(uint32_t,uint32_t,uint32_t,uint32_t *,size_t);
static long (*recursive_call)(int,struct timespec *,long);
static void *tiny_top;
static int signal_mode;
static volatile sig_atomic_t signal_visits;
static uint64_t jump_buffer[33];
void *inline_jump_save_target;
static void (*jump_restore)(uint64_t *,int);
extern int inline_jump_save(uint64_t *,int) __attribute__((returns_twice));
extern long inline_tiny_stack(void *,void *,uintptr_t,uintptr_t,uintptr_t);
static void guest_signal(int signal,void *info,void *context){
    (void)info;(void)context;assert(signal==10);signal_visits++;
    assert(inline_tiny_stack((void *)recursive_call,tiny_top,0,0,0x7ffffc)==0x23456789);
    if(signal_mode==2){jump_restore(jump_buffer,37);assert(0);}
}
int klj_guest_thread_pointer_offset(void){return pointer_offset();}
int64_t klj_guest_thread_pointer_stub(uint32_t instruction,uint32_t offset,uint32_t shadow,uint32_t *out,size_t capacity){return pointer_stub(instruction,offset,shadow,out,capacity);}
void *klj_libc_thread_tls(void){return guest_tls;}
void klj_libc_thread_set_tls(void *value){guest_tls=value;}
int kl_x18_is_data(const void *code,size_t size,size_t index){return is_data(code,size,index);}
int kl_x18_is_data_context(const void *code,size_t size,size_t index,const klx_code_context *context){return context?is_data_context(code,size,index,context):is_data(code,size,index);}
int kl_errno_to_linux(int value){return error_to_linux(value);}
long klb_syscall(long n,long a,long b,long c,long d,long e,long f){
    if(n==0x7ffffc)return 0x23456789;
    if(n==0x7ffffd){
        volatile unsigned char reserve[8192];
        for(size_t i=0;i<sizeof reserve;i++)reserve[i]=(unsigned char)(i^0xa7);
        assert(!raise(SIGUSR1));
        for(size_t i=0;i<sizeof reserve;i++)assert(reserve[i]==(unsigned char)(i^0xa7));
        return 0x12345678;
    }
    if(n==0x7fffff){
        volatile unsigned char reserve[8192];
        for(size_t i=0;i<sizeof reserve;i++)reserve[i]=(unsigned char)(i^0x5a);
        struct timespec now={0};assert(!recursive_call(1,&now,113)&&now.tv_sec>0);
        for(size_t i=0;i<sizeof reserve;i++)assert(reserve[i]==(unsigned char)(i^0x5a));
        return 0x12345678;
    }
    // The new raw-clock dispatch uses the same already supplied clock owner.
    return n==113?read_clock((int)a,(struct timespec *)b):dispatch(n,a,b,c,d,e,f);
}
extern const uint8_t inline_state_begin[],inline_state_end[];
struct state {uint64_t registers[32];uint8_t vectors[512];uint64_t flags[3],before,after;};
int main(int argc,char **argv){
    assert(argc==3||argc==4);void *lib=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!lib){puts(dlerror());return 1;}
    int (*configure)(const char *)=dlsym(lib,"klj_process_ids_configure");assert(configure&&configure(argv[2])>0);
    void (*enter)(void)=dlsym(lib,"kl_thread_init");assert(enter);enter();
    const uint64_t *slot=dlsym(lib,"klj_inline_call_slot_offset");assert(slot);
    klj_inline_call_slot_offset=*slot;
    is_data=dlsym(lib,"kl_x18_is_data");error_to_linux=dlsym(lib,"kl_errno_to_linux");
    is_data_context=dlsym(lib,"kl_x18_is_data_context");assert(is_data_context);
    dispatch=dlsym(lib,"klb_syscall");read_clock=dlsym(lib,"klb_clock_gettime");assert(is_data&&error_to_linux&&dispatch&&read_clock);
    pointer_offset=dlsym(lib,"klj_guest_thread_pointer_offset");pointer_stub=dlsym(lib,"klj_guest_thread_pointer_stub");assert(pointer_offset&&pointer_stub);
    size_t page=(size_t)getpagesize(),size=(size_t)(inline_state_end-inline_state_begin),used=0;
    uint8_t *image=mmap(NULL,page*3,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(image!=MAP_FAILED&&size<page);
    memcpy(image,inline_state_begin,size);assert(klj_inline_syscall_count(image,size)==1);
    assert(!klj_inline_syscall_patch(image,size,image+page,page*2,&used)&&used==page);
    assert(!mprotect(image,page,PROT_READ|PROT_EXEC));sys_icache_invalidate(image,page);
    struct state state={0};errno=E2BIG;((void (*)(struct state *))image)(&state);assert(errno==E2BIG);
    uint64_t expected=(uint64_t)dispatch(178,0,0,0,0,0,0);
    if(state.registers[0]!=expected)fprintf(stderr,"SVC returned %#llx, owner returned %#llx\n",(unsigned long long)state.registers[0],(unsigned long long)expected);
    assert(state.registers[0]==expected);
    for(int i=1;i<=29;i++)if(i!=18)assert(state.registers[i]==(uint64_t)(i==8?178:0x100+i));
    assert(state.registers[30]==state.registers[31]&&state.before==state.after);
    for(int i=0;i<32;i++)for(int lane=0;lane<16;lane++)assert(state.vectors[i*16+lane]==i+1);
    assert(state.flags[0]==0xa0000000&&state.flags[1]==1&&state.flags[2]==0x1000000);
    // A normal Linux wrapper: mov x8,x2; svc #0; ret.
    assert(!mprotect(image,page,PROT_READ|PROT_WRITE));
    uint32_t code[]={0xaa0203e8u,0xd4000001u,0xd65f03c0u};memcpy(image,code,sizeof code);
    assert(!klj_inline_syscall_patch(image,sizeof code,image+page,page*2,&used));
    assert(!mprotect(image,page,PROT_READ|PROT_EXEC));sys_icache_invalidate(image,page);
    struct timespec now={0};long (*clock_call)(int,struct timespec *,long)=(void *)image;
    assert(!clock_call(1,&now,113)&&now.tv_sec>0&&now.tv_nsec>=0&&now.tv_nsec<1000000000);
    errno=E2BIG;assert(clock_call(999,&now,113)==-22&&errno==E2BIG);
    assert(clock_call(0,NULL,999999)==-38&&errno==E2BIG);
    recursive_call=clock_call;
    // A NOSPLIT guest may have only a few hundred bytes before its guard.
    // Arbitrary C and a recursive SVC must use the existing native stack.
    unsigned char *tiny=mmap(NULL,page*2,PROT_NONE,MAP_PRIVATE|MAP_ANON,-1,0);assert(tiny!=MAP_FAILED);
    assert(!mprotect(tiny+page,page,PROT_READ|PROT_WRITE));
    memset(tiny+page,0xa5,512);
    void *top=tiny+page+512;
    tiny_top=top;
    errno=E2BIG;assert(inline_tiny_stack((void *)clock_call,top,0,0,0x7fffff)==0x12345678&&errno==E2BIG);
    for(size_t i=0;i<512-64;i++)assert(tiny[page+i]==0xa5);
    if(argc==4){
    struct anchor {uint64_t *cursor;uintptr_t low,high;unsigned *in_host;};
    struct anchor *anchor=pthread_getspecific((pthread_key_t)(klj_inline_call_slot_offset/8));assert(anchor);
    uint64_t prior_cursor=*anchor->cursor;unsigned prior_host=*anchor->in_host;
    void *(*lookup)(const char *)=dlsym(lib,"kl_shim_lookup");assert(lookup);
    void *(*load_guest)(const char *,int)=lookup("dlopen");
    void *(*guest_symbol)(void *,const char *)=lookup("dlsym");assert(load_guest&&guest_symbol);
    void *guest=load_guest(argv[3],2);assert(guest);
    void (*configure_signal)(void (*)(int,void*,void*))=guest_symbol(guest,"inline_signal_configure");assert(configure_signal);
    configure_signal(guest_signal);
    void (*original_handler)(int,void*,void*)=guest_symbol(guest,"inline_signal_handler");assert(original_handler);
    inline_jump_save_target=lookup("sigsetjmp");jump_restore=lookup("siglongjmp");assert(inline_jump_save_target&&jump_restore);
    typedef struct {uint32_t flags,padding;void (*handler)(int,void*,void*);uint64_t mask;void *restorer;} action;
    int (*install)(int,const action*,action*)=lookup("sigaction");assert(install);
    action request={.flags=0x08000004,.handler=original_handler},previous;
    stack_t old_stack,new_stack={.ss_size=65536,.ss_sp=mmap(NULL,65536,PROT_READ|PROT_WRITE,MAP_ANON|MAP_PRIVATE,-1,0)};
    assert(new_stack.ss_sp!=MAP_FAILED&&!sigaltstack(&new_stack,&old_stack));
    assert(!install(10,&request,&previous));
    signal_mode=1;
    assert(inline_tiny_stack((void *)clock_call,top,0,0,0x7ffffd)==0x12345678);
    assert(signal_visits==1&&*anchor->cursor==prior_cursor&&*anchor->in_host==prior_host);
    stack_t signal_state;assert(!sigaltstack(NULL,&signal_state)&&!(signal_state.ss_flags&SS_ONSTACK));
    signal_mode=2;
    int value=inline_jump_save(jump_buffer,1);
    if(!value){inline_tiny_stack((void *)clock_call,top,0,0,0x7ffffd);assert(0);}
    assert(value==37&&signal_visits==2&&*anchor->cursor==prior_cursor&&*anchor->in_host==prior_host);
    assert(!sigaltstack(NULL,&signal_state)&&!(signal_state.ss_flags&SS_ONSTACK));
    assert(!install(10,&previous,NULL));
    // Darwin validates ss_size even when restoring a disabled alternate stack.
    if(old_stack.ss_flags&SS_DISABLE)old_stack.ss_size=new_stack.ss_size;
    assert(!sigaltstack(&old_stack,NULL));assert(!munmap(new_stack.ss_sp,new_stack.ss_size));
    puts("PASS original signal reentry and Bionic siglongjmp restore the suspended native cursor");
    }
    assert(!munmap(tiny,page*2));
    assert(!munmap(image,page*3));
    puts("PASS inline Linux SVC: shared syscall/clock owners, integer/SIMD/status/SP preservation and negative errno");
    puts("PASS 512-byte guarded guest stack and recursive native callback preserve both stack owners");
}

int64_t klj_kernel_native_call(uint64_t operation,uint64_t request,uint64_t bytes){(void)operation;(void)request;(void)bytes;return -38;}
