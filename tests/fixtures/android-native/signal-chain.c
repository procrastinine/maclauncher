#define main ownership_main
#include "signal-ownership.c"
#undef main
#include <fcntl.h>
#include <sys/stat.h>
#include <libkern/OSCacheControl.h>

static volatile sig_atomic_t chained;
static volatile sig_atomic_t one_argument;
static void native_one_argument(int signal){assert(signal==SIGUSR1);one_argument++;}
static void chained_native(int signal,siginfo_t *info,void *opaque){
    assert(signal==SIGILL&&info&&opaque&&info->si_signo==SIGILL);
    ucontext_t *native=opaque;assert(native->uc_mcontext&&native->uc_mcsize==sizeof(*native->uc_mcontext));
    assert(info->si_addr==(void *)(uintptr_t)native->uc_mcontext->__ss.__pc);
    assert(native->uc_mcontext->__es.__far==0xabcde000);
    assert(native->uc_mcontext->__ss.__x[0]==0x3344);
    native->uc_mcontext->__ss.__x[0]=0xccdd;native->uc_mcontext->__ss.__pc+=4;
    sigaddset(&native->uc_sigmask,SIGUSR1);chained++;
}
__attribute__((naked)) static uint64_t chain_fault(void *previous){
    __asm__("mov x1,x0\nmov x0,#0x1122\n.inst 0\nret");
}
int main(int argc,char **argv){
    assert(argc==2);int fd=open(argv[1],O_RDONLY);assert(fd>=0);struct stat file;assert(!fstat(fd,&file));
    size_t size=(size_t)file.st_size,page=(size_t)getpagesize(),length=(size+page-1)&~(page-1);
    void *code=mmap(NULL,length,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(code!=MAP_FAILED);
    assert(read(fd,code,size)==(ssize_t)size);close(fd);assert(!mprotect(code,length,PROT_READ|PROT_EXEC));sys_icache_invalidate(code,size);
    guest_handler_start=(uintptr_t)code;guest_handler_end=guest_handler_start+size;
    struct sigaction one={.sa_handler=native_one_argument},old_one;
    sigemptyset(&one.sa_mask);assert(!sigaction(SIGUSR1,&one,&old_one));
    bionic_sigaction one_guest={0};assert(!klb_sigaction(10,NULL,&one_guest));
    assert(one_guest.handler!=(void *)native_one_argument&&!(one_guest.flags&KL_SA_SIGINFO));
    ((void (*)(int))one_guest.handler)(10);assert(one_argument==1);
    assert(!klb_sigaction(10,&one_guest,NULL));assert(!raise(SIGUSR1)&&one_argument==2);
    assert(!sigaction(SIGUSR1,&old_one,NULL));
    struct sigaction native={.sa_sigaction=chained_native,.sa_flags=SA_SIGINFO|SA_RESTART},original;
    sigemptyset(&native.sa_mask);assert(!sigaction(SIGILL,&native,&original));
    bionic_sigaction queried={0},prior={0},guest={.flags=KL_SA_SIGINFO,.handler=code};
    assert(!klb_sigaction(4,NULL,&queried)&&queried.handler&&queried.handler!=(void *)chained_native);
    assert(queried.flags&KL_SA_SIGINFO);
    assert(!klb_sigaction(4,&guest,&prior)&&prior.handler==queried.handler);
    real_guest_pc=(uintptr_t)chain_fault;real_guest_end=real_guest_pc+32;real_fault=2;
    sigset_t before,after;assert(!pthread_sigmask(SIG_SETMASK,NULL,&before));
    errno=E2BIG;assert(chain_fault(prior.handler)==0xaabb&&chained==1&&errno==E2BIG);
    assert(!pthread_sigmask(SIG_SETMASK,NULL,&after)&&sigismember(&after,SIGUSR1)==1);
    assert(!pthread_sigmask(SIG_SETMASK,&before,NULL));
    assert(!klb_sigaction(4,&prior,NULL));
    struct sigaction restored;assert(!sigaction(SIGILL,NULL,&restored)&&restored.sa_sigaction==chained_native);
    assert(!sigaction(SIGILL,&original,NULL));assert(!munmap(code,length));
    puts("PASS original Android handler chains saved Darwin disposition with native context, register/mask edits, errno and restoration");
}
