#include "scheduler.h"
#include "clock/display-clock.h"
#include "host-callbacks.h"
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
extern void kl_host_scheduler_notify(void);

/* The real scheduler and Mach dispatcher run unchanged. The display mailbox,
 * JNI call receivers and SDL event sink are deterministic physical doubles. */
static atomic_int java_needed,native_needed,demanded,java_frames,native_frames,events,detached,shutdowns;
static atomic_int hold_detach,detaching,allow_detach,java_active,native_active,owner_pumps,idle_pumps;
static int expected_error,pending_error,blocked_callback;
static atomic_uint_fast64_t published;
static pthread_t owner_thread;
static void (*wake)(void*);static void *wake_owner;
static void (*native_wake)(void*);static void *native_owner;
struct KLDisplayClock {uint64_t ui_cursor;};static struct KLDisplayClock clock_state;
static void check_tick(uint64_t sequence,uint64_t callback,uint64_t output,uint64_t interval){assert(sequence==atomic_load(&published));assert(callback==sequence*1000);assert(output==callback+100);assert(interval==100);assert(!pthread_equal(owner_thread,pthread_self()));}
KLDisplayClock* kl_display_clock_create(void*w,char*e,size_t n){(void)w;(void)e;(void)n;return &clock_state;}
int kl_display_clock_set_demand(KLDisplayClock*c,int wanted,char*e,size_t n){(void)c;(void)e;(void)n;atomic_store(&demanded,wanted);return 1;}
int kl_display_clock_set_wake(KLDisplayClock*c,void(*call)(void*),void*p,char*e,size_t n){(void)c;(void)e;(void)n;wake=call;wake_owner=p;return 1;}
int kl_display_clock_update_display(KLDisplayClock*c,void*w,char*e,size_t n){(void)c;(void)w;(void)e;(void)n;return 1;}
static int read_tick(uint64_t*cursor,KLDisplayTick*t){uint64_t sequence=atomic_load(&published);if(sequence==*cursor)return 0;*cursor=sequence;*t=(KLDisplayTick){.sequence=sequence,.callbackTimeNanos=sequence*1000,.predictedOutputTimeNanos=sequence*1000+100,.intervalNanos=100,.displayId=7};return 1;}
int kl_display_clock_sample(KLDisplayClock*c,uint64_t*cursor,KLDisplayTick*t){(void)c;return read_tick(cursor,t);}
int kl_display_clock_poll(KLDisplayClock*c,KLDisplayTick*t){return read_tick(&c->ui_cursor,t);}
int kl_display_clock_destroy(KLDisplayClock*c,char*e,size_t n){(void)c;(void)e;(void)n;assert(!atomic_load(&demanded));wake=NULL;wake_owner=NULL;return 1;}
uint64_t kl_display_clock_monotonic_now(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return (uint64_t)t.tv_sec*1000000000+t.tv_nsec;}
void klj_ndk_choreographer_set_wakeup(void(*call)(void*),void*p){native_wake=call;native_owner=p;}
int klj_ndk_choreographer_needs_frames(void){return atomic_load(&native_needed);}
int klj_ndk_choreographer_wait_millis(int maximum){return maximum;}
void klj_ndk_choreographer_tick(int64_t s,int64_t c,int64_t o,int64_t i){check_tick(s,c,o,i);atomic_fetch_add(&native_frames,1);}
int klj_ndk_choreographer_inflight(void){return atomic_load(&native_active);}
void klj_ndk_choreographer_detach(void){native_wake=NULL;native_owner=NULL;atomic_fetch_add(&detached,1);}
Uint32 SDL_RegisterEvents(int n){assert(n==1);return 100;}
bool SDL_PushEvent(SDL_Event*event){assert(event->type==100);atomic_fetch_add(&events,1);return true;}
void SDL_FlushEvent(Uint32 type){assert(type==100);}

