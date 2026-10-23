#include <jni.h>
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm,void *unused){(void)vm;(void)unused;return JNI_VERSION_1_6;}
JNIEXPORT jint publisher_value(JNIEnv *env,jclass type){(void)env;(void)type;return 17;}
