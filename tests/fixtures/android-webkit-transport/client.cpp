#include <jni.h>
#include <unistd.h>
#include "maclauncher_android_web_WebKitNative.h"
extern "C" jint Java_maclauncher_android_ArtWebKit_openNative(JNIEnv*,jclass,jstring,jstring);
extern "C" void Java_maclauncher_android_ArtWebKit_dispatchNative(JNIEnv*,jclass);
extern "C" void Java_maclauncher_android_ArtWebKit_closeNative(JNIEnv*,jclass);
static void open(JNIEnv*e,jclass c,jstring path,jstring token){int fd=Java_maclauncher_android_ArtWebKit_openNative(e,c,path,token);if(fd>=0)::close(fd);}
#define METHOD(name,descriptor) {const_cast<char*>(#name),const_cast<char*>(descriptor),reinterpret_cast<void*>(Java_maclauncher_android_web_WebKitNative_##name)}
extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM*vm,void*){
 JNIEnv*e=nullptr;if(vm->GetEnv(reinterpret_cast<void**>(&e),JNI_VERSION_1_6)!=JNI_OK)return JNI_ERR;
 jclass type=e->FindClass("BrowserTransportProbe");if(!type)return JNI_ERR;
 JNINativeMethod methods[]={
  {const_cast<char*>("open"),const_cast<char*>("(Ljava/lang/String;Ljava/lang/String;)V"),reinterpret_cast<void*>(open)},
  {const_cast<char*>("dispatch"),const_cast<char*>("()V"),reinterpret_cast<void*>(Java_maclauncher_android_ArtWebKit_dispatchNative)},
  {const_cast<char*>("close"),const_cast<char*>("()V"),reinterpret_cast<void*>(Java_maclauncher_android_ArtWebKit_closeNative)},
  METHOD(initialize,"(Ljava/lang/String;Ljava/lang/String;Z)Ljava/lang/String;"),METHOD(create,"(LBrowserTransportProbe;)J"),METHOD(destroy,"(J)V"),METHOD(size,"(JIIF)V"),METHOD(visibility,"(JZ)V"),
  METHOD(html,"(JLjava/lang/String;Ljava/lang/String;)V"),METHOD(load,"(JLjava/lang/String;[Ljava/lang/String;[Ljava/lang/String;[B)V"),METHOD(interfaces,"(JLjava/lang/String;)V"),METHOD(script,"(JLjava/lang/String;J)V"),METHOD(snapshot,"(J)V"),METHOD(setting,"(JLjava/lang/String;Ljava/lang/String;)V"),METHOD(dialogResult,"(JJZLjava/lang/String;)V"),METHOD(cookies,"(Ljava/lang/String;)Ljava/lang/String;"),
  METHOD(cookieCommand,"(Ljava/lang/String;Ljava/lang/String;LBrowserTransportProbe;)V"),METHOD(storageCommand,"(Ljava/lang/String;Ljava/lang/String;LBrowserTransportProbe;)V")
 };
 int result=e->RegisterNatives(type,methods,sizeof(methods)/sizeof(*methods));e->DeleteLocalRef(type);return result==JNI_OK?JNI_VERSION_1_6:JNI_ERR;
}
