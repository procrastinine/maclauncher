#include <jni.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdlib.h>
typedef void *(*lookup_fn)(const char *);
static JavaVM *vm;
static jclass owner;
static jmethodID on_frame;
static void (*set_wakeup)(void(*)(void*),void*);
static void (*dispatch_tick)(int64_t,int64_t,int64_t,int64_t);
static lookup_fn lookup;
static void wake(void *unused){(void)unused;}
static void fail(JNIEnv *env,const char *why){jclass c=(*env)->FindClass(env,"java/lang/AssertionError");if(c)(*env)->ThrowNew(env,c,why);}
JNIEXPORT void JNICALL Java_NdkChoreographerQueueProbe_configure(JNIEnv *env,jclass type,jboolean enable){
 if(enable){
  lookup=dlsym(RTLD_DEFAULT,"kl_shim_lookup");set_wakeup=dlsym(RTLD_DEFAULT,"klj_ndk_choreographer_set_wakeup");dispatch_tick=dlsym(RTLD_DEFAULT,"klj_ndk_choreographer_tick");
  if(!lookup||!set_wakeup||!dispatch_tick){fail(env,"Actual native display supplier is unavailable");return;}
  (*env)->GetJavaVM(env,&vm);owner=(*env)->NewGlobalRef(env,type);on_frame=(*env)->GetStaticMethodID(env,type,"frame","(J)V");set_wakeup(wake,NULL);
 }else{set_wakeup(NULL,NULL);(*env)->DeleteGlobalRef(env,owner);owner=NULL;}
}
static void frame(int64_t time,void *unused){
 (void)unused;JNIEnv *env=NULL;if((*vm)->GetEnv(vm,(void**)&env,JNI_VERSION_1_6)!=JNI_OK)abort();
 (*env)->CallStaticVoidMethod(env,owner,on_frame,(jlong)time);
}
JNIEXPORT void JNICALL Java_NdkChoreographerQueueProbe_post(JNIEnv *env,jclass type){
 (void)type;void *(*get)(void)=lookup("AChoreographer_getInstance");
 void (*post)(void*,void(*)(int64_t,void*),void*)=lookup("AChoreographer_postFrameCallback64");
 if(!get||!post){fail(env,"Original native display exports unavailable");return;}
 void *instance=get();if(!instance){fail(env,"Java HandlerThread has no native ALooper");return;}post(instance,frame,NULL);
}
JNIEXPORT void JNICALL Java_NdkChoreographerQueueProbe_tick(JNIEnv *env,jclass type,jlong sequence,jlong time){
 (void)env;(void)type;dispatch_tick(sequence,time,time+16666667,16666667);
}
