#include <jni.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
extern void Java_maclauncher_android_framework_JvmNativeMemory_prepareRegistration(JNIEnv*,jclass,jbyteArray);
extern int klj_framework_registration(JNIEnv*,jclass,const JNINativeMethod*,jint,JNINativeMethod**,jint*);
int klj_registration_install(JNIEnv *env){(void)env;return 1;}
void klj_android_log_initialize(void){}
int klj_android_log_write(int priority,const char *tag,const char *message){(void)priority;(void)tag;(void)message;return 0;}
static void *publisher;
JNIEXPORT jint JNICALL Java_RegistrationOwnerProbe_00024NativePlatform_value(JNIEnv *env,jclass type){(void)env;(void)type;return 23;}
JNIEXPORT jint JNICALL Java_RegistrationOwnerProbe_00024Retained_omitted(JNIEnv *env,jclass type){(void)env;(void)type;return 47;}
static jint original_value(JNIEnv *env,jclass type){(void)env;(void)type;return 31;}
JNIEXPORT void JNICALL Java_RegistrationOwnerProbe_initialize(JNIEnv *env,jclass type,jstring path){
    const char *name=(*env)->GetStringUTFChars(env,path,NULL);size_t length=strlen(name);
    publisher=dlopen(name,RTLD_LAZY|RTLD_LOCAL);
    jbyteArray bytes=(*env)->NewByteArray(env,(jsize)length);(*env)->SetByteArrayRegion(env,bytes,0,(jsize)length,(const jbyte*)name);
    (*env)->ReleaseStringUTFChars(env,path,name);
    Java_maclauncher_android_framework_JvmNativeMemory_prepareRegistration(env,type,bytes);
}
JNIEXPORT void JNICALL Java_RegistrationOwnerProbe_register(JNIEnv *env,jclass type,jboolean original){
    (void)type;
    const char *owners[]={"RegistrationOwnerProbe$Retained","RegistrationOwnerProbe$Platform","RegistrationOwnerProbe$NativePlatform","RegistrationOwnerProbe$Original"};
    for(int i=original?3:0;i<4;i++){
        jclass owner=(*env)->FindClass(env,owners[i]);
        JNINativeMethod methods[]={{"value","()I",original?(void*)original_value:dlsym(publisher,"publisher_value")},{"added","()I",original_value}};
        jint count=original?2:1;JNINativeMethod *selected=NULL;
        if(klj_framework_registration(env,owner,methods,count,&selected,&count)<0)return;
        (*env)->RegisterNatives(env,owner,selected?selected:methods,count);free(selected);
        if((*env)->ExceptionCheck(env))return;
    }
}
