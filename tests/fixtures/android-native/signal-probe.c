#include <dlfcn.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

typedef struct {int32_t flags,pad;void *handler;uint64_t mask;void *restorer;} AndroidAction;
typedef int (*Action)(int,const AndroidAction *,AndroidAction *);
static sigjmp_buf jump;
static volatile sig_atomic_t native_calls,guest_calls,delivered;
#define CHECK(x) do{if(!(x)){fprintf(stderr,"FAIL %d: %s\n",__LINE__,#x);exit(1);}}while(0)
static void native_handler(int signal,siginfo_t *info,void *context){
    if(signal==SIGILL&&info&&info->si_signo==SIGILL&&context)native_calls++;
}
static void guest_handler(int signal){if(signal==SIGILL){guest_calls++;siglongjmp(jump,1);}}
static void number_handler(int signal){delivered=signal;}
int main(int argc,char **argv){
    CHECK(argc==2);alarm(10);
    void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);CHECK(library);
    void *(*lookup)(const char *)=dlsym(library,"kl_shim_lookup");CHECK(lookup);
    Action action=(Action)lookup("sigaction");CHECK(action);
    struct sigaction native={0},prior;
    native.sa_sigaction=native_handler;native.sa_flags=SA_SIGINFO|SA_RESTART;
    CHECK(sigaction(SIGILL,&native,&prior)==0);
    AndroidAction supplied={.handler=(void *)guest_handler},saved,queried;
    CHECK(action(SIGILL,&supplied,&saved)==0);
    // The previous native disposition is returned as the runtime's SA_SIGINFO chain entry.
    CHECK(saved.handler&&saved.handler!=(void *)guest_handler&&(saved.flags&4));
    CHECK(action(SIGILL,NULL,&queried)==0&&queried.handler==supplied.handler&&!(queried.flags&4));
    // A fault whose PC is outside guest images belongs to the native chain by design,
    // so this host binary cannot raise one for the guest handler.
    CHECK(guest_calls==0);
    CHECK(action(SIGILL,&saved,NULL)==0);
    CHECK(raise(SIGILL)==0&&native_calls==1);
    CHECK(sigaction(SIGILL,&prior,NULL)==0);
    struct sigaction reserved,before;
    CHECK(sigaction(SIGUSR2,NULL,&reserved)==0);
    supplied=(AndroidAction){.handler=(void *)number_handler};
    CHECK(action(31,&supplied,&saved)==0);
    CHECK(sigaction(SIGUSR2,NULL,&before)==0&&reserved.sa_sigaction==before.sa_sigaction);
    CHECK(raise(SIGSYS)==0&&delivered==31);
    CHECK(action(31,&saved,NULL)==0);
    int (*empty)(uint64_t *)=lookup("sigemptyset");
    int (*add)(uint64_t *,int)=lookup("sigaddset");
    int (*member)(const uint64_t *,int)=lookup("sigismember");
    int (*mask)(int,const uint64_t *,uint64_t *)=lookup("pthread_sigmask");
    int (*send)(int)=lookup("raise");
    CHECK(empty&&add&&member&&mask&&send);
    uint64_t bits=UINT64_MAX,oldmask=0;CHECK(empty(&bits)==0&&bits==0);
    CHECK(add(&bits,10)==0&&bits==(UINT64_C(1)<<9)&&member(&bits,10)==1);
    CHECK(action(10,&supplied,&saved)==0);
    CHECK(mask(0,&bits,&oldmask)==0);
    sigset_t actual;CHECK(pthread_sigmask(SIG_SETMASK,NULL,&actual)==0&&sigismember(&actual,SIGUSR1)==1);
    delivered=0;CHECK(send(10)==0&&delivered==0);
    CHECK(mask(1,&bits,NULL)==0&&delivered==10);
    CHECK(mask(2,&oldmask,NULL)==0&&action(10,&saved,NULL)==0);
    puts("PASS recoverable instruction probes and restored native signal-context ownership");
    puts("PASS Linux signal numbers, full-width masks, native handler isolation and delivery");
    return 0;
}
