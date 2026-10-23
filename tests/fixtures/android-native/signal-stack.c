#include "signal-stack.h"
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#define CHECK(x) do{if(!(x)){fprintf(stderr,"FAIL %d: %s\n",__LINE__,#x);exit(1);}}while(0)
static volatile sig_atomic_t delivered;
static uintptr_t low,high;
static void handler(int signal){
    volatile unsigned char location=0;
    klj_android_stack current={0};
    if(signal==SIGUSR2&&(uintptr_t)&location>=low&&(uintptr_t)&location<high&&
       klj_sigaltstack(NULL,&current)==0&&(current.flags&1))delivered++;
}
int main(void){
    alarm(5);
    klj_android_stack previous={0},current={0},input={.size=SIGSTKSZ},disabled={.flags=2};
    input.pointer=malloc(input.size);CHECK(input.pointer);low=(uintptr_t)input.pointer;high=low+input.size;
    CHECK(klj_sigaltstack(&input,&previous)==0);
    CHECK(klj_sigaltstack(NULL,&current)==0&&current.pointer==input.pointer&&current.size==input.size&&current.flags==0);
    struct sigaction action={0},old={0};action.sa_handler=handler;action.sa_flags=SA_ONSTACK;
    CHECK(sigaction(SIGUSR2,&action,&old)==0);CHECK(raise(SIGUSR2)==0&&delivered==1);
    CHECK(sigaction(SIGUSR2,&old,NULL)==0);
    CHECK(klj_sigaltstack(&disabled,&current)==0&&current.pointer==input.pointer);
    CHECK(klj_sigaltstack(NULL,&current)==0&&(current.flags&2));
    CHECK(klj_sigaltstack(&previous,NULL)==0);free(input.pointer);
    puts("PASS Android stack layout, actual alternate-stack delivery, query, disable and restoration");
}
