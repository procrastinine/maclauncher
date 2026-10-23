#include <jni.h>
#include <dlfcn.h>
JNIEXPORT jint JNICALL Java_maclauncher_android_bridge_TargetSdkProbe_acceptSdk(JNIEnv *env,jclass ignored,jstring runtime,jint sdk){
    (void)ignored;const char *path=(*env)->GetStringUTFChars(env,runtime,0);if(!path)return -1;
    void *core=dlopen(path,RTLD_NOW|RTLD_NOLOAD);(*env)->ReleaseStringUTFChars(env,runtime,path);
    if(!core)return -2;int (*configure)(unsigned)=dlsym(core,"klj_library_set_target_sdk");
    int result=configure?configure((unsigned)sdk):-3;dlclose(core);return result;
}
