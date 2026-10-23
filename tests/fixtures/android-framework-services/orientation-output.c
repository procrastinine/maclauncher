#include <jni.h>
static jobject owner;
static jint requests;
static jlong allocate(JNIEnv *e,jclass type){(void)e;(void)type;return 1;}
static void initialize(JNIEnv *e,jclass type,jlong id,jstring title,jint width,jint height){(void)e;(void)type;(void)id;(void)title;(void)width;(void)height;}
static void attach(JNIEnv *e,jclass type,jlong id,jobject activity){(void)type;(void)id;if(owner)(*e)->DeleteGlobalRef(e,owner);owner=(*e)->NewGlobalRef(e,activity);}
static jboolean stop(JNIEnv *e,jclass type,jlong id,jobject callback){(void)e;(void)type;(void)id;(void)callback;return JNI_TRUE;}
static jboolean close_output(JNIEnv *e,jclass type,jlong id){(void)type;(void)id;if(owner)(*e)->DeleteGlobalRef(e,owner);owner=NULL;return JNI_TRUE;}
static void orient(JNIEnv *e,jclass type,jobject activity,jboolean landscape){
    (void)type;(void)landscape;
    if(!owner||!(*e)->IsSameObject(e,activity,owner)){
        jclass failure=(*e)->FindClass(e,"java/lang/AssertionError");
        if(failure)(*e)->ThrowNew(e,failure,"orientation reached a different native Activity owner");
        return;
    }
    requests++;
}
JNIEXPORT void JNICALL Java_maclauncher_android_OrientationProbe_install(JNIEnv *e,jclass type){
    (void)type;jclass session=(*e)->FindClass(e,"maclauncher/android/bridge/WindowSession");if(!session)return;
    JNINativeMethod methods[]={
        {"allocateNative","()J",(void*)allocate},{"initializeNative","(JLjava/lang/String;II)V",(void*)initialize},
        {"attachActivityNative","(JLandroid/app/Activity;)V",(void*)attach},
        {"orientationNative","(Landroid/app/Activity;Z)V",(void*)orient},
        {"stopNative","(JLjava/lang/Runnable;)Z",(void*)stop},{"closeNative","(J)Z",(void*)close_output}};
    (*e)->RegisterNatives(e,session,methods,sizeof(methods)/sizeof(methods[0]));(*e)->DeleteLocalRef(e,session);
}
JNIEXPORT jint JNICALL Java_maclauncher_android_OrientationProbe_requests(JNIEnv *e,jclass type){(void)e;(void)type;return requests;}
