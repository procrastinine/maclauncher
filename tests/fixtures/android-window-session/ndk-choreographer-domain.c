#include <assert.h>
#include <dlfcn.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>

typedef struct AChoreographer AChoreographer;
extern void *kl_upstream_ndk_lookup(const char *);
extern AChoreographer *AChoreographer_getInstance(void);
extern void AChoreographer_postFrameCallback64(AChoreographer *,void(*)(int64_t,void *),void *);
extern void AChoreographer_postFrameCallbackDelayed64(AChoreographer *,void(*)(int64_t,void *),void *,uint32_t);
extern void AChoreographer_registerRefreshRateCallback(AChoreographer *,void(*)(int64_t,void *),void *);
extern void AChoreographer_unregisterRefreshRateCallback(AChoreographer *,void(*)(int64_t,void *),void *);
extern void klj_ndk_choreographer_set_wakeup(void(*)(void *),void *);
extern void klj_ndk_choreographer_tick(int64_t,int64_t,int64_t,int64_t);
extern int klj_ndk_choreographer_needs_frames(void);
extern int klj_ndk_choreographer_wait_millis(int);
extern int klj_ndk_choreographer_inflight(void);

/* Deterministically represent a Mac that has slept. Only this test process's
 * raw Darwin monotonic clock gains suspended time; Mach/CV uptime is unchanged. */
int clock_gettime(clockid_t clock,struct timespec *out){
    static int (*original)(clockid_t,struct timespec *);
    if(!original){original=dlsym(RTLD_NEXT,"clock_gettime");assert(original);}
    int result=original(clock,out);
    if(!result&&clock==CLOCK_MONOTONIC)out->tv_sec+=3600;
    return result;
}
static int64_t uptime(void){mach_timebase_info_data_t scale;assert(mach_timebase_info(&scale)==KERN_SUCCESS);return (int64_t)((__uint128_t)mach_absolute_time()*scale.numer/scale.denom);}
static unsigned wakes;
static void wake(void *value){assert(value==&wakes);wakes++;}
static int calls,refreshes;
static int64_t expected;
static AChoreographer *owner;
static pthread_t thread;
static void frame(int64_t time,void *value){
    assert(value==&calls&&pthread_equal(thread,pthread_self()));assert(time==expected);
    assert(klj_ndk_choreographer_inflight()==1);calls++;
    if(calls<3)AChoreographer_postFrameCallback64(owner,frame,&calls);
}
static void refresh(int64_t period,void *value){assert(value==&refreshes&&period==16666667);refreshes++;}
static void pulse(int64_t sequence){expected=uptime();klj_ndk_choreographer_tick(sequence,expected,expected+16666667,16666667);}
static void dispatch_until(int(*poll)(int,int*,int*,void**),int *counter,int target){
    int64_t limit=uptime()+200000000;
    while(*counter<target&&uptime()<limit)poll(10,NULL,NULL,NULL);
    assert(*counter==target);
}
static void *run(void *unused){
    (void)unused;thread=pthread_self();
    void *(*prepare)(int)=kl_upstream_ndk_lookup("ALooper_prepare");
    int (*poll)(int,int*,int*,void**)=kl_upstream_ndk_lookup("ALooper_pollOnce");
    assert(prepare&&poll&&prepare(1));owner=AChoreographer_getInstance();assert(owner&&owner==AChoreographer_getInstance());
    AChoreographer_postFrameCallback64(owner,frame,&calls);
    for(int i=1;i<=3;i++){assert(klj_ndk_choreographer_needs_frames());pulse(i);dispatch_until(poll,&calls,i);}
    assert(!klj_ndk_choreographer_needs_frames());
    AChoreographer_registerRefreshRateCallback(owner,refresh,&refreshes);dispatch_until(poll,&refreshes,1);
    AChoreographer_unregisterRefreshRateCallback(owner,refresh,&refreshes);
    AChoreographer_postFrameCallbackDelayed64(owner,frame,&calls,80);
    int wait=klj_ndk_choreographer_wait_millis(1000);assert(wait>0&&wait<=80);
    pulse(4);poll(0,NULL,NULL,NULL);assert(calls==3);
    struct timespec delay={0,90000000};nanosleep(&delay,NULL);pulse(5);dispatch_until(poll,&calls,4);
    assert(!klj_ndk_choreographer_needs_frames()&&klj_ndk_choreographer_inflight()==0);
    return NULL;
}
int main(void){
    klj_ndk_choreographer_set_wakeup(wake,&wakes);
    pthread_t worker;assert(!pthread_create(&worker,NULL,run,NULL));assert(!pthread_join(worker,NULL));
    assert(wakes>0&&!klj_ndk_choreographer_needs_frames()&&!klj_ndk_choreographer_inflight());
    klj_ndk_choreographer_set_wakeup(NULL,NULL);
    puts("PASS native Choreographer uptime, delayed/reposted callbacks, original ALooper delivery and retirement after suspended-time divergence");
}