static jboolean no_exception(JNIEnv*e){(void)e;return pending_error?JNI_TRUE:JNI_FALSE;}
static jthrowable no_throwable(JNIEnv*e){(void)e;return pending_error?(jthrowable)(uintptr_t)1:NULL;}
static void delete_local(JNIEnv*e,jobject o){(void)e;(void)o;}
static void clear(JNIEnv*e){(void)e;pending_error=0;}
static jclass unexpected_error(JNIEnv*e,const char*n){(void)e;if(expected_error)return(jclass)(uintptr_t)1;fprintf(stderr,"Unexpected JNI error: %s\n",n);abort();}
static jint throw_new(JNIEnv*e,jclass c,const char*text){(void)e;(void)c;(void)text;assert(expected_error);pending_error=1;return JNI_OK;}
static jint throw_existing(JNIEnv*e,jthrowable t){(void)e;assert(expected_error&&t);pending_error=1;return JNI_OK;}
static jint attach(JavaVM*vm,void**e,void*args);
static jint detach(JavaVM*vm){(void)vm;if(atomic_load(&hold_detach)){atomic_store(&detaching,1);while(!atomic_load(&allow_detach))usleep(1000);}return JNI_OK;}
static const struct JNIInvokeInterface_ vm_functions={.AttachCurrentThreadAsDaemon=attach,.DetachCurrentThread=detach};static JavaVM machine=&vm_functions;
static jint get_vm(JNIEnv*e,JavaVM**vm){(void)e;*vm=&machine;return JNI_OK;}
static const struct JNINativeInterface_ env_functions={.ExceptionCheck=no_exception,.ExceptionOccurred=no_throwable,.ExceptionClear=clear,.DeleteLocalRef=delete_local,.FindClass=unexpected_error,.GetJavaVM=get_vm,.ThrowNew=throw_new,.Throw=throw_existing};static JNIEnv environment=&env_functions;
static jint attach(JavaVM*vm,void**e,void*args){(void)vm;(void)args;*e=&environment;return JNI_OK;}
KLHost_java_lang_Throwable kl_host_bind_KLHost_java_lang_Throwable(JNIEnv*e,KLHostCallbacks*c,jobject o){(void)e;(void)c;return(KLHost_java_lang_Throwable){o};}
KLHost_java_lang_Runnable kl_host_bind_KLHost_java_lang_Runnable(JNIEnv*e,KLHostCallbacks*c,jobject o){(void)e;(void)c;return(KLHost_java_lang_Runnable){o};}
void kl_host_suppressed(JNIEnv*e,KLHostCallbacks*c,KLHost_java_lang_Throwable a,KLHost_java_lang_Throwable b){(void)e;(void)c;(void)a;(void)b;abort();}
jboolean kl_host_needs_frames(JNIEnv*e,KLHostCallbacks*c){(void)e;(void)c;return atomic_load(&java_needed);}
jboolean kl_host_display_inflight(JNIEnv*e,KLHostCallbacks*c){(void)e;(void)c;return atomic_load(&java_active)?JNI_TRUE:JNI_FALSE;}
void kl_host_dispatch_frame(JNIEnv*e,KLHostCallbacks*c,jlong s,jlong callback,jlong output,jlong interval,jlong display){(void)e;(void)c;check_tick(s,callback,output,interval);assert(display==7);atomic_fetch_add(&java_frames,1);}
void kl_host_present_frame(JNIEnv*e,KLHostCallbacks*c){(void)e;(void)c;}
jint kl_host_display_wait(JNIEnv*e,KLHostCallbacks*c,jint maximum){(void)e;(void)c;return maximum;}
void kl_host_display_shutdown(JNIEnv*e,KLHostCallbacks*c){(void)e;(void)c;atomic_fetch_add(&shutdowns,1);}
KLHost_maclauncher_android_bridge_FrameWakeup kl_host_wakeup_create(JNIEnv*e,KLHostCallbacks*c,jlong owner){(void)e;(void)c;return(KLHost_maclauncher_android_bridge_FrameWakeup){(jobject)(uintptr_t)owner};}
void kl_host_display_wakeup(JNIEnv*e,KLHostCallbacks*c,KLHost_java_lang_Runnable action){(void)e;(void)c;(void)action;}

