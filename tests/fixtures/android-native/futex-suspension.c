#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

#define CHECK(value) do{if(!(value)){fprintf(stderr,"FAIL %d: %s\n",__LINE__,#value);abort();}}while(0)
static _Thread_local int interrupt_lock,interrupt_return;
static _Atomic int suspended,resume_handler,independent_done,finished,kernel_entered;
static int32_t word,unrelated;
static volatile sig_atomic_t asynchronous_calls,fault_calls;
static void counted_signal(int signal){if(signal==SIGILL)fault_calls++;else asynchronous_calls++;}
static void handler(int signal){
    CHECK(signal==SIGUSR1);atomic_store(&suspended,1);
    sigset_t waiting;sigfillset(&waiting);sigdelset(&waiting,SIGUSR2);
    while(!atomic_load(&resume_handler))sigsuspend(&waiting);
}
static void resume_signal(int signal){(void)signal;}
/* Force the stop at the exact formerly unsafe point, after the production
 * metadata mutex is acquired. The real POSIX mask must defer it until unlock.
 * No production hook or timing-dependent signal storm is needed. */
static int observed_lock(pthread_mutex_t *mutex){
    int result=pthread_mutex_lock(mutex);
    if(!result&&interrupt_lock){interrupt_lock=0;CHECK(!pthread_kill(pthread_self(),SIGUSR1));}
    return result;
}
extern int __ulock_wait2(uint32_t,void*,uint64_t,uint64_t,uint64_t);
static int observed_wait(uint32_t operation,void *address,uint64_t value,uint64_t timeout,uint64_t value2){
    if(interrupt_return)atomic_store(&kernel_entered,1);
    int result=__ulock_wait2(operation,address,value,timeout,value2);
    if(interrupt_return){interrupt_return=0;interrupt_lock=1;}
    return result;
}
#define pthread_mutex_lock observed_lock
#define __ulock_wait2 observed_wait
#include FUTEX_SOURCE
#undef pthread_mutex_lock
#undef __ulock_wait2

static int64_t nanos(void){struct timespec now;CHECK(!clock_gettime(CLOCK_UPTIME_RAW,&now));return (int64_t)now.tv_sec*1000000000+now.tv_nsec;}
static int await(_Atomic int *value,int milliseconds){
    int64_t end=nanos()+(int64_t)milliseconds*1000000;
    while(!atomic_load(value)&&nanos()<end)sched_yield();
    return atomic_load(value);
}
static void *independent(void *unused){
    (void)unused;CHECK(klj_futex(&unrelated,KLJ_WAKE|KLJ_PRIVATE,1,NULL,NULL,0)==0);
    atomic_store(&independent_done,1);return NULL;
}
static void *enroll(void *unused){
    (void)unused;interrupt_lock=1;
    CHECK(klj_futex(&word,KLJ_WAIT|KLJ_PRIVATE,0,NULL,NULL,0)==0);
    atomic_store(&finished,1);return NULL;
}
static void *wake(void *unused){
    (void)unused;interrupt_lock=1;
    CHECK(klj_futex(&word,KLJ_WAKE|KLJ_PRIVATE,1,NULL,NULL,0)==1);
    atomic_store(&finished,1);return NULL;
}
static void *plain_wait(void *unused){
    (void)unused;CHECK(klj_futex(&word,KLJ_WAIT|KLJ_PRIVATE,0,NULL,NULL,0)==0);return NULL;
}
static void *retiring_wait(void *unused){
    (void)unused;interrupt_return=1;
    CHECK(klj_futex(&word,KLJ_WAIT|KLJ_PRIVATE,0,NULL,NULL,0)==0);return NULL;
}
static void permit(pthread_t target){atomic_store(&resume_handler,1);CHECK(!pthread_kill(target,SIGUSR2));}
static void prove(pthread_t target){
    CHECK(await(&suspended,1000));pthread_t other;CHECK(!pthread_create(&other,NULL,independent,NULL));
    int progressed=await(&independent_done,500);
    if(!progressed)permit(target);
    CHECK(!pthread_join(other,NULL));CHECK(progressed);
}
int main(void){
    alarm(8);struct sigaction action={.sa_handler=counted_signal};sigemptyset(&action.sa_mask);
    CHECK(!sigaction(SIGILL,&action,NULL));CHECK(!sigaction(SIGWINCH,&action,NULL));
    sigset_t original,before,after,blocked;sigemptyset(&blocked);sigaddset(&blocked,SIGHUP);
    CHECK(!pthread_sigmask(SIG_BLOCK,&blocked,&original));CHECK(!pthread_sigmask(SIG_SETMASK,NULL,&before));
    KljSignalCritical outer,inner;klj_signal_critical_enter(&outer);
    CHECK(!raise(SIGILL)&&fault_calls==1);CHECK(!raise(SIGWINCH)&&asynchronous_calls==0);
    klj_signal_critical_enter(&inner);klj_signal_critical_leave(&inner);CHECK(asynchronous_calls==0);
    klj_signal_critical_leave(&outer);CHECK(asynchronous_calls==1);
    CHECK(!pthread_sigmask(SIG_SETMASK,NULL,&after)&&before==after);
    CHECK(!pthread_sigmask(SIG_SETMASK,&original,NULL));
    action.sa_handler=handler;
    CHECK(!sigaction(SIGUSR1,&action,NULL));action.sa_handler=resume_signal;CHECK(!sigaction(SIGUSR2,&action,NULL));
    pthread_t target;CHECK(!pthread_create(&target,NULL,enroll,NULL));prove(target);
    CHECK(klj_futex(&word,KLJ_WAKE|KLJ_PRIVATE,1,NULL,NULL,0)==1);
    permit(target);CHECK(!pthread_join(target,NULL));CHECK(atomic_load(&finished));
    atomic_store(&suspended,0);atomic_store(&resume_handler,0);atomic_store(&independent_done,0);atomic_store(&finished,0);
    pthread_t waiter;CHECK(!pthread_create(&waiter,NULL,plain_wait,NULL));
    /* Requeue to another word and back proves enrollment without waking it. */
    int64_t end=nanos()+1000000000;
    while(!klj_futex(&word,KLJ_REQUEUE|KLJ_PRIVATE,0,(void*)1,&unrelated,0)){CHECK(nanos()<end);sched_yield();}
    CHECK(klj_futex(&unrelated,KLJ_REQUEUE|KLJ_PRIVATE,0,(void*)1,&word,0)==1);
    CHECK(!pthread_create(&target,NULL,wake,NULL));prove(target);
    permit(target);CHECK(!pthread_join(target,NULL));CHECK(!pthread_join(waiter,NULL));CHECK(atomic_load(&finished));
    atomic_store(&suspended,0);atomic_store(&resume_handler,0);atomic_store(&independent_done,0);
    CHECK(!pthread_create(&target,NULL,retiring_wait,NULL));CHECK(await(&kernel_entered,1000));end=nanos()+1000000000;
    while(!klj_futex(&word,KLJ_WAKE|KLJ_PRIVATE,1,NULL,NULL,0)){CHECK(nanos()<end);sched_yield();}
    prove(target);permit(target);CHECK(!pthread_join(target,NULL));
    puts("PASS guest suspension during futex enrollment, wake and retirement");return 0;
}
