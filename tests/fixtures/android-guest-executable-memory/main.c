#include <assert.h>
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>
#include <sys/stat.h>
#include "api.h"

static void *thread_context;
static int (*guest_fault)(void *,int,int,void *);
static volatile sig_atomic_t handled_faults,forwarded_faults;
static uintptr_t foreign_start,foreign_end;
static size_t (*frame_size)(void);
static int64_t (*frame_prepare)(void *,size_t,const void *,void *,uint64_t,KljGuestSignalFrame *);
static int64_t (*frame_restore)(const void *,void *,uint64_t *);
static void (*linux_handler)(int,void *,void *);
static volatile sig_atomic_t linux_faults;
static void physical_handler(int signal,siginfo_t *info,void *ucontext){
    int saved=errno;
    if(guest_fault(thread_context,signal,info->si_code,ucontext))handled_faults++;
    else if((uintptr_t)info->si_addr>=foreign_start&&(uintptr_t)info->si_addr<foreign_end){
        // Stand-in for the original co-resident VM owner. The guest boundary
        // must leave this actual foreign JIT write fault untouched.
        ucontext_t *context=ucontext;
        if(*(uint32_t *)(uintptr_t)context->uc_mcontext->__ss.__pc!=0xb9000001u)_exit(93);
        context->uc_mcontext->__ss.__pc+=4;forwarded_faults++;
    }else if(signal==SIGILL && linux_handler){
        size_t size=frame_size();_Alignas(16) unsigned char storage[size];
        struct {int signal,error,code,padding;uint64_t fields[14];} linux_info={.signal=4,.code=info->si_code};
        linux_info.fields[0]=(uintptr_t)info->si_addr;
        KljGuestSignalFrame frame;uint64_t mask=0;
        if(frame_prepare(storage,size,&linux_info,ucontext,mask,&frame))_exit(96);
        linux_handler(4,frame.info,frame.context);
        if(frame_restore(frame.frame,ucontext,&mask)||!(mask&(1UL<<11)))_exit(97);
        linux_faults++;
    }else _exit(94);
    if(errno!=saved)_exit(95);
}

