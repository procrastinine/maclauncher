#include <jni.h>
#include "host-callbacks.h"
static float area[5];
static KLHostCallbacks*callbacks;
static void enable(JNIEnv*env,jclass type,jboolean enabled){(void)env;(void)type;(void)enabled;}
static void publish(JNIEnv*env,jclass type,jfloat left,jfloat top,jfloat right,jfloat bottom){(void)env;(void)type;area[0]=left;area[1]=top;area[2]=right;area[3]=bottom;area[4]++;}
JNIEXPORT jfloatArray JNICALL Java_maclauncher_android_TextInputGeometryProbe_snapshot(JNIEnv*env,jclass type){(void)type;jfloatArray value=(*env)->NewFloatArray(env,5);if(value)(*env)->SetFloatArrayRegion(env,value,0,5,area);return value;}
JNIEXPORT void JNICALL Java_maclauncher_android_TextInputGeometryProbe_dispatchText(JNIEnv*env,jclass type,jstring value){(void)type;kl_host_text_input(env,callbacks,(KLHost_java_lang_String){value},JNI_FALSE,0,0);}
JNIEXPORT void JNICALL Java_maclauncher_android_TextInputGeometryProbe_retireNative(JNIEnv*env,jclass type){(void)type;kl_host_callbacks_release(env,callbacks);callbacks=0;}
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM*vm,void*reserved){(void)reserved;JNIEnv*env=0;if((*vm)->GetEnv(vm,(void**)&env,JNI_VERSION_1_6)!=JNI_OK)return JNI_ERR;jclass owner=(*env)->FindClass(env,"maclauncher/android/framework/HostTextInput");if(!owner)return JNI_ERR;JNINativeMethod methods[]={{"enableNative","(Z)V",(void*)enable},{"areaNative","(FFFF)V",(void*)publish}};jint result=(*env)->RegisterNatives(env,owner,methods,2);(*env)->DeleteLocalRef(env,owner);if(result!=JNI_OK)return JNI_ERR;callbacks=kl_host_callbacks_create(env);return callbacks?JNI_VERSION_1_6:JNI_ERR;}
