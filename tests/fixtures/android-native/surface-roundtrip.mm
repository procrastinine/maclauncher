#include "native-surface.mm"
#include <pthread.h>
extern "C" {
jlong Java_maclauncher_android_framework_HostNativeHandle_create(JNIEnv*,jclass,jobject);
jobject Java_maclauncher_android_framework_HostNativeHandle_state(JNIEnv*,jclass,jlong);
jlong Java_maclauncher_android_framework_HostNativeHandle_retain(JNIEnv*,jclass,jlong);
void Java_maclauncher_android_framework_HostNativeHandle_release(JNIEnv*,jclass,jlong);
jlong Java_maclauncher_android_framework_HostNativeHandle_finalizer(JNIEnv*,jclass);
jlong Java_maclauncher_android_framework_HostNativeHandle_retainer(JNIEnv*,jclass);
JNIEXPORT void JNICALL Java_SurfaceRoundTripProbe_prepare(JNIEnv *env,jclass){
    // Bind this fixture's compiled, complete owner instead of the installed
    // runtime's older copy. These are real registry functions, not doubles.
    JNINativeMethod methods[]={
        {(char*)"create",(char*)"(Ljava/lang/AutoCloseable;)J",(void*)Java_maclauncher_android_framework_HostNativeHandle_create},
        {(char*)"state",(char*)"(J)Ljava/lang/Object;",(void*)Java_maclauncher_android_framework_HostNativeHandle_state},
        {(char*)"retain",(char*)"(J)J",(void*)Java_maclauncher_android_framework_HostNativeHandle_retain},
        {(char*)"release",(char*)"(J)V",(void*)Java_maclauncher_android_framework_HostNativeHandle_release},
        {(char*)"finalizer",(char*)"()J",(void*)Java_maclauncher_android_framework_HostNativeHandle_finalizer},
        {(char*)"retainer",(char*)"()J",(void*)Java_maclauncher_android_framework_HostNativeHandle_retainer}};
    auto owner=env->FindClass("maclauncher/android/framework/HostNativeHandle");if(owner){env->RegisterNatives(owner,methods,sizeof methods/sizeof *methods);env->DeleteLocalRef(owner);}
}
JNIEXPORT jobject JNICALL Java_SurfaceRoundTripProbe_roundTrip(JNIEnv *env,jclass,jlong window){
    auto method=(jobject(*)(JNIEnv*,void*))lookup("ANativeWindow_toSurface");
    if(!method){auto error=env->FindClass("java/lang/AssertionError");env->ThrowNew(error,"ANativeWindow_toSurface is unpublished");return nullptr;}
    return method(env,(void*)(uintptr_t)window);
}
JNIEXPORT void JNICALL Java_SurfaceRoundTripProbe_acquire(JNIEnv*,jclass,jlong window){auto method=(void(*)(void*))lookup("ANativeWindow_acquire");method((void*)(uintptr_t)window);}
JNIEXPORT void JNICALL Java_SurfaceRoundTripProbe_releaseWorker(JNIEnv *env,jclass,jlong window){
    pthread_t thread;int error=pthread_create(&thread,nullptr,[](void *value)->void*{auto method=(void(*)(void*))lookup("ANativeWindow_release");method(value);return nullptr;},(void*)(uintptr_t)window);
    if(!error)error=pthread_join(thread,nullptr);if(error){auto type=env->FindClass("java/lang/AssertionError");env->ThrowNew(type,"native Surface release worker");}
}
JNIEXPORT void JNICALL Java_SurfaceRoundTripProbe_releasePending(JNIEnv *env,jclass,jlong window,jthrowable failure){env->Throw(failure);auto method=(void(*)(void*))lookup("ANativeWindow_release");method((void*)(uintptr_t)window);}
}
