#include "probe.h"
#include "runtime-host.h"
#include "image-loader.h"
#include "native-image-provider.h"
#include "jni-provider.h"
#include "looper-host.h"
#include "choreographer-host.h"
#include <assert.h>
#include <dlfcn.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
static KljBionicRuntime *runtime;static JavaVM *vm;static jlong image;
static _Atomic int running,callbacks;
extern void *kl_ndk_lookup(const char*);
extern void *klj_guest_image_symbol(jlong,const char*);
extern void klj_ndk_choreographer_set_wakeup(void(*)(void*),void*);
extern void klj_ndk_choreographer_tick(int64_t,int64_t,int64_t,int64_t);
extern void klj_ndk_choreographer_refresh_period(int64_t);
extern int klj_ndk_choreographer_needs_frames(void),klj_ndk_choreographer_inflight(void);
static void wake(void *unused){(void)unused;}
static int64_t now(void){mach_timebase_info_data_t scale;assert(mach_timebase_info(&scale)==KERN_SUCCESS);return(int64_t)((__uint128_t)mach_absolute_time()*scale.numer/scale.denom);}
static void *ticks(void *unused){
 (void)unused;int64_t sequence=0;
 while(atomic_load(&running)){int64_t time=now();klj_ndk_choreographer_tick(++sequence,time,time+16666667,16666667);usleep(1000);}return NULL;
}
static int64_t invoke(void *unused,JNIEnv *env,uintptr_t caller,KljCallPacket *packet){
 (void)unused;JNIEnv *actual=NULL;jint status=(*vm)->GetEnv(vm,(void**)&actual,JNI_VERSION_1_6);
 assert((status==JNI_OK&&env==actual)||(status==JNI_EDETACHED&&!env&&!actual));
 const void *identity=klj_jni_provider_identity((void*)caller);assert(identity&&(jlong)(uintptr_t)identity==image);
 int accepted=klj_native_image_invoke(env,image,packet);callbacks++;
 JNIEnv *after=NULL;assert((*vm)->GetEnv(vm,(void**)&after,JNI_VERSION_1_6)==status&&after==actual);
 return accepted?packet->status:-22;
}
static int64_t host_call(void *unused,KljBionicRuntime *owner,JNIEnv *env,uint32_t code,uint64_t raw,uint64_t length){
 (void)unused;assert(owner==runtime);if(code==0x43545001&&length==0){assert(raw==8333333||raw==16666667);klj_ndk_choreographer_refresh_period((int64_t)raw);return 0;}
 if(length!=sizeof(KljBionicNdkPacket))return -22;
 if(code==KLJ_BIONIC_LOOPER_HOSTCALL)return klj_bionic_looper_dispatch(env,(void*)(uintptr_t)raw);
 if(code==KLJ_BIONIC_CHOREOGRAPHER_HOSTCALL)return klj_bionic_choreographer_dispatch(env,(void*)(uintptr_t)raw);
 return -38;
}
static int64_t install(JNIEnv *env,const char *name,const void *bindings){
 KljBionicSymbol symbol={sizeof symbol,1,klj_bionic_runtime_guest(runtime)->helper.handle,name,NULL,NULL,0};
 int64_t status=klj_bionic_runtime_symbol(runtime,env,&symbol);uint64_t result=0;
 if(!status)status=klj_bionic_runtime_invoke(runtime,env,(uintptr_t)symbol.symbol,(uintptr_t)bindings,&result);
 return status?status:(int64_t)result;
}
JNIEXPORT jint JNICALL Java_maclauncher_android_bridge_ChoreographerProbe_initialize(JNIEnv *env,jclass ignored,jobjectArray paths){
 (void)ignored;assert((*env)->GetJavaVM(env,&vm)==JNI_OK&&(*env)->GetArrayLength(env,paths)==7);
 const char *text[7];jstring values[7];for(unsigned i=0;i<7;i++){values[i]=(*env)->GetObjectArrayElement(env,paths,i);text[i]=(*env)->GetStringUTFChars(env,values[i],NULL);assert(text[i]);}
 extern char **environ;size_t count=0;while(environ[count])count++;
 KljBionicRuntimeOptions options={sizeof options,1,text[0],text[1],text[2],text[3],text[4],text[5],text[6],(const char*const*)environ,count};
 int64_t status=klj_bionic_runtime_prepare(env,&options,&runtime);
 if(!status)status=klj_bionic_images_install(runtime,env);
 void *abi=dlopen(text[0],RTLD_NOW|RTLD_NOLOAD);const KljBionicPollFdApi *(*getter)(void)=abi?dlsym(abi,"klj_bionic_poll_fd_api_v1"):NULL;
 const KljBionicPollFdApi *poll=getter?getter():NULL;assert(poll);
 if(!status){KljBionicLooperOwner owner={kl_ndk_lookup,invoke,NULL,poll};status=klj_bionic_looper_prepare(env,&owner);}
 if(!status){KljBionicChoreographerOwner owner={.resolve=kl_ndk_lookup,.invoke=invoke,.context=NULL,.vm=vm};status=klj_bionic_choreographer_prepare(&owner);}
 if(!status)status=klj_bionic_runtime_host_callback(runtime,host_call,NULL);
 if(!status)status=install(env,"klj_bionic_looper_install",klj_bionic_looper_bindings());
 if(!status&&!getenv("CHOREOGRAPHER_BASELINE_CONTROL"))status=install(env,"klj_bionic_choreographer_install",klj_bionic_choreographer_bindings());
 for(unsigned i=0;i<7;i++){(*env)->ReleaseStringUTFChars(env,values[i],text[i]);(*env)->DeleteLocalRef(env,values[i]);}return(jint)status;
}
JNIEXPORT void JNICALL Java_maclauncher_android_bridge_ChoreographerProbe_exercise(JNIEnv *env,jclass type,jstring core,jstring file,jobject preparation){
 jstring name=(*env)->NewStringUTF(env,"libchoreographer-original-control.so");image=klj_load_prepared(env,type,core,file,name,preparation);(*env)->DeleteLocalRef(env,name);assert(image&&!(*env)->ExceptionCheck(env));
 JNIEnv *outer=NULL;JavaVM *guest_vm=NULL;assert(klj_native_image_jni_context(env,image,&outer,&guest_vm)==1);
 void *entry=klj_guest_image_symbol(image,"choreographer_original_exercise");assert(entry);
 ChoreographerProbeCall call={.vm=guest_vm};uint64_t result=0;
 klj_ndk_choreographer_set_wakeup(wake,NULL);atomic_store(&running,1);pthread_t ticker;assert(!pthread_create(&ticker,NULL,ticks,NULL));
 int64_t status=klj_bionic_runtime_invoke(runtime,env,(uintptr_t)entry,(uintptr_t)&call,&result);
 atomic_store(&running,0);assert(!pthread_join(ticker,NULL));
 fprintf(stderr,"Choreographer original owner status=%lld line=%llu callbacks=%d detached=%d failures=%d legacy=%d vsync=%d refresh=%d delayed=%d reposted=%d\n",(long long)status,(unsigned long long)result,callbacks,call.detached,call.failures,call.legacy,call.vsync,call.refresh,call.delayed,call.reposted);
 fprintf(stderr,"Original libandroid surface symbols=%d fallbackCalls=%d missingLookup=%d\n",call.surface_symbols,call.fallback_calls,call.missing_lookup);
 if(getenv("CHOREOGRAPHER_BASELINE_CONTROL")){assert(!status&&result==73&&!callbacks);puts("PASS original guest Choreographer rejects host-only Looper TLS; Flutter native scheduling receives NULL");}
 else assert(!status&&!result&&!call.failures&&call.callbacks==9&&call.detached==9&&callbacks==18&&call.surface_symbols==431&&call.fallback_calls==6&&call.missing_lookup==1);
 assert(!klj_ndk_choreographer_inflight());
}
JNIEXPORT void JNICALL Java_maclauncher_android_bridge_ChoreographerProbe_complete(JNIEnv *env,jclass ignored){
 (void)ignored;assert(!klj_ndk_choreographer_needs_frames()&&!klj_ndk_choreographer_inflight());klj_ndk_choreographer_set_wakeup(NULL,NULL);
 int64_t status=-16;for(unsigned i=0;i<2000&&status==-16;i++){status=klj_bionic_runtime_try_close(runtime,env);if(status==-16)usleep(1000);}assert(!status);
}
