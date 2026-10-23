#include "process-identity.h"
#include "thread-identity.h"
#include "signal-bridge.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static _Atomic int worker_id,delivered,finish;
static void received(int signal){assert(signal==SIGUSR1);atomic_store(&delivered,1);}
static void *worker(void *unused){
    (void)unused;atomic_store(&worker_id,klj_thread_id());
    while(!atomic_load(&finish))usleep(1000);
    return NULL;
}
int main(void){
    const char **name=klj_process_identity_symbol("__progname");
    const char *(*get_name)(void)=klj_process_identity_symbol("getprogname");
    assert(name&&get_name&&!*get_name());
    assert(klj_process_name("/android/com.example.game")==0);
    assert(!strcmp(*name,"com.example.game")&&get_name()==*name);
    assert(klj_process_name("com.example.game:service")==0);
    assert(!strcmp(get_name(),"com.example.game:service"));
    assert(klj_thread_id()==getpid());
    assert(!klj_signal_thread_id(getpid(),getpid(),0));
    struct sigaction action={0};action.sa_handler=received;sigemptyset(&action.sa_mask);
    assert(!sigaction(SIGUSR1,&action,NULL));
    pthread_t thread;assert(!pthread_create(&thread,NULL,worker,NULL));
    for(unsigned i=0;!atomic_load(&worker_id)&&i<1000;i++)usleep(1000);
    int id=atomic_load(&worker_id);assert(id>0);
    int (*tgkill)(int,int,int)=klj_signal_lookup("tgkill");assert(tgkill);
    assert(!tgkill(getpid(),id,10));
    for(unsigned i=0;!atomic_load(&delivered)&&i<1000;i++)usleep(1000);
    assert(atomic_load(&delivered));
    errno=0;assert(tgkill(getpid()+1,id,0)==-1&&errno==ESRCH);
    errno=0;assert(tgkill(getpid(),id,65)==-1&&errno==EINVAL);
    atomic_store(&finish,1);assert(!pthread_join(thread,NULL));
    errno=0;assert(tgkill(getpid(),id,0)==-1&&errno==ESRCH);
    puts("PASS Android process-name data and live-thread signal ownership");
}
