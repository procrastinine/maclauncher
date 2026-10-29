#include <jni.h>
#include <jvmti.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include "../../../src/modules/android/native/jni-invocation.h"
extern char guest_calls_start,guest_calls_end;
extern jlong guest_mixed(void*,JNIEnv*,jclass,jmethodID,jobject,int);
extern jint guest_scalar(void*,JNIEnv*,jclass,jmethodID);
extern jint guest_protected_attach(JavaVM *,JNIEnv **);
typedef struct {uint64_t integer,floating;} CallResult;
extern CallResult guest_one(void*,JNIEnv*,jobject,jmethodID,jclass,int,uint64_t,int);
extern int klj_jni_calls_prepare(JNIEnv*,jniNativeInterface*,jvmtiEnv*);
extern unsigned klj_jni_cached_methods(void);
extern JNIEnv *klj_guest_env(JNIEnv*);
extern JNIEnv *klj_host_env(JNIEnv*);
extern void *klj_native_jni_import(const char *,void *);
static JNIEnv *fixture_host;static const struct JNINativeInterface_ *fixture_guest_table;
static JavaVM *fixture_machine;static _Atomic int native_before_attach;
void kl_thread_init(void){uintptr_t tp;__asm__ volatile("mrs %0,tpidrro_el0":"=r"(tp));((uintptr_t *)tp)[5]=0x0000BEEFCAFE0000ULL;}
void klj_enter_guest_thread(void){JNIEnv *env=NULL;if(fixture_machine&&(*fixture_machine)->GetEnv(fixture_machine,(void**)&env,JNI_VERSION_1_6)==JNI_EDETACHED)atomic_fetch_add(&native_before_attach,1);}
static jint JNICALL intercepted_scalar(JNIEnv *env,jclass cls,jmethodID method,...){return (*fixture_host)->CallStaticIntMethod(fixture_host,cls,method,456);}
static jint native_ndk_helper(JNIEnv *env,jclass cls){jmethodID method=(*env)->GetStaticMethodID(env,cls,"scalar","(I)I");if(!method)return -1;return (*env)->CallStaticIntMethod(env,cls,method,123);}
static jlong native_adapter_v(JNIEnv *env,jclass cls,jmethodID method,...){va_list args;va_start(args,method);jlong result=(*env)->CallStaticLongMethodV(env,cls,method,args);va_end(args);return result;}
static void *attached_worker(void *value){JavaVM *vm=value;JNIEnv *env=NULL;if((*vm)->GetEnv(vm,(void**)&env,JNI_VERSION_1_6)!=JNI_EDETACHED)return (void*)1;if(guest_protected_attach(vm,&env)!=JNI_OK)return (void*)2;if(env==klj_host_env(env)||*env!=fixture_guest_table||(*env)->GetVersion(env)<JNI_VERSION_1_6)return (void*)3;JavaVM *again=NULL;if((*env)->GetJavaVM(env,&again)!=JNI_OK||again!=vm)return (void*)4;if((*vm)->DetachCurrentThread(vm)!=JNI_OK)return (void*)5;return NULL;}
int klj_guest_address(const void *address){return (uintptr_t)address>=(uintptr_t)&guest_calls_start&&(uintptr_t)address<(uintptr_t)&guest_calls_end;}
static void fail(JNIEnv *env,const char *text){jclass type=(*env)->FindClass(env,"java/lang/AssertionError");if(type)(*env)->ThrowNew(env,type,text);}
JNIEXPORT void JNICALL Java_probe_JniCallsProbe_run(JNIEnv *env,jclass cls,jobject token){
 JavaVM *vm=NULL;jvmtiEnv *ti=NULL;jniNativeInterface *table=NULL;
 if((*env)->GetJavaVM(env,&vm)!=JNI_OK||(*vm)->GetEnv(vm,(void**)&ti,JVMTI_VERSION_1_2)!=JNI_OK||(*ti)->GetJNIFunctionTable(ti,&table)!=JVMTI_ERROR_NONE){fail(env,"JVMTI setup");return;}
 if(!getenv("JNI_CALLS_NEGATIVE")){klj_jni_calls_prepare(env,table,ti);if((*ti)->SetJNIFunctionTable(ti,table)!=JVMTI_ERROR_NONE){fail(env,"JNI table installation");return;}}
 (*ti)->Deallocate(ti,(unsigned char*)table);
 JNIEnv *guest=getenv("JNI_CALLS_NEGATIVE")?env:klj_guest_env(env);
 jmethodID scalar=(*env)->GetStaticMethodID(env,cls,"scalar","(I)I");if(!scalar)return;
 if(guest_scalar((void*)(*guest)->CallStaticIntMethod,guest,cls,scalar)!=123){if(!(*env)->ExceptionCheck(env))fail(env,"Unadapted guest scalar mismatch");return;}
 if((*env)->ExceptionCheck(env))return;
 if((*env)->CallStaticIntMethod(env,cls,scalar,456)!=456){if(!(*env)->ExceptionCheck(env))fail(env,"Host JNI varargs changed");return;}if((*env)->ExceptionCheck(env))return;
 struct JNINativeInterface_ *guest_table=(struct JNINativeInterface_*)*guest;void *saved=(void*)guest_table->CallStaticIntMethod;fixture_host=env;fixture_guest_table=*guest;guest_table->CallStaticIntMethod=intercepted_scalar;
 if(guest_scalar((void*)guest_table->CallStaticIntMethod,guest,cls,scalar)!=456||(*env)->CallStaticIntMethod(env,cls,scalar,789)!=789){fail(env,"Guest JNI interception changed host calling convention");return;}if((*env)->ExceptionCheck(env))return;
 jint(*native_entry)(JNIEnv*,jclass)=klj_native_jni_import("AFileDescriptor_getFd",native_ndk_helper);
 if(!native_entry||native_entry(guest,cls)!=123||native_entry(env,cls)!=123){if(!(*env)->ExceptionCheck(env))fail(env,"Native NDK helper borrowed an interposed guest environment");return;}if((*env)->ExceptionCheck(env))return;
 for(int i=0;i<1000;i++)if(klj_native_jni_import("AFileDescriptor_getFd",native_ndk_helper)!=(void*)native_entry){fail(env,"Native environment closure ownership accumulated");return;}
 if(klj_native_jni_import("unrelated",native_ndk_helper)!=(void*)native_ndk_helper||klj_native_jni_import("AFileDescriptor_getFd",guest_scalar)!=(void*)guest_scalar){fail(env,"Native environment boundary changed unrelated or publisher functions");return;}
 guest_table->CallStaticIntMethod=(__typeof__(guest_table->CallStaticIntMethod))saved;
 JavaVM *guest_vm=NULL;if((*guest)->GetJavaVM(guest,&guest_vm)!=JNI_OK||guest_vm==vm){fail(env,"Guest JavaVM facade is missing");return;}
 JNIEnv *again=NULL;if((*guest_vm)->GetEnv(guest_vm,(void**)&again,JNI_VERSION_1_6)!=JNI_OK||again!=guest){fail(env,"Guest JNIEnv identity changed");return;}
 fixture_machine=vm;pthread_t worker;void *worker_result=NULL;if(pthread_create(&worker,NULL,attached_worker,guest_vm)||pthread_join(worker,&worker_result)||worker_result||atomic_load(&native_before_attach)!=1){fail(env,"Guest attach/detach environment ownership must precede host attachment");return;}
 CallResult exhausted=guest_one((void*)(*guest)->CallStaticIntMethodV,guest,cls,scalar,NULL,3,42,3);if((*env)->ExceptionCheck(env))return;if(exhausted.integer!=42){fail(env,"Positive AAPCS64 argument cursor lost stack argument");return;}
 jmethodID mixed=(*env)->GetStaticMethodID(env,cls,"mixed","(ILjava/lang/Object;JDFIIIILjava/lang/Object;DDDDDDD)J");if(!mixed)return;
 /* Real NDK adapters receive the guest environment, but their C/C++ callers
  * generate Darwin varargs. Exercise both plain and V calls with that exact
  * environment, including floating-point and overflow stack arguments. */
 for(int mode=0;mode<2;mode++){
  jlong value=mode?native_adapter_v(guest,cls,mixed,7,token,(jlong)0x112233445566L,3.5,1.25,-17,23,31,47,token,2.5,4.5,6.5,8.5,10.5,12.5,14.5):(*guest)->CallStaticLongMethod(guest,cls,mixed,7,token,(jlong)0x112233445566L,3.5,1.25,-17,23,31,47,token,2.5,4.5,6.5,8.5,10.5,12.5,14.5);
  if((*env)->ExceptionCheck(env))return;if(value!=0x123456789L){fail(env,"Native adapter JNI argument origin");return;}
 }
 for(int i=0;i<100;i++)for(int mode=0;mode<3;mode++){
  void *call=mode==0?(void*)(*guest)->CallStaticLongMethod:mode==1?(void*)(*guest)->CallStaticLongMethodV:(void*)(*guest)->CallStaticLongMethodA;
  jlong value=guest_mixed(call,guest,cls,mixed,token,mode);if((*env)->ExceptionCheck(env))return;if(value!=0x123456789L){fail(env,"Guest JNI return value");return;}
 }
 jmethodID constructor=(*env)->GetMethodID(env,cls,"<init>","(I)V");if(!constructor)return;
 jvalue initial={.i=12};jobject object=(*env)->NewObjectA(env,cls,constructor,&initial);if((*env)->ExceptionCheck(env)||!object)return;
 jfieldID constructed=(*env)->GetFieldID(env,cls,"constructed","I"),observed=(*env)->GetStaticFieldID(env,cls,"observed","I");if(!constructed||!observed)return;
 for(int mode=0;mode<3;mode++){
  void *call=mode==0?(void*)(*guest)->NewObject:mode==1?(void*)(*guest)->NewObjectV:(void*)(*guest)->NewObjectA;
  CallResult made=guest_one(call,guest,cls,constructor,NULL,mode,42,3);if((*env)->ExceptionCheck(env))return;
  if(!made.integer||(*env)->GetIntField(env,(jobject)made.integer,constructed)!=42){fail(env,"Guest constructor arguments");return;}(*env)->DeleteLocalRef(env,(jobject)made.integer);
 }
 #define ROW(K) {(void*)(*guest)->Call##K##Method,(void*)(*guest)->Call##K##MethodV,(void*)(*guest)->Call##K##MethodA,(void*)(*guest)->CallStatic##K##Method,(void*)(*guest)->CallStatic##K##MethodV,(void*)(*guest)->CallStatic##K##MethodA,(void*)(*guest)->CallNonvirtual##K##Method,(void*)(*guest)->CallNonvirtual##K##MethodV,(void*)(*guest)->CallNonvirtual##K##MethodA}
 void *calls[10][9]={ROW(Object),ROW(Boolean),ROW(Byte),ROW(Char),ROW(Short),ROW(Int),ROW(Long),ROW(Float),ROW(Double),ROW(Void)};
 const char *names[]={"objectValue","booleanValue","byteValue","charValue","shortValue","intValue","longValue","floatValue","doubleValue","voidValue"};
 const char *descriptors[]={"(I)Ljava/lang/Object;","(I)Z","(I)B","(I)C","(I)S","(I)I","(I)J","(I)F","(I)D","(I)V"};
 for(int kind=0;kind<10;kind++)for(int group=0;group<3;group++){
  char name[64];snprintf(name,sizeof name,"%s",names[kind]);if(group==1){snprintf(name,sizeof name,"static%c%s",names[kind][0]-'a'+'A',names[kind]+1);}
  jmethodID method=group==1?(*env)->GetStaticMethodID(env,cls,name,descriptors[kind]):(*env)->GetMethodID(env,cls,name,descriptors[kind]);if(!method)return;
  for(int mode=0;mode<3;mode++){
   (*env)->SetStaticIntField(env,cls,observed,0);CallResult value=guest_one(calls[kind][group*3+mode],guest,group==1?cls:object,method,cls,mode,42,group==2?4:3);if((*env)->ExceptionCheck(env))return;
   int okay=0;switch(kind){case 0:okay=(*env)->IsSameObject(env,(jobject)value.integer,token);(*env)->DeleteLocalRef(env,(jobject)value.integer);break;case 1:okay=(jboolean)value.integer==1;break;case 2:okay=(jbyte)value.integer==-42;break;case 3:okay=(jchar)value.integer==0x3a9;break;case 4:okay=(jshort)value.integer==-1234;break;case 5:okay=(jint)value.integer==43;break;case 6:okay=value.integer==0x123456789L;break;case 7:{float f;memcpy(&f,&value.floating,4);okay=f==42.5f;break;}case 8:{double d;memcpy(&d,&value.floating,8);okay=d==84.5;break;}case 9:okay=(*env)->GetStaticIntField(env,cls,observed)==42;break;}
   if(!okay){fail(env,"Guest JNI return-family or nonvirtual invocation");return;}
  }
 }
 jmethodID childMethod=(*env)->GetStaticMethodID(env,cls,"child","()Lprobe/JniCallsProbe;");if(!childMethod)return;
 jobject child=(*env)->CallStaticObjectMethod(env,cls,childMethod);if((*env)->ExceptionCheck(env)||!child)return;
 jmethodID polymorphic=(*env)->GetMethodID(env,cls,"intValue","(I)I");if(!polymorphic)return;
 for(int mode=0;mode<3;mode++){
  CallResult virtual=guest_one(calls[5][mode],guest,child,polymorphic,cls,mode,42,3);if((*env)->ExceptionCheck(env))return;
  CallResult direct=guest_one(calls[5][6+mode],guest,child,polymorphic,cls,mode,42,4);if((*env)->ExceptionCheck(env))return;
  if(virtual.integer!=51||direct.integer!=43){fail(env,"Nonvirtual JNI dispatch changed");return;}
 }
 (*env)->DeleteLocalRef(env,child);
 jmethodID throwing=(*env)->GetMethodID(env,cls,"throwing","(I)V");if(!throwing)return;
 for(int mode=0;mode<3;mode++){
  guest_one(calls[9][mode],guest,object,throwing,cls,mode,42,3);
  if(!(*env)->ExceptionCheck(env)){fail(env,"Guest callback exception was hidden");return;}
  jthrowable thrown=(*env)->ExceptionOccurred(env);(*env)->ExceptionClear(env);
  jclass error=(*env)->FindClass(env,"java/lang/IllegalStateException");if(!error)return;
  if(!(*env)->IsInstanceOf(env,thrown,error)){fail(env,"Guest callback exception changed");return;}
  (*env)->DeleteLocalRef(env,error);(*env)->DeleteLocalRef(env,thrown);
 }
 (*env)->DeleteLocalRef(env,object);
}
JNIEXPORT void JNICALL Java_probe_JniCallsProbe_bounds(JNIEnv *env,jclass cls,jclass many){
 JNIEnv *guest=klj_guest_env(env);
 for(int repeat=0;repeat<2;repeat++)for(int i=0;i<1050;i++){
  char name[32];snprintf(name,sizeof name,"m%d",i);jmethodID method=(*env)->GetStaticMethodID(env,many,name,"(I)I");if(!method)return;
  jint value=guest_scalar((void*)(*guest)->CallStaticIntMethod,guest,many,method);if((*env)->ExceptionCheck(env))return;
  if(value!=123){fail(env,"JNI cache saturation changed a valid method");return;}
 }
 if(klj_jni_cached_methods()!=1024){fail(env,"JNI method cache retained unexpected owner count");return;}
 jmethodID method=(*env)->GetStaticMethodID(env,cls,"scalar","(I)I");if(!method)return;
 if(guest_scalar((void*)(*guest)->CallStaticIntMethod,guest,cls,method)!=123&&!(*env)->ExceptionCheck(env))fail(env,"Cached method failed after saturation");
 (*env)->ExceptionCheck(env);
}

