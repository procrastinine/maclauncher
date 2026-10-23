#include <jni.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
extern void Java_maclauncher_android_framework_JvmNativeMemory_prepareRegistration(JNIEnv*,jclass,jbyteArray);
extern void Java_maclauncher_android_framework_JvmNativeMemory_configureRegistrationOwners(JNIEnv*,jclass,jobjectArray,jobjectArray);
extern int klj_framework_registration(JNIEnv*,jclass,const JNINativeMethod*,jint,JNINativeMethod**,jint*);
int klj_registration_install(JNIEnv *env){(void)env;return 1;}
static void *publisher;
static jint platform_value(JNIEnv *env,jclass type){(void)env;(void)type;return 23;}
static jint original_value(JNIEnv *env,jclass type){(void)env;(void)type;return 31;}
JNIEXPORT void JNICALL Java_RegistrationOwnerProbe_initialize(JNIEnv *env,jclass type,jstring path){
    jclass string=(*env)->FindClass(env,"java/lang/String");
    jobjectArray a=(*env)->NewObjectArray(env,1,string,(*env)->NewStringUTF(env,"RegistrationOwnerProbe$Retained"));
    jobjectArray b=(*env)->NewObjectArray(env,1,string,(*env)->NewStringUTF(env,"RegistrationOwnerProbe$Platform"));
    Java_maclauncher_android_framework_JvmNativeMemory_configureRegistrationOwners(env,type,a,b);
    const char *name=(*env)->GetStringUTFChars(env,path,NULL);size_t length=strlen(name);
    publisher=dlopen(name,RTLD_LAZY|RTLD_LOCAL);
    jbyteArray bytes=(*env)->NewByteArray(env,(jsize)length);(*env)->SetByteArrayRegion(env,bytes,0,(jsize)length,(const jbyte*)name);
    (*env)->ReleaseStringUTFChars(env,path,name);
    Java_maclauncher_android_framework_JvmNativeMemory_prepareRegistration(env,type,bytes);
}
JNIEXPORT void JNICALL Java_RegistrationOwnerProbe_register(JNIEnv *env,jclass type,jboolean original){
    (void)type;
    const char *owners[]={"RegistrationOwnerProbe$Retained","RegistrationOwnerProbe$Platform","RegistrationOwnerProbe$Original"};
    for(int i=0;i<3;i++){
        jclass owner=(*env)->FindClass(env,owners[i]);
        JNINativeMethod methods[]={{"value","()I",original?(void*)original_value:i==1?(void*)platform_value:dlsym(publisher,"publisher_value")},{"added","()I",original_value}};
        jint count=original&&i==2?2:1;JNINativeMethod *selected=NULL;
        if(klj_framework_registration(env,owner,methods,count,&selected,&count)<0)return;
        (*env)->RegisterNatives(env,owner,selected?selected:methods,count);free(selected);
        if((*env)->ExceptionCheck(env))return;
    }
}
