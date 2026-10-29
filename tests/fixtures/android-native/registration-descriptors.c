#include <jni.h>
#include <jvmti.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

static FILE *records;
static char implementation_directory[PATH_MAX];
static size_t implementation_directory_length;
static pthread_mutex_t lock=PTHREAD_MUTEX_INITIALIZER;
static void JNICALL binding(jvmtiEnv *ti,JNIEnv *env,jthread thread,jmethodID method,void *address,void **replacement){
    (void)env;(void)thread;(void)replacement;
    Dl_info image={0};char resolved[PATH_MAX];jvmtiPhase phase;
    if((*ti)->GetPhase(ti,&phase)!=JVMTI_ERROR_NONE||phase!=JVMTI_PHASE_LIVE||
       !dladdr(address,&image)||!image.dli_fname||!realpath(image.dli_fname,resolved))return;
    if(strncmp(implementation_directory,resolved,implementation_directory_length))return;
    jclass type;char *owner=NULL,*name=NULL,*descriptor=NULL;
    if((*ti)->GetMethodDeclaringClass(ti,method,&type)!=JVMTI_ERROR_NONE)return;
    if((*ti)->GetClassSignature(ti,type,&owner,NULL)==JVMTI_ERROR_NONE&&
       (*ti)->GetMethodName(ti,method,&name,&descriptor,NULL)==JVMTI_ERROR_NONE){
        pthread_mutex_lock(&lock);fprintf(records,"%s\t%s\t%s\n",owner,name,descriptor);fflush(records);pthread_mutex_unlock(&lock);
    }
    if(owner)(*ti)->Deallocate(ti,(unsigned char*)owner);
    if(name)(*ti)->Deallocate(ti,(unsigned char*)name);
    if(descriptor)(*ti)->Deallocate(ti,(unsigned char*)descriptor);
}
JNIEXPORT jint JNICALL Agent_OnLoad(JavaVM *vm,char *options,void *reserved){
    (void)reserved;if(!options)return JNI_ERR;char *split=strchr(options,'|');if(!split)return JNI_ERR;*split=0;
    if(!realpath(options,implementation_directory)||(records=fopen(split+1,"w"))==NULL)return JNI_ERR;
    // A publisher family can delegate to another native library in this exact
    // runtime, including libnativebinding's process/clock implementations.
    // Expected families come from original declarations, not this observation.
    char *slash=strrchr(implementation_directory,'/');if(!slash)return JNI_ERR;slash[1]=0;
    implementation_directory_length=strlen(implementation_directory);
    jvmtiEnv *ti=NULL;if((*vm)->GetEnv(vm,(void**)&ti,JVMTI_VERSION_1_2)!=JNI_OK)return JNI_ERR;
    jvmtiCapabilities capabilities={0};capabilities.can_generate_native_method_bind_events=1;
    jvmtiEventCallbacks callbacks={0};callbacks.NativeMethodBind=binding;
    return (*ti)->AddCapabilities(ti,&capabilities)==JVMTI_ERROR_NONE&&
        (*ti)->SetEventCallbacks(ti,&callbacks,sizeof callbacks)==JVMTI_ERROR_NONE&&
        (*ti)->SetEventNotificationMode(ti,JVMTI_ENABLE,JVMTI_EVENT_NATIVE_METHOD_BIND,NULL)==JVMTI_ERROR_NONE?JNI_OK:JNI_ERR;
}