int main(int argc,char **argv){
    assert(argc==3);
    void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!library){fprintf(stderr,"%s\n",dlerror());return 2;}
    int64_t (*protect)(uintptr_t,size_t,int)=dlsym(library,"klj_guest_executable_protect");
    int (*contains)(uintptr_t)=dlsym(library,"klj_guest_executable_contains");
    assert(protect&&contains);
    size_t (*context_size)(void)=dlsym(library,"klj_guest_executable_context_size");
    size_t (*context_alignment)(void)=dlsym(library,"klj_guest_executable_context_alignment");
    int64_t (*context_init)(void *,size_t,uintptr_t,size_t)=dlsym(library,"klj_guest_executable_context_init");
    guest_fault=dlsym(library,"klj_guest_executable_fault");
    assert(context_size&&context_alignment&&context_init&&guest_fault);
    frame_size=dlsym(library,"klj_guest_signal_frame_size");
    frame_prepare=dlsym(library,"klj_guest_signal_frame_prepare");
    frame_restore=dlsym(library,"klj_guest_signal_frame_restore");
    assert(frame_size&&frame_prepare&&frame_restore);
    size_t page=(size_t)getpagesize();
    const size_t resume_bytes=65536;
    void *resume=mmap(NULL,resume_bytes+2*page,PROT_NONE,MAP_PRIVATE|MAP_ANON,-1,0);
    assert(resume!=MAP_FAILED);
    assert(mprotect((char *)resume+page,resume_bytes,PROT_READ|PROT_WRITE)==0);
    assert(posix_memalign(&thread_context,context_alignment(),context_size())==0);
    assert(context_init(thread_context,context_size(),(uintptr_t)resume+page,resume_bytes)==0);
    assert(guest_fault(thread_context,SIGABRT,1,NULL)==0);
    struct sigaction action={.sa_sigaction=physical_handler,.sa_flags=SA_SIGINFO},previous[3];
    int signals[]={SIGBUS,SIGSEGV,SIGILL};sigemptyset(&action.sa_mask);
    for(unsigned index=0;index<3;index++)assert(sigaction(signals[index],&action,&previous[index])==0);
    FILE *file=fopen(argv[2],"rb");assert(file);
    struct stat stat;assert(!fstat(fileno(file),&stat)&&stat.st_size>0&&(size_t)stat.st_size<page);
    void *handler=mmap(NULL,page,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(handler!=MAP_FAILED);
    assert(fread(handler,stat.st_size,1,file)==1);assert(!fclose(file));
    assert(!mprotect(handler,page,PROT_READ|PROT_EXEC));linux_handler=handler;
    uint64_t returned;
    errno=173;
    __asm__ volatile("mov x0,#0x1122\n.inst 0\nmov %0,x0":"=r"(returned)::"x0","memory");
    assert(returned==0xaabb&&linux_faults==1&&errno==173);
    assert(!munmap(handler,page));linux_handler=NULL;
    uint32_t *mapping=mmap(NULL,page,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);
    assert(mapping!=MAP_FAILED);
    void *foreign=mmap(NULL,page,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANON|MAP_JIT,-1,0);
    assert(foreign!=MAP_FAILED);
    foreign_start=(uintptr_t)foreign;foreign_end=foreign_start+page;
    errno=173;assert(contains((uintptr_t)foreign)==0);assert(errno==173);
    assert(contains((uintptr_t)mapping)==0);
    const uint32_t sentinel=0x7b31ca92;
    mapping[page/4-1]=sentinel;
    for(unsigned value=1;value<=32;value++){
        mapping[0]=0x52800000u | (value<<5); // mov w0,#value
        mapping[1]=0xd65f03c0; // ret
        errno=173;
        assert(protect((uintptr_t)mapping,page,PROT_READ|PROT_WRITE|PROT_EXEC)==0);
        assert(errno==173);
        assert(contains((uintptr_t)mapping)==1);
        assert(mapping[page/4-1]==sentinel);
        pthread_jit_write_protect_np(1);
        assert(((unsigned(*)(void))mapping)()==value);
        // Darwin itself recognizes the actual JIT allocation: ordinary
        // mprotect cannot transition it back to writable plain memory.
        assert(mprotect(mapping,page,PROT_READ|PROT_WRITE)==-1);
        assert(errno==EACCES);
        errno=173;
        assert(protect((uintptr_t)mapping,page,PROT_READ|PROT_WRITE)==0);
        assert(errno==173);
        assert(contains((uintptr_t)mapping)==0);
        assert(mapping[page/4-1]==sentinel);
    }
    mapping[0]=0x52800000u | (55u<<5);mapping[1]=0xd65f03c0u;
    mapping[16]=0xb9000001u;mapping[17]=0xd65f03c0u; // str w1,[x0]; ret
    assert(protect((uintptr_t)mapping,page,PROT_READ|PROT_WRITE|PROT_EXEC)==0);
    pthread_jit_write_protect_np(1);
    errno=173;
    mapping[0]=0x52800000u | (56u<<5); // native store changes the JIT view
    __builtin___clear_cache((char *)mapping,(char *)(mapping+1));
    assert(((unsigned(*)(void))mapping)()==56); // original execute-resume trap
    assert(errno==173);
    assert(handled_faults>=3); // write fault, execute fault, exact resume trap
    ((void(*)(uint32_t *,uint32_t))(mapping+16))(mapping,0x52800000u | (57u<<5));
    assert(((unsigned(*)(void))mapping)()==57); // original self-modifying store
    assert(errno==173);
    assert(handled_faults>=4);
    // An actual non-guest JIT write is forwarded to the pre-existing owner.
    __asm__ volatile("mov x0,%0\nmov w1,#1\n.inst 0xb9000001"::"r"(foreign):"x0","x1","memory");
    assert(forwarded_faults==1);
    assert(protect((uintptr_t)mapping,page,PROT_READ|PROT_WRITE)==0);
    errno=173;
    assert(protect((uintptr_t)mapping+1,page,PROT_READ|PROT_WRITE|PROT_EXEC)==-22);
    assert(errno==173);
    assert(protect((uintptr_t)mapping,SIZE_MAX,PROT_READ|PROT_WRITE|PROT_EXEC)==-22);
    assert(errno==173);
    assert(protect((uintptr_t)mapping,0,PROT_READ|PROT_WRITE|PROT_EXEC)==0);
    assert(errno==173);
    assert(protect((uintptr_t)mapping,page,PROT_NONE)==0);
    assert(protect((uintptr_t)mapping,page,PROT_READ|PROT_WRITE)==0);
    assert(mapping[page/4-1]==sentinel);
    assert(munmap(mapping,page)==0);
    assert(contains((uintptr_t)mapping)==0);
    assert(munmap(foreign,page)==0);
    assert(protect((uintptr_t)mapping,page,PROT_READ|PROT_WRITE|PROT_EXEC)==-12);
    assert(errno==173);
    for(unsigned index=0;index<3;index++)assert(sigaction(signals[index],&previous[index],NULL)==0);
    free(thread_context);assert(munmap(resume,resume_bytes+2*page)==0);
    assert(dlclose(library)==0);
    printf("PASS actual native JIT write, execute-resume and self-modifying-store faults reuse original AIM logic; handled=%d forwarded=%d\n",handled_faults,forwarded_faults);
    puts("PASS original AIM executable-memory owner preserves bytes, executes 32 revisions, retires JIT mappings and keeps native errno");
    puts("PASS original Linux signal frame executes Android NDK handler and restores registers and mask");
    return 0;
}
