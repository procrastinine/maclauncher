#include <jni.h>
#include <stdio.h>

JNIEXPORT jint JNICALL Java_maclauncher_android_FirstFailureClosedProbe_closeStderr(JNIEnv *env,jclass type){
    (void)env;(void)type;return fclose(stderr);
}