jclass klj_find_from_image(JNIEnv *env,const char *name,uintptr_t caller){return (*env)->FindClass(env,name);}
jclass klj_class_for_address(JNIEnv *env,uintptr_t address){(void)env;(void)address;return NULL;}

static JavaVM *lifetime_vm;
static jclass lifetime_class;
static jmethodID lifetime_retired;
static _Thread_local int lifetime_active;
static _Atomic int lifetime_errors;
static int lifetime_enter(void){lifetime_active=1;return 0;}
static void lifetime_end(void){
 if(!lifetime_active)return;lifetime_active=0;
 JNIEnv *env=NULL;
 if((*lifetime_vm)->GetEnv(lifetime_vm,(void**)&env,JNI_VERSION_1_6)!=JNI_OK){atomic_fetch_add(&lifetime_errors,1);return;}
 (*env)->CallStaticVoidMethod(env,lifetime_class,lifetime_retired);
 if((*env)->ExceptionCheck(env)){atomic_fetch_add(&lifetime_errors,1);(*env)->ExceptionClear(env);}
}
JNIEXPORT void JNICALL Java_probe_JniCallsProbe_beginLifetimes(JNIEnv *env,jclass cls){
 if((*env)->GetJavaVM(env,&lifetime_vm)!=JNI_OK){fail(env,"JVM thread lifecycle environment");return;}
 lifetime_class=(*env)->NewGlobalRef(env,cls);
 lifetime_retired=(*env)->GetStaticMethodID(env,cls,"retired","()V");if(!lifetime_class||!lifetime_retired)return;
 static const KljJniThreadLifecycle lifecycle={lifetime_enter,lifetime_end};
 klj_jni_thread_lifecycle(&lifecycle);
}
JNIEXPORT void JNICALL Java_probe_JniCallsProbe_threadLease(JNIEnv *env,jclass cls){
 (void)cls;KljJniInvocation scope;
 klj_jni_invocation_enter(&scope,env);klj_jni_invocation_leave(&scope);
}
static void *lifetime_worker(void *unused){
 (void)unused;
 // The same physical thread can detach and attach again. Each JVM lifetime
 // must retire once, before the native environment becomes unavailable.
 for(int i=0;i<2;i++){
  JNIEnv *env=NULL;
  if((*lifetime_vm)->AttachCurrentThreadAsDaemon(lifetime_vm,(void**)&env,NULL)!=JNI_OK)return (void*)1;
  Java_probe_JniCallsProbe_threadLease(env,lifetime_class);
  if((*lifetime_vm)->DetachCurrentThread(lifetime_vm)!=JNI_OK||lifetime_active)return (void*)2;
  if((*lifetime_vm)->GetEnv(lifetime_vm,(void**)&env,JNI_VERSION_1_6)!=JNI_EDETACHED)return (void*)3;
 }
 return NULL;
}
JNIEXPORT void JNICALL Java_probe_JniCallsProbe_detachedLifetimes(JNIEnv *env,jclass cls){
 (void)cls;pthread_t worker;void *result=NULL;
 if(pthread_create(&worker,NULL,lifetime_worker,NULL)||pthread_join(worker,&result)||result)fail(env,"Detached native thread lifecycle");
}
JNIEXPORT void JNICALL Java_probe_JniCallsProbe_finishLifetimes(JNIEnv *env,jclass cls){
 (void)cls;klj_jni_thread_lifecycle(NULL);(*env)->DeleteGlobalRef(env,lifetime_class);lifetime_class=NULL;
 if(atomic_load(&lifetime_errors))fail(env,"Foreign TLS destructors ran without a live JVM environment");
}
