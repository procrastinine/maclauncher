#include <jni.h>
#include <jvmti.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>

/* Observe the VM's real RegisterNatives bindings, including private methods.
 * This is a test agent only; the runtime needs no inspection entrypoints. */
static FILE *output;
static pthread_mutex_t lock=PTHREAD_MUTEX_INITIALIZER;
static void JNICALL bound(jvmtiEnv *tool,JNIEnv *env,jthread thread,
 jmethodID method,void *address,void **replacement){
 (void)thread;(void)address;(void)replacement;
 jclass owner;char *type=NULL,*name=NULL,*descriptor=NULL;
 if((*tool)->GetMethodDeclaringClass(tool,method,&owner)!=JVMTI_ERROR_NONE)return;
 if((*tool)->GetClassSignature(tool,owner,&type,NULL)!=JVMTI_ERROR_NONE){(*env)->DeleteLocalRef(env,owner);return;}
 if((*tool)->GetMethodName(tool,method,&name,&descriptor,NULL)==JVMTI_ERROR_NONE){
  size_t size=strlen(type);
  if(size>2&&type[0]=='L'&&type[size-1]==';'){
   pthread_mutex_lock(&lock);
   fprintf(output,"%.*s.%s%s\n",(int)size-2,type+1,name,descriptor);fflush(output);
   pthread_mutex_unlock(&lock);
  }
 }
 if(type)(*tool)->Deallocate(tool,(unsigned char*)type);
 if(name)(*tool)->Deallocate(tool,(unsigned char*)name);
 if(descriptor)(*tool)->Deallocate(tool,(unsigned char*)descriptor);
 (*env)->DeleteLocalRef(env,owner);
}
JNIEXPORT jint JNICALL Agent_OnLoad(JavaVM *vm,char *options,void *reserved){
 (void)reserved;jvmtiEnv *tool=NULL;
 if(!options||!options[0]||(*vm)->GetEnv(vm,(void**)&tool,JVMTI_VERSION_1_2)!=JNI_OK)return JNI_ERR;
 output=fopen(options,"w");if(!output)return JNI_ERR;
 jvmtiCapabilities capabilities={0};capabilities.can_generate_native_method_bind_events=1;
 jvmtiEventCallbacks callbacks={0};callbacks.NativeMethodBind=bound;
 if((*tool)->AddCapabilities(tool,&capabilities)!=JVMTI_ERROR_NONE||
    (*tool)->SetEventCallbacks(tool,&callbacks,sizeof callbacks)!=JVMTI_ERROR_NONE||
    (*tool)->SetEventNotificationMode(tool,JVMTI_ENABLE,JVMTI_EVENT_NATIVE_METHOD_BIND,NULL)!=JVMTI_ERROR_NONE){fclose(output);output=NULL;return JNI_ERR;}
 return JNI_OK;
}
JNIEXPORT void JNICALL Agent_OnUnload(JavaVM *vm){(void)vm;if(output)fclose(output);}