static void until(atomic_int*value,int expected){uint64_t deadline=kl_display_clock_monotonic_now()+1000000000;while(atomic_load(value)!=expected&&kl_display_clock_monotonic_now()<deadline)usleep(1000);assert(atomic_load(value)==expected);}
static void publish(uint64_t sequence){atomic_store(&published,sequence);wake(wake_owner);until(&java_frames,(int)sequence);until(&native_frames,(int)sequence);}
static void owner_tasks(JNIEnv*env,void*context){
 (void)env;(void)context;
 if(blocked_callback){atomic_fetch_add(&owner_pumps,1);return;}
 if(atomic_exchange(&java_active,0)||atomic_exchange(&native_active,0))atomic_fetch_add(&owner_pumps,1);
 else atomic_fetch_add(&idle_pumps,1);
}
static void* release_dispatcher(void*unused){(void)unused;until(&detaching,1);usleep(20000);atomic_store(&allow_detach,1);return NULL;}
static void retirement_wait(int callback_kind){
 KLHostCallbacks*callbacks=(KLHostCallbacks*)(uintptr_t)1;
 atomic_store(&hold_detach,1);atomic_store(&detaching,0);atomic_store(&allow_detach,0);atomic_store(&owner_pumps,0);atomic_store(&idle_pumps,0);
 atomic_store(&java_active,callback_kind==1);atomic_store(&native_active,callback_kind==2);
 KLHostScheduler*s=kl_host_scheduler_create(&environment,callbacks);assert(s);assert(kl_host_scheduler_window(&environment,s,(void*)1));
 pthread_t release;assert(!pthread_create(&release,NULL,release_dispatcher,NULL));
 assert(kl_host_scheduler_quiesce_pump(&environment,s,1000,owner_tasks,NULL));assert(!pthread_join(release,NULL));
 assert(atomic_load(&idle_pumps)==0);assert(atomic_load(&owner_pumps)==(callback_kind?1:0));
 assert(!atomic_load(&java_active)&&!atomic_load(&native_active));assert(kl_host_scheduler_destroy(&environment,s));
 atomic_store(&hold_detach,0);
}
static void retirement_timeout(void){
 KLHostCallbacks*callbacks=(KLHostCallbacks*)(uintptr_t)1;
 KLHostScheduler*s=kl_host_scheduler_create(&environment,callbacks);assert(s);assert(kl_host_scheduler_window(&environment,s,(void*)1));
 atomic_store(&java_active,1);blocked_callback=1;expected_error=1;
 uint64_t began=kl_display_clock_monotonic_now();assert(!kl_host_scheduler_quiesce_pump(&environment,s,10,owner_tasks,NULL));
 assert(kl_display_clock_monotonic_now()-began>=10000000);assert(pending_error&&atomic_load(&java_active));clear(&environment);
 assert(!kl_host_scheduler_destroy(&environment,s));assert(pending_error);clear(&environment);
 expected_error=0;blocked_callback=0;atomic_store(&java_active,0);
 assert(kl_host_scheduler_quiesce_pump(&environment,s,1000,owner_tasks,NULL));assert(kl_host_scheduler_destroy(&environment,s));
}
int main(void){
 owner_thread=pthread_self();KLHostCallbacks*callbacks=(KLHostCallbacks*)(uintptr_t)1;
 KLHostScheduler*s=kl_host_scheduler_create(&environment,callbacks);assert(s);assert(kl_host_scheduler_window(&environment,s,(void*)1));
 assert(native_wake&&native_owner);atomic_store(&native_needed,1);native_wake(native_owner);until(&demanded,1);
 publish(1);until(&events,1);
 atomic_store(&native_needed,0);atomic_store(&java_needed,1);kl_host_scheduler_notify();publish(2);
 assert(atomic_load(&events)==1); /* UI wake coalescing cannot discard either frame transport. */
 assert(kl_host_scheduler_wait(&environment,s,2)==2);
 assert(kl_host_scheduler_quiesce(&environment,s,1000));assert(atomic_load(&detached)==1&&atomic_load(&shutdowns)==1);assert(!native_wake);
 assert(kl_host_scheduler_destroy(&environment,s));assert(!wake);
 retirement_wait(0);retirement_wait(1);retirement_wait(2);
 retirement_timeout();
 puts("PASS executing callback timeout retains its owner; completed callback permits retirement retry");
 puts("PASS dispatcher exit alone never dispatches app work; real Java/NDK callback owners still pump and join");
 puts("PASS native display mailbox reaches Java and NDK during blocked UI, coalesces wakes and retires both owners");return 0;
}
