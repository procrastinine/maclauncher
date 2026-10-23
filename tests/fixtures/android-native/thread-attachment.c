#include <jni.h>
#include <jvmti.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <signal.h>
#include <unistd.h>
#include "../../../src/modules/android/native/jni-invocation.h"
#include "../../../src/modules/android/native/native-invocation.h"

static JavaVM *machine;
static JavaVM *guest_machine;
static int (*create_guest)(pthread_t *,const void *,void *(*)(void *),void *);
static int (*join_guest)(pthread_t,void **);
static void (*exit_guest)(void *);
static int (*key_create_guest)(int *,void (*)(void *));
static int (*key_delete_guest)(int);
static int (*set_guest)(int,const void *);
static void *(*get_guest)(int);
static int (*register_thread_local)(void (*)(void *),void *,void *);
static void (*enter_guest)(void);
static void (*finish_guest)(void);
static void (*retire_guest)(void);
static int guest_key;
static int managed_guest_key=-1;
static _Atomic int destructor_count,failures,ready;
static _Atomic int thread_local_count;
static _Thread_local unsigned finalizer_order;
static _Atomic int managed_retired;
static _Atomic int managed_cpp_finalized,managed_tsd_finalized;
static _Atomic int nested_detaches;
static _Thread_local int managed_finalizer_order;
static jvmtiEnv *managed_ti;
static pthread_t managed_native;
static int managed_nested;
static jmethodID managed_bridge;
static int managed_caller_cleanup;
extern void *klj_native_abi(void *,const char *,char *,size_t);
static void detach_during_thread_end(void){
    JNIEnv *env=NULL;
    if((*guest_machine)->DetachCurrentThread(guest_machine)!=JNI_OK||
       (*machine)->GetEnv(machine,(void **)&env,JNI_VERSION_1_6)!=JNI_OK)atomic_fetch_add(&failures,1);
    atomic_fetch_add(&nested_detaches,1);
}
static void managed_cpp_finalizer(void *unused) {
    (void)unused;JNIEnv *env=NULL;
    if(get_guest(managed_guest_key)!=(void *)1||
       (*machine)->GetEnv(machine,(void **)&env,JNI_VERSION_1_6)!=JNI_OK)atomic_fetch_add(&failures,1);
    managed_finalizer_order=1;atomic_fetch_add(&managed_cpp_finalized,1);
    detach_during_thread_end();
}
static void managed_tsd_finalizer(void *unused) {
    (void)unused;JNIEnv *env=NULL;
    if(managed_finalizer_order!=1||(*machine)->GetEnv(machine,(void **)&env,JNI_VERSION_1_6)!=JNI_OK)atomic_fetch_add(&failures,1);
    atomic_fetch_add(&managed_tsd_finalized,1);
    detach_during_thread_end();
}
static void managed_depart(JNIEnv *env,jclass type){
    managed_native=pthread_self();enter_guest();
    if(managed_nested){managed_nested=0;(*env)->CallStaticVoidMethod(env,type,managed_bridge);return;}
    if(set_guest(managed_guest_key,(void *)1)||register_thread_local(managed_cpp_finalizer,NULL,NULL))atomic_fetch_add(&failures,1);
    exit_guest(NULL);
}
static void managed_cleanup(void *unused){(void)unused;managed_caller_cleanup++;}
static void managed_direct(JNIEnv *env,jclass type){
    // Original loader/NDK cleanup records surround the guest boundary and must
    // remain balanced when that guest exits its VM-owned thread.
    pthread_cleanup_push(managed_cleanup,NULL);
    KLJ_INVOKE_GUEST(env,managed_depart(env,type));
    pthread_cleanup_pop(1);
}
static void JNICALL managed_end(jvmtiEnv *ti,JNIEnv *env,jthread thread){
    jvmtiThreadInfo info={0};
    if((*ti)->GetThreadInfo(ti,thread,&info)==JVMTI_ERROR_NONE){
        if(info.name&&strncmp(info.name,"managed-exit-probe-",19)==0){
            // The production loader's independent private JVMTI environment
            // performs retirement; this observer only checks VM liveness.
            JNIEnv *still_attached=NULL;
            if((*machine)->GetEnv(machine,(void **)&still_attached,JNI_VERSION_1_6)!=JNI_OK)atomic_fetch_add(&failures,1);
            atomic_fetch_add(&managed_retired,1);
        }
        if(info.name)(*ti)->Deallocate(ti,(unsigned char*)info.name);
        if(info.thread_group)(*env)->DeleteLocalRef(env,info.thread_group);
        if(info.context_class_loader)(*env)->DeleteLocalRef(env,info.context_class_loader);
    }
}
JNIEXPORT void JNICALL Java_ThreadAttachmentProbe_beginManaged(JNIEnv *env,jclass type,jboolean unwrapped,jint nested){
    managed_nested=nested==1;
    if(managed_guest_key<0&&key_create_guest(&managed_guest_key,managed_tsd_finalizer))_exit(7);
    managed_bridge=(*env)->GetStaticMethodID(env,type,"bridge","()V");
    char error[256];
    void *entry=unwrapped?(void*)managed_depart:nested==2?(void*)managed_direct:klj_native_abi(managed_depart,"()V",error,sizeof error);
    if(!entry){fprintf(stderr,"%s\n",error);_exit(3);}
    JNINativeMethod method={"depart","()V",entry};
    if((*env)->RegisterNatives(env,type,&method,1)!=JNI_OK)_exit(4);
    if(!managed_ti){
        if((*machine)->GetEnv(machine,(void**)&managed_ti,JVMTI_VERSION_1_2)!=JNI_OK)_exit(5);
        jvmtiEventCallbacks callbacks={.ThreadEnd=managed_end};
        if((*managed_ti)->SetEventCallbacks(managed_ti,&callbacks,sizeof callbacks)!=JVMTI_ERROR_NONE||
           (*managed_ti)->SetEventNotificationMode(managed_ti,JVMTI_ENABLE,JVMTI_EVENT_THREAD_END,NULL)!=JVMTI_ERROR_NONE)_exit(6);
    }
}
JNIEXPORT jint JNICALL Java_ThreadAttachmentProbe_nativeStatus(JNIEnv *env,jclass type){(void)env;(void)type;return pthread_kill(managed_native,0);}
JNIEXPORT jint JNICALL Java_ThreadAttachmentProbe_retired(JNIEnv *env,jclass type){(void)env;(void)type;if(atomic_load(&managed_retired)==3&&(managed_caller_cleanup!=1||atomic_load(&managed_cpp_finalized)!=3||atomic_load(&managed_tsd_finalized)!=3||atomic_load(&nested_detaches)!=6||atomic_load(&failures)))return -1;return atomic_load(&managed_retired);}
JNIEXPORT void JNICALL Java_ThreadAttachmentProbe_halt(JNIEnv *env,jclass type){(void)env;(void)type;fflush(stdout);_exit(0);}
static void destructor(void *value) {
    JNIEnv *env=NULL;
    if(value!=(void *)1||finalizer_order!=3||(*machine)->GetEnv(machine,(void **)&env,JNI_VERSION_1_6)!=JNI_OK)
        atomic_fetch_add(&failures,1);
    atomic_fetch_add(&destructor_count,1);
}
static void thread_local_finalizer(void *value) {
    JNIEnv *env=NULL;
    if((unsigned)(uintptr_t)value!=finalizer_order||get_guest(guest_key)!=(void *)1||
       (*machine)->GetEnv(machine,(void **)&env,JNI_VERSION_1_6)!=JNI_OK)atomic_fetch_add(&failures,1);
    ++finalizer_order;atomic_fetch_add(&thread_local_count,1);
    if(value==NULL&&register_thread_local(thread_local_finalizer,(void *)1,NULL))atomic_fetch_add(&failures,1);
}
static void *worker(void *opaque) {
    // Host-created audio/media producers enter Android through this same door.
    enter_guest();
    JNIEnv *env=NULL;
    JavaVMAttachArgs arguments={JNI_VERSION_1_6,"guest-attachment-probe",NULL};
    if((*machine)->AttachCurrentThreadAsDaemon(machine,(void **)&env,&arguments)!=JNI_OK){
        atomic_fetch_add(&failures,1);return NULL;
    }
    enter_guest(); // Reentry after attachment must retain native ownership.
    if(set_guest(guest_key,(void *)1))atomic_fetch_add(&failures,1);
    // Original LIFO order, registration while draining, and live POSIX/JVM
    // state must hold for return, explicit exit and cancellation alike.
    if(register_thread_local(thread_local_finalizer,(void *)2,NULL)||
       register_thread_local(thread_local_finalizer,NULL,NULL))atomic_fetch_add(&failures,1);
    // A native worker may detach and attach again without ending its physical
    // Android lifetime or prematurely running C++/POSIX destructors.
    if((*guest_machine)->DetachCurrentThread(guest_machine)!=JNI_OK||finalizer_order||get_guest(guest_key)!=(void *)1||
       (*guest_machine)->AttachCurrentThreadAsDaemon(guest_machine,(void **)&env,&arguments)!=JNI_OK)atomic_fetch_add(&failures,1);
    int mode=(int)(long)opaque;
    if(mode%3==2){
        atomic_store(&ready,1);
        for(;;){struct timespec interval={0,1000000};nanosleep(&interval,NULL);}
    }
    if(mode%3==1){
        if(mode>=3)pthread_exit((void *)17);
        exit_guest((void *)17);
    }
    return (void *)17;
}
static void *java_owned_worker(void *unused) {
    (void)unused;
    JNIEnv *env=NULL;
    JavaVMAttachArgs arguments={JNI_VERSION_1_6,"java-owned-callback-probe",NULL};
    if((*machine)->AttachCurrentThreadAsDaemon(machine,(void **)&env,&arguments)!=JNI_OK)return (void *)1;
    enter_guest();finish_guest();
    if((*machine)->GetEnv(machine,(void **)&env,JNI_VERSION_1_6)!=JNI_OK)return (void *)2;
    return (void *)(long)((*machine)->DetachCurrentThread(machine)!=JNI_OK);
}
JNIEXPORT jint JNICALL Java_ThreadAttachmentProbe_run(JNIEnv *env,jclass type,jstring library,jstring identities) {
    (void)type;
    const char *file=(*env)->GetStringUTFChars(env,library,NULL);
    void *owner=dlopen(file,RTLD_NOW|RTLD_LOCAL|RTLD_FIRST);
    (*env)->ReleaseStringUTFChars(env,library,file);
    if(!owner){fprintf(stderr,"%s\n",dlerror());return -1;}
    int (*configure)(const char *)=dlsym(owner,"klj_test_configure_ids");
    const char *root=(*env)->GetStringUTFChars(env,identities,NULL);
    int configured=configure?configure(root):-1;
    (*env)->ReleaseStringUTFChars(env,identities,root);
    if(configured<0)return -12;
    create_guest=dlsym(owner,"klb_pthread_create");join_guest=dlsym(owner,"klb_pthread_join");
    exit_guest=dlsym(owner,"klb_pthread_exit");key_create_guest=dlsym(owner,"klb_pthread_key_create");
    key_delete_guest=dlsym(owner,"klb_pthread_key_delete");set_guest=dlsym(owner,"klb_pthread_setspecific");
    get_guest=dlsym(owner,"klb_pthread_getspecific");register_thread_local=dlsym(owner,"klb___cxa_thread_atexit_impl");
    enter_guest=dlsym(owner,"klj_test_thread_init");
    if(!enter_guest)enter_guest=dlsym(owner,"kl_thread_init");
    finish_guest=dlsym(owner,"klj_finish_guest_thread");
    retire_guest=dlsym(owner,"klj_jni_thread_retire");
    void (*publish)(JavaVM *)=dlsym(owner,"klj_set_guest_thread_vm");
    if(!create_guest||!join_guest||!exit_guest||!key_create_guest||!key_delete_guest||!set_guest||!get_guest||!register_thread_local||!enter_guest||!finish_guest||!retire_guest)return -2;
    if((*env)->GetJavaVM(env,&machine)!=JNI_OK)return -3;
    if(publish)publish(machine);
    JavaVM *(*guest_vm)(JavaVM *)=dlsym(owner,"klj_guest_vm");
    int (*prepare_calls)(JNIEnv *,jniNativeInterface *,jvmtiEnv *)=dlsym(owner,"klj_jni_calls_prepare");
    jvmtiEnv *bridge_ti=NULL;jniNativeInterface *table=NULL;
    if(!guest_vm||!prepare_calls||(*machine)->GetEnv(machine,(void **)&bridge_ti,JVMTI_VERSION_1_2)!=JNI_OK||
       (*bridge_ti)->GetJNIFunctionTable(bridge_ti,&table)!=JVMTI_ERROR_NONE)return -9;
    int prepared=prepare_calls(env,table,bridge_ti);(*bridge_ti)->Deallocate(bridge_ti,(unsigned char *)table);
    if(!prepared)return -10;guest_machine=guest_vm(machine);
    JNIEnv *still_attached=NULL;
    if((*guest_machine)->DetachCurrentThread(guest_machine)!=JNI_ERR||
       (*machine)->GetEnv(machine,(void **)&still_attached,JNI_VERSION_1_6)!=JNI_OK)return -11;
    pthread_t java_thread;void *java_result=NULL;
    if(pthread_create(&java_thread,NULL,java_owned_worker,NULL)||pthread_join(java_thread,&java_result)||java_result)return -8;
    if(key_create_guest(&guest_key,destructor))return -4;
    for(int iteration=0;iteration<64;iteration++) {
        pthread_t thread;void *result=NULL;int mode=iteration%3+(iteration>=32?3:0);
        atomic_store(&ready,0);
        if((mode>=3?pthread_create(&thread,NULL,worker,(void *)(long)mode):
                    create_guest(&thread,NULL,worker,(void *)(long)mode)))return -5;
        if(mode%3==2){
            while(!atomic_load(&ready)){struct timespec interval={0,1000000};nanosleep(&interval,NULL);}
            if(pthread_cancel(thread))return -5;
        }
        if((mode>=3?pthread_join(thread,&result):join_guest(thread,&result))||
           result!=(mode%3==2?PTHREAD_CANCELED:(void *)17))return -5;
    }
    if(key_delete_guest(guest_key)||atomic_load(&destructor_count)!=64||atomic_load(&thread_local_count)!=192||atomic_load(&failures)){
        fprintf(stderr,"guest destructor count=%d failures=%d\n",atomic_load(&destructor_count),atomic_load(&failures));return -6;
    }
    // JVMTI thread enumeration does not suspend threads or require a debugger.
    jvmtiEnv *ti=NULL;jthread *threads=NULL;jint count=0,retained=0;
    if((*machine)->GetEnv(machine,(void **)&ti,JVMTI_VERSION_1_2)!=JNI_OK||
       (*ti)->GetAllThreads(ti,&count,&threads)!=JVMTI_ERROR_NONE)return -7;
    for(jint i=0;i<count;i++) {
        jvmtiThreadInfo info={0};
        if((*ti)->GetThreadInfo(ti,threads[i],&info)==JVMTI_ERROR_NONE){
            if(info.name&&strcmp(info.name,"guest-attachment-probe")==0)retained++;
            if(info.name)(*ti)->Deallocate(ti,(unsigned char *)info.name);
            if(info.thread_group)(*env)->DeleteLocalRef(env,info.thread_group);
            if(info.context_class_loader)(*env)->DeleteLocalRef(env,info.context_class_loader);
        }
        (*env)->DeleteLocalRef(env,threads[i]);
    }
    if(threads)(*ti)->Deallocate(ti,(unsigned char *)threads);
    (*ti)->DisposeEnvironment(ti);
    return retained;
}
