#include "../../../src/modules/android/native/connectivity.c"
JNIEXPORT void JNICALL Java_android_net_NetworkProbe_publish(JNIEnv *env,jclass cls,jint value){CFArrayRef rows=CFArrayCreate(NULL,NULL,0,&kCFTypeArrayCallBacks);publish(value,rows);CFRelease(rows);}
JNIEXPORT jint JNICALL Java_android_net_NetworkProbe_nativeOwners(JNIEnv *env,jclass cls){pthread_mutex_lock(&lock);int result=owner!=NULL;pthread_mutex_unlock(&lock);return result;}
JNIEXPORT jint JNICALL Java_android_net_NetworkCloseProbe_nativeState(JNIEnv *env,jclass cls){pthread_mutex_lock(&lock);int result=(monitor?1:0)|(queue?2:0)|(owner?4:0)|(pending_failure?8:0)|(closed?16:0);pthread_mutex_unlock(&lock);return result;}
JNIEXPORT void JNICALL Java_android_net_NetworkCloseProbe_publish(JNIEnv *env,jclass cls,jint value){CFArrayRef rows=CFArrayCreate(NULL,NULL,0,&kCFTypeArrayCallBacks);publish(value,rows);CFRelease(rows);}
