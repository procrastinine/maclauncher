#define _GNU_SOURCE
#include "probe.h"
#include <android/choreographer.h>
#include <android/looper.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include "libandroid-exports.h"
#include <pthread.h>
#include <time.h>
#include <unistd.h>
static AChoreographer *choreographer;
static __typeof__(&AChoreographer_getInstance) p_AChoreographer_getInstance;
static __typeof__(&AChoreographer_postFrameCallback) p_AChoreographer_postFrameCallback;
static __typeof__(&AChoreographer_postFrameCallbackDelayed) p_AChoreographer_postFrameCallbackDelayed;
static __typeof__(&AChoreographer_postFrameCallback64) p_AChoreographer_postFrameCallback64;
static __typeof__(&AChoreographer_postFrameCallbackDelayed64) p_AChoreographer_postFrameCallbackDelayed64;
static __typeof__(&AChoreographer_postVsyncCallback) p_AChoreographer_postVsyncCallback;
static __typeof__(&AChoreographer_registerRefreshRateCallback) p_AChoreographer_registerRefreshRateCallback;
static __typeof__(&AChoreographer_unregisterRefreshRateCallback) p_AChoreographer_unregisterRefreshRateCallback;
static __typeof__(&AChoreographerFrameCallbackData_getFrameTimeNanos) p_AChoreographerFrameCallbackData_getFrameTimeNanos;
static __typeof__(&AChoreographerFrameCallbackData_getFrameTimelinesLength) p_AChoreographerFrameCallbackData_getFrameTimelinesLength;
static __typeof__(&AChoreographerFrameCallbackData_getPreferredFrameTimelineIndex) p_AChoreographerFrameCallbackData_getPreferredFrameTimelineIndex;
static __typeof__(&AChoreographerFrameCallbackData_getFrameTimelineVsyncId) p_AChoreographerFrameCallbackData_getFrameTimelineVsyncId;
static __typeof__(&AChoreographerFrameCallbackData_getFrameTimelineExpectedPresentationTimeNanos) p_AChoreographerFrameCallbackData_getFrameTimelineExpectedPresentationTimeNanos;
static __typeof__(&AChoreographerFrameCallbackData_getFrameTimelineDeadlineNanos) p_AChoreographerFrameCallbackData_getFrameTimelineDeadlineNanos;
static pthread_key_t key;
static int detached(JavaVM *vm){void *env=(void*)1;return (*vm)->GetEnv(vm,&env,JNI_VERSION_1_6)==JNI_EDETACHED&&!env;}
static int64_t now(void){struct timespec value;clock_gettime(CLOCK_MONOTONIC,&value);return (int64_t)value.tv_sec*1000000000+value.tv_nsec;}
static void callback(ChoreographerProbeCall *call){
 if(gettid()!=call->owner_tid)call->failures++;
 if(call->detached&&!detached(call->vm))call->failures++;
 call->callback_tid=gettid();call->callbacks++;
}
static void frame(int64_t time,void *raw){ChoreographerProbeCall *call=raw;callback(call);if(time<=0)call->failures++;if(++call->reposted<3)p_AChoreographer_postFrameCallback64(choreographer,frame,call);}
static void legacy(long time,void *raw){ChoreographerProbeCall *call=raw;callback(call);call->legacy++;if(time<=0)call->failures++;}
static void delayed(int64_t time,void *raw){ChoreographerProbeCall *call=raw;callback(call);call->delayed++;if(time<=0)call->failures++;}
static void vsync(const AChoreographerFrameCallbackData *data,void *raw){
 ChoreographerProbeCall *call=raw;callback(call);call->vsync++;
 size_t count=p_AChoreographerFrameCallbackData_getFrameTimelinesLength(data),preferred=p_AChoreographerFrameCallbackData_getPreferredFrameTimelineIndex(data);
 if(!count||preferred>=count||p_AChoreographerFrameCallbackData_getFrameTimeNanos(data)<=0||p_AChoreographerFrameCallbackData_getFrameTimelineVsyncId(data,preferred)<=0||p_AChoreographerFrameCallbackData_getFrameTimelineExpectedPresentationTimeNanos(data,preferred)<=0||p_AChoreographerFrameCallbackData_getFrameTimelineDeadlineNanos(data,preferred)<=0)call->failures++;
}
static void refresh(int64_t period,void *raw){ChoreographerProbeCall *call=raw;callback(call);call->refresh++;if(period!=call->expected_period)call->failures++;}
static void refresh_self(int64_t period,void *raw){ChoreographerProbeCall *call=raw;callback(call);call->refresh_self++;if(period!=call->expected_period)call->failures++;p_AChoreographer_unregisterRefreshRateCallback(choreographer,refresh_self,raw);}
/* A deterministic display-change event stays in this fixture transport. */
static void change_period(int64_t period){
 register uint64_t x0 __asm__("x0")=0x4d4c,x1 __asm__("x1")=0x43545001,x2 __asm__("x2")=(uint64_t)period,x3 __asm__("x3")=0,x8 __asm__("x8")=0x48430000;
 __asm__ volatile("svc #0":"+r"(x0):"r"(x1),"r"(x2),"r"(x3),"r"(x8):"x4","x5","x6","x7","x9","x10","x11","x12","x13","x14","x15","x16","x17","x30","memory","cc");
}
static void retired(void *raw){ChoreographerProbeCall *call=raw;if(call->detached&&!detached(call->vm))call->failures++;call->thread_retired++;}
#define CHECK(x) do{if(!(x))return __LINE__;}while(0)
static int exercise(ChoreographerProbeCall *call){
 call->owner_tid=gettid();ALooper *looper=ALooper_forThread();CHECK(looper);
 void *library=dlopen("libandroid.so",RTLD_NOW|RTLD_LOCAL);CHECK(library);
 if(!ALooper_forThread()){fprintf(stderr,"Choreographer owner retired immediately after libandroid dlopen; detached=%d\n",call->detached);return 75;}
 if(!getenv("CHOREOGRAPHER_BASELINE_CONTROL")){
 for(unsigned i=0;i<sizeof(libandroid_exports)/sizeof(*libandroid_exports);i++){
  void *plain=dlsym(library,libandroid_exports[i].name),*versioned=dlvsym(library,libandroid_exports[i].name,libandroid_exports[i].version);
  CHECK(plain&&plain==versioned);
  call->surface_symbols++;
 }
 void *original=dlopen("/system/lib64/libandroid-platform.so",RTLD_NOW|RTLD_LOCAL);CHECK(original);
 dlerror();CHECK(!dlsym(library,"maclauncher_original_missing_api_control")&&dlerror());
 call->missing_lookup=1;
 void *(*work_create)(void)=(void*(*)(void))dlsym(library,"AWorkDuration_create");
 void (*work_release)(void*)=(void(*)(void*))dlsym(library,"AWorkDuration_release");
 void (*work_total)(void*,int64_t)=(void(*)(void*,int64_t))dlsym(library,"AWorkDuration_setActualTotalDurationNanos");
 void (*work_start)(void*,int64_t)=(void(*)(void*,int64_t))dlsym(library,"AWorkDuration_setWorkPeriodStartTimestampNanos");
 void (*work_cpu)(void*,int64_t)=(void(*)(void*,int64_t))dlsym(library,"AWorkDuration_setActualCpuDurationNanos");
 void (*work_gpu)(void*,int64_t)=(void(*)(void*,int64_t))dlsym(library,"AWorkDuration_setActualGpuDurationNanos");
 CHECK(work_create&&work_release&&work_total&&work_start&&work_cpu&&work_gpu);
 Dl_info public_owner={0},original_owner={0};CHECK(dladdr((void*)work_create,&public_owner)&&dladdr(dlsym(original,"AWorkDuration_create"),&original_owner));CHECK(public_owner.dli_fbase!=original_owner.dli_fbase);
 void *work=work_create();CHECK(work);work_start(work,1000);work_total(work,900);work_cpu(work,600);work_gpu(work,300);work_release(work);
 call->fallback_calls=6;
 CHECK(!dlclose(original));
 }
 p_AChoreographer_getInstance=(__typeof__(p_AChoreographer_getInstance))dlsym(library,"AChoreographer_getInstance");CHECK(p_AChoreographer_getInstance);
 p_AChoreographer_postFrameCallback=(__typeof__(p_AChoreographer_postFrameCallback))dlsym(library,"AChoreographer_postFrameCallback");CHECK(p_AChoreographer_postFrameCallback);
 p_AChoreographer_postFrameCallbackDelayed=(__typeof__(p_AChoreographer_postFrameCallbackDelayed))dlsym(library,"AChoreographer_postFrameCallbackDelayed");CHECK(p_AChoreographer_postFrameCallbackDelayed);
 p_AChoreographer_postFrameCallback64=(__typeof__(p_AChoreographer_postFrameCallback64))dlsym(library,"AChoreographer_postFrameCallback64");CHECK(p_AChoreographer_postFrameCallback64);
 p_AChoreographer_postFrameCallbackDelayed64=(__typeof__(p_AChoreographer_postFrameCallbackDelayed64))dlsym(library,"AChoreographer_postFrameCallbackDelayed64");CHECK(p_AChoreographer_postFrameCallbackDelayed64);
 p_AChoreographer_postVsyncCallback=(__typeof__(p_AChoreographer_postVsyncCallback))dlsym(library,"AChoreographer_postVsyncCallback");CHECK(p_AChoreographer_postVsyncCallback);
 p_AChoreographer_registerRefreshRateCallback=(__typeof__(p_AChoreographer_registerRefreshRateCallback))dlsym(library,"AChoreographer_registerRefreshRateCallback");CHECK(p_AChoreographer_registerRefreshRateCallback);
 p_AChoreographer_unregisterRefreshRateCallback=(__typeof__(p_AChoreographer_unregisterRefreshRateCallback))dlsym(library,"AChoreographer_unregisterRefreshRateCallback");CHECK(p_AChoreographer_unregisterRefreshRateCallback);
 p_AChoreographerFrameCallbackData_getFrameTimeNanos=(__typeof__(p_AChoreographerFrameCallbackData_getFrameTimeNanos))dlsym(library,"AChoreographerFrameCallbackData_getFrameTimeNanos");CHECK(p_AChoreographerFrameCallbackData_getFrameTimeNanos);
 p_AChoreographerFrameCallbackData_getFrameTimelinesLength=(__typeof__(p_AChoreographerFrameCallbackData_getFrameTimelinesLength))dlsym(library,"AChoreographerFrameCallbackData_getFrameTimelinesLength");CHECK(p_AChoreographerFrameCallbackData_getFrameTimelinesLength);
 p_AChoreographerFrameCallbackData_getPreferredFrameTimelineIndex=(__typeof__(p_AChoreographerFrameCallbackData_getPreferredFrameTimelineIndex))dlsym(library,"AChoreographerFrameCallbackData_getPreferredFrameTimelineIndex");CHECK(p_AChoreographerFrameCallbackData_getPreferredFrameTimelineIndex);
 p_AChoreographerFrameCallbackData_getFrameTimelineVsyncId=(__typeof__(p_AChoreographerFrameCallbackData_getFrameTimelineVsyncId))dlsym(library,"AChoreographerFrameCallbackData_getFrameTimelineVsyncId");CHECK(p_AChoreographerFrameCallbackData_getFrameTimelineVsyncId);
 p_AChoreographerFrameCallbackData_getFrameTimelineExpectedPresentationTimeNanos=(__typeof__(p_AChoreographerFrameCallbackData_getFrameTimelineExpectedPresentationTimeNanos))dlsym(library,"AChoreographerFrameCallbackData_getFrameTimelineExpectedPresentationTimeNanos");CHECK(p_AChoreographerFrameCallbackData_getFrameTimelineExpectedPresentationTimeNanos);
 p_AChoreographerFrameCallbackData_getFrameTimelineDeadlineNanos=(__typeof__(p_AChoreographerFrameCallbackData_getFrameTimelineDeadlineNanos))dlsym(library,"AChoreographerFrameCallbackData_getFrameTimelineDeadlineNanos");CHECK(p_AChoreographerFrameCallbackData_getFrameTimelineDeadlineNanos);
 AChoreographer *(*get_instance)(void)=(AChoreographer*(*)(void))dlsym(library,"AChoreographer_getInstance");
 void (*post_frame64)(AChoreographer*,AChoreographer_frameCallback64,void*)=(void(*)(AChoreographer*,AChoreographer_frameCallback64,void*))dlsym(library,"AChoreographer_postFrameCallback64");
 choreographer=get_instance();if(!choreographer){dlclose(library);return 73;}
 CHECK(choreographer==p_AChoreographer_getInstance());
 CHECK(!pthread_setspecific(key,call));errno=EINTR;
 post_frame64(choreographer,frame,call);CHECK(errno==EINTR);
 p_AChoreographer_postFrameCallback(choreographer,legacy,call);
 p_AChoreographer_postVsyncCallback(choreographer,vsync,call);
 call->expected_period=16666667;p_AChoreographer_registerRefreshRateCallback(choreographer,refresh,call);
 p_AChoreographer_postFrameCallbackDelayed64(choreographer,delayed,call,35);
 int64_t deadline=now()+2000000000;
 while(call->callbacks<7&&now()<deadline)ALooper_pollOnce(10,NULL,NULL,NULL);
 CHECK(call->callbacks==7&&call->reposted==3&&call->legacy==1&&call->vsync==1&&call->refresh==1&&call->delayed==1&&!call->failures);
 p_AChoreographer_registerRefreshRateCallback(choreographer,refresh,call);
 for(int i=0;i<5;i++)ALooper_pollOnce(10,NULL,NULL,NULL);
 CHECK(call->callbacks==7&&call->refresh==1);
 call->expected_period=8333333;change_period(call->expected_period);
 deadline=now()+2000000000;while(call->callbacks<8&&now()<deadline)ALooper_pollOnce(10,NULL,NULL,NULL);
 CHECK(call->callbacks==8&&call->refresh==2&&!call->failures);
 p_AChoreographer_unregisterRefreshRateCallback(choreographer,refresh,call);
 p_AChoreographer_registerRefreshRateCallback(choreographer,refresh_self,call);
 deadline=now()+2000000000;while(call->callbacks<9&&now()<deadline)ALooper_pollOnce(10,NULL,NULL,NULL);
 CHECK(call->callbacks==9&&call->refresh_self==1&&!call->failures);
 change_period(16666667);
 /* Cancellation retains no guest callback authority after physical exit. */
 p_AChoreographer_postFrameCallbackDelayed(choreographer,legacy,call,60000);
 CHECK(!dlclose(library));
 return 0;
}
static void *worker(void *raw){
 ChoreographerProbeCall *call=raw;if(!detached(call->vm)||!ALooper_prepare(1))return(void*)(uintptr_t)91;
 return(void*)(uintptr_t)exercise(call);
}
int choreographer_original_exercise(ChoreographerProbeCall *call){
 CHECK(!pthread_key_create(&key,retired));int first=exercise(call);if(first)return first;
 ChoreographerProbeCall other={.vm=call->vm,.detached=1};pthread_t thread;
 CHECK(!pthread_create(&thread,NULL,worker,&other));void *result=NULL;CHECK(!pthread_join(thread,&result));
 if(result||other.failures||other.callbacks!=9||other.thread_retired!=1)fprintf(stderr,"Detached Choreographer result=%zu callbacks=%d failures=%d retired=%d symbols=%d fallback=%d missing=%d\n",(size_t)(uintptr_t)result,other.callbacks,other.failures,other.thread_retired,other.surface_symbols,other.fallback_calls,other.missing_lookup);
 CHECK(!result&&!other.failures&&other.callbacks==9&&other.thread_retired==1&&other.surface_symbols==431&&other.fallback_calls==6&&other.missing_lookup==1);
 call->detached=other.callbacks;CHECK(!pthread_key_delete(key));return 0;
}
