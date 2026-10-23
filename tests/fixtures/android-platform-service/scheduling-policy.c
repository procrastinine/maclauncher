#include "process-ids.h"
#include <jni.h>
#include <errno.h>
#include <string.h>

static void failed(JNIEnv *env,const char *message){
    jclass type=(*env)->FindClass(env,"java/lang/AssertionError");
    if(type){(*env)->ThrowNew(env,type,message);(*env)->DeleteLocalRef(env,type);}
}

JNIEXPORT jint JNICALL Java_SchedulingPolicyProbe_install(JNIEnv *env,jclass type,jstring directory,jstring name){
    (void)type;const char *path=(*env)->GetStringUTFChars(env,directory,NULL);if(!path)return -1;
    int result=klj_process_ids_configure(path);(*env)->ReleaseStringUTFChars(env,directory,path);
    if(result<0){failed(env,strerror(errno));return -1;}
    const char *command=(*env)->GetStringUTFChars(env,name,NULL);if(!command)return -1;
    result=klj_process_publish_name(command);(*env)->ReleaseStringUTFChars(env,name,command);
    if(result||klj_process_publish_principal(1000)){failed(env,"Private process lease publication failed");return -1;}
    return klj_process_id();
}
