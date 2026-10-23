#include <assert.h>
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/ucontext.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include "../../../src/modules/android/native/executable-memory/api.h"
#include <unistd.h>

static volatile sig_atomic_t native_faults;
static unsigned rejected_preparations,finished_rejections;
static int64_t reject_publication(uintptr_t address,void *staging,size_t size){
    assert(address&&staging&&size);*(uint32_t *)staging=0;
    rejected_preparations++;return -22;
}
static void finish_rejection(uintptr_t address,void *staging,size_t size,int success){
    assert(address&&staging&&size&&!success);finished_rejections++;
}
static void native_handler(int signal,siginfo_t *info,void *opaque){
    assert(signal==SIGILL&&info&&opaque);
    ucontext_t *context=opaque;
    assert(*(uint32_t *)(uintptr_t)context->uc_mcontext->__ss.__pc==0);
    context->uc_mcontext->__ss.__pc+=4;
    native_faults++;
}

int main(int argc,char **argv){
    assert(argc==4);
    void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!library){fprintf(stderr,"%s\n",dlerror());return 2;}
    int (*configure)(const char *)=dlsym(library,"klj_process_ids_configure");assert(configure&&configure(argv[3])>0);
    void *(*lookup)(const char *)=dlsym(library,"kl_shim_lookup");assert(lookup);
    void *(*map)(void *,size_t,int,int,int,off_t)=lookup("mmap");
    int (*protect)(void *,size_t,int)=lookup("mprotect");
    int (*unmap)(void *,size_t)=lookup("munmap");assert(map&&protect&&unmap);
    struct sigaction native={.sa_sigaction=native_handler,.sa_flags=SA_SIGINFO},previous;
    sigemptyset(&native.sa_mask);assert(!sigaction(SIGILL,&native,&previous));
    size_t page=(size_t)getpagesize();
    uint32_t *code=map(NULL,page,7,0x22,-1,0); // original Android private/anonymous RWX
    if(code==MAP_FAILED)perror("Android executable mapping");
    assert(code!=MAP_FAILED);
    errno=173;
    code[0]=0x52800000u|(71u<<5);code[1]=0xd65f03c0u;
    __builtin___clear_cache((char *)code,(char *)(code+2));
    assert(((unsigned(*)(void))code)()==71&&errno==173);
    assert(!protect(code,page,PROT_READ|PROT_WRITE));
    code[0]=0x52800000u|(72u<<5);
    assert(!protect(code,page,PROT_READ|PROT_EXEC));
    assert(((unsigned(*)(void))code)()==72);
    assert(!protect(code,page,7));
    pthread_jit_write_protect_np(1);
    code[0]=0x52800000u|(73u<<5);
    __builtin___clear_cache((char *)code,(char *)(code+1));
    assert(((unsigned(*)(void))code)()==73);
    int (*pointer_enter)(unsigned long long)=dlsym(library,"klj_guest_thread_pointer_enter");
    int (*pointer_offset)(void)=dlsym(library,"klj_guest_thread_pointer_offset");
    assert(pointer_enter&&pointer_offset&&!pointer_enter(0x7b31ca92));
    uintptr_t expected_tls=(uintptr_t)pthread_getspecific((pthread_key_t)(pointer_offset()/8));
    assert(expected_tls);
    int64_t (*prepared)(uintptr_t,size_t,int,KljPrepareExecutable,KljFinishExecutable)=dlsym(library,"klj_guest_executable_protect_prepared");
    assert(prepared&&!protect(code,page,PROT_READ|PROT_WRITE));
    uint32_t original=code[0];errno=173;
    assert(prepared((uintptr_t)code,page,PROT_READ|PROT_EXEC,reject_publication,finish_rejection)==-22&&errno==173);
    assert(rejected_preparations==1&&finished_rejections==1&&code[0]==original);
    code[0]=original; // A rejected publication also retains writable protection.
    uintptr_t pools[4];size_t pool_count=0;
    const uint32_t bodies[][3]={
        {0xd53bd040u,0xd65f03c0u,0xd503201fu}, // MRS x0,TPIDR_EL0; RET
        {0xaa0003f2u,0x91001e40u,0xd65f03c0u}, // MOV x18,x0; ADD x0,x18,#7; RET
        {0x90000012u,0xaa1203e0u,0xd65f03c0u}, // ADRP x18,current page; MOV x0,x18; RET
        {0xd2801588u,0xd4000001u,0xd65f03c0u}, // Linux getpid SVC
    };
    int (*guest_pid)(void)=lookup("getpid");assert(guest_pid);
    for(size_t index=0;index<4;index++){
        assert(!protect(code,page,7));pthread_jit_write_protect_np(1);
        for(size_t word=0;word<3;word++)code[word]=bodies[index][word];
        __builtin___clear_cache((char *)code,(char *)(code+3));
        errno=173;assert(!protect(code,page,PROT_READ|PROT_EXEC)&&errno==173);
        uintptr_t actual=((uintptr_t(*)(uintptr_t))code)(41),expected=
            index==0?expected_tls:index==1?48:index==2?((uintptr_t)code&~(uintptr_t)4095):(uintptr_t)guest_pid();
        if(actual!=expected){fprintf(stderr,"publication case%zu actual=%#lx expected=%#lx\n",index,(unsigned long)actual,(unsigned long)expected);return 22;}
        size_t site=index==3?1:0;uint32_t instruction=code[site];
        assert((instruction&0xfc000000u)==0x14000000u);
        int64_t delta=((int32_t)(instruction<<6)>>4);
        pools[pool_count++]=(uintptr_t)&code[site]+delta;
    }
    void *(*load)(const char *,int)=lookup("dlopen");
    void *(*symbol)(void *,const char *)=lookup("dlsym");
    int (*unload)(void *)=lookup("dlclose");
    const char *(*error)(void)=lookup("dlerror");assert(load&&symbol&&unload&&error);
    void *image=load(argv[2],2);
    if(!image){fprintf(stderr,"%s\n",error());return 3;}
    typedef struct {int32_t flags,pad;void *handler;uint64_t mask;void *restorer;} AndroidAction;
    int (*action)(int,const AndroidAction *,AndroidAction *)=lookup("sigaction");assert(action);
    AndroidAction guest={.flags=4,.handler=symbol(image,"linux_handler")},prior;
    uint64_t (*fault)(void)=symbol(image,"linux_fault");assert(guest.handler&&fault);
    sigset_t old_mask,mask;assert(!pthread_sigmask(SIG_SETMASK,NULL,&old_mask));
    assert(!action(4,&guest,&prior));
    uint64_t value=fault();
    if(value!=0xaabb||native_faults)fprintf(stderr,"Linux handler returned %#llx, native faults %d\n",(unsigned long long)value,native_faults);
    assert(value==0xaabb&&native_faults==0);
    assert(!pthread_sigmask(SIG_SETMASK,NULL,&mask)&&sigismember(&mask,SIGUSR2)==1);
    assert(!pthread_sigmask(SIG_SETMASK,&old_mask,NULL));
    assert(!action(4,&prior,NULL));assert(!unload(image));
    __asm__ volatile(".inst 0":::"memory");
    assert(native_faults==1); // native VM handler survives actual guest JIT setup
    assert(!unmap(code,page));
    for(size_t index=0;index<pool_count;index++){
        mach_vm_address_t address=pools[index];mach_vm_size_t length=0;
        vm_region_basic_info_data_64_t region;mach_msg_type_number_t count=VM_REGION_BASIC_INFO_COUNT_64;
        mach_port_t object=MACH_PORT_NULL;
        kern_return_t result=mach_vm_region(mach_task_self(),&address,&length,VM_REGION_BASIC_INFO_64,(vm_region_info_t)&region,&count,&object);
        if(object!=MACH_PORT_NULL)mach_port_deallocate(mach_task_self(),object);
        assert(result==KERN_INVALID_ADDRESS||(result==KERN_SUCCESS&&address>pools[index]));
    }
    assert(!sigaction(SIGILL,&previous,NULL));
    puts("PASS actual JVM mmap/mprotect imports execute Android JIT and retain native signal ownership");
    puts("PASS actual ELF SA_SIGINFO registration preserves Android NDK register and signal-mask edits");
    puts("PASS final JVM code publication preserves guest TLS, x18, PC-relative addresses, Linux SVC and veneer retirement");
    puts("PASS failed code preparation preserves original bytes, writable protection and native errno");
    return 0;
}
