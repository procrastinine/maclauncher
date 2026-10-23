#include <stdatomic.h>
static _Atomic long outstanding;
static _Atomic long environments;
static _Thread_local int fail_next;
static void track(void *memory){if(memory)atomic_fetch_add(&outstanding,1);}
static int injected(JNIEnv *env,int stage){if(fail_next!=stage)return 0;fail_next=0;jclass type=(*env)->FindClass(env,"java/lang/OutOfMemoryError");if(type){(*env)->ThrowNew(env,type,"Injected inventory allocation failure");(*env)->DeleteLocalRef(env,type);}return 1;}
JNIEXPORT void JNICALL Java_maclauncher_android_bridge_Probe_failNext(JNIEnv *e,jclass c,jint stage){fail_next=stage;}
JNIEXPORT jlong JNICALL Java_maclauncher_android_bridge_Probe_outstanding(JNIEnv *e,jclass c){return atomic_load(&outstanding)+atomic_load(&environments);}

