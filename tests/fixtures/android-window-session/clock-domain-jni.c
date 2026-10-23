#include <jni.h>
#include <stdint.h>
#include <time.h>
#include "native-clock/clock-domain.h"
/* Compare the real full-framework SystemClock with native clock domains. */
JNIEXPORT jlong JNICALL Java_ClockProbe_guest(JNIEnv* e,jclass c,jint id){
 (void)e;(void)c;struct timespec ts;if(klj_clock_read(id,&ts))return -1;
 return (jlong)((uint64_t)ts.tv_sec*1000000000ull+ts.tv_nsec);
}
JNIEXPORT jlong JNICALL Java_ClockProbe_nativeUptime(JNIEnv* e,jclass c){(void)e;(void)c;return clock_gettime_nsec_np(CLOCK_UPTIME_RAW);}
JNIEXPORT jlong JNICALL Java_ClockProbe_nativeContinuous(JNIEnv* e,jclass c){(void)e;(void)c;return clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);}
