/* Test-only failed JNI lookup diagnostics; original calls and exceptions retained. */
#include <jni.h>
#include <jvmti.h>
#include <stdio.h>
#include <string.h>
static _Thread_local int reporting;
static void JNICALL exception(jvmtiEnv *ti,JNIEnv *env,jthread thread,jmethodID method,jlocation location,jobject value,jmethodID catch_method,jlocation catch_location){
    (void)location;(void)catch_location;
    if(reporting)return;reporting=1;
    jclass type=(*env)->GetObjectClass(env,value);char *signature=NULL;
    if(type)(*ti)->GetClassSignature(ti,type,&signature,NULL);
    if(signature&&(strstr(signature,"LinkError;")||strstr(signature,"MethodError;")||strstr(signature,"VerifyError;")||!catch_method)){
        char *name=NULL,*descriptor=NULL;(*ti)->GetMethodName(ti,method,&name,&descriptor,NULL);
        fprintf(stderr,"[jni-exception] %s thrown in %s%s uncaught=%d\n",signature,name?name:"?",descriptor?descriptor:"",catch_method==NULL);
        jfieldID field=(*env)->GetFieldID(env,type,"detailMessage","Ljava/lang/String;");
        jstring text=field?(*env)->GetObjectField(env,value,field):NULL;
        if(text){const char *bytes=(*env)->GetStringUTFChars(env,text,NULL);if(bytes){fprintf(stderr,"[jni-exception] %s\n",bytes);(*env)->ReleaseStringUTFChars(env,text,bytes);}(*env)->DeleteLocalRef(env,text);}
        jvmtiFrameInfo frames[10];jint count=0;
        if((*ti)->GetStackTrace(ti,thread,0,10,frames,&count)==JVMTI_ERROR_NONE)for(int i=0;i<count;i++){
            char *n=NULL,*d=NULL,*owner=NULL;jclass declaring=NULL;
            (*ti)->GetMethodName(ti,frames[i].method,&n,&d,NULL);(*ti)->GetMethodDeclaringClass(ti,frames[i].method,&declaring);
            if(declaring)(*ti)->GetClassSignature(ti,declaring,&owner,NULL);
            fprintf(stderr,"[jni-exception] at %s.%s%s\n",owner?owner:"?",n?n:"?",d?d:"");
            if(n)(*ti)->Deallocate(ti,(unsigned char*)n);if(d)(*ti)->Deallocate(ti,(unsigned char*)d);if(owner)(*ti)->Deallocate(ti,(unsigned char*)owner);if(declaring)(*env)->DeleteLocalRef(env,declaring);
        }
        if(name)(*ti)->Deallocate(ti,(unsigned char*)name);if(descriptor)(*ti)->Deallocate(ti,(unsigned char*)descriptor);
    }
    if(signature)(*ti)->Deallocate(ti,(unsigned char*)signature);if(type)(*env)->DeleteLocalRef(env,type);reporting=0;
}
static jclass (JNICALL *find_class)(JNIEnv *,const char *);
static jmethodID (JNICALL *get_static)(JNIEnv *,jclass,const char *,const char *);
static void describe(JNIEnv *env){jthrowable failure=(*env)->ExceptionOccurred(env);if(failure){(*env)->ExceptionDescribe(env);(*env)->Throw(env,failure);(*env)->DeleteLocalRef(env,failure);}}
static jclass JNICALL find(JNIEnv *env,const char *name){jclass result=find_class(env,name);if(!result){fprintf(stderr,"[jni-lookup] FindClass failed: %s\n",name?name:"<null>");describe(env);}return result;}
static jmethodID JNICALL method(JNIEnv *env,jclass type,const char *name,const char *descriptor){if(!type||(*env)->ExceptionCheck(env)){fprintf(stderr,"[jni-lookup] GetStaticMethodID class=%p name=%s descriptor=%s\n",(void *)type,name?name:"<null>",descriptor?descriptor:"<null>");describe(env);}return get_static(env,type,name,descriptor);}
static void JNICALL initialize(jvmtiEnv *ti,JNIEnv *env,jthread thread){(void)env;(void)thread;jniNativeInterface *table=NULL;if((*ti)->GetJNIFunctionTable(ti,&table)!=JVMTI_ERROR_NONE)return;find_class=table->FindClass;get_static=table->GetStaticMethodID;table->FindClass=find;table->GetStaticMethodID=method;(*ti)->SetJNIFunctionTable(ti,table);(*ti)->Deallocate(ti,(unsigned char*)table);}
JNIEXPORT jint JNICALL Agent_OnLoad(JavaVM *vm,char *options,void *reserved){(void)options;(void)reserved;jvmtiEnv *ti=NULL;if((*vm)->GetEnv(vm,(void**)&ti,JVMTI_VERSION_1_2)!=JNI_OK)return JNI_ERR;jvmtiCapabilities capabilities={.can_generate_exception_events=1};if((*ti)->AddCapabilities(ti,&capabilities)!=JVMTI_ERROR_NONE)return JNI_ERR;jvmtiEventCallbacks callbacks={0};callbacks.VMInit=initialize;callbacks.Exception=exception;if((*ti)->SetEventCallbacks(ti,&callbacks,sizeof callbacks)!=JNI_OK)return JNI_ERR;if((*ti)->SetEventNotificationMode(ti,JVMTI_ENABLE,JVMTI_EVENT_EXCEPTION,NULL)!=JVMTI_ERROR_NONE)return JNI_ERR;return (*ti)->SetEventNotificationMode(ti,JVMTI_ENABLE,JVMTI_EVENT_VM_INIT,NULL)==JVMTI_ERROR_NONE?JNI_OK:JNI_ERR;}
