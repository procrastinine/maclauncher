#include "../android-native/owner-mock.c"

JNIEXPORT jint JNICALL Java_PackageContextProbe_count(JNIEnv *env,jclass type) {
    (void)env;(void)type;return atomic_load(&live);
}
JNIEXPORT jlong JNICALL Java_maclauncher_android_bridge_Bridge_preferences(JNIEnv *env,jclass type,jbyteArray directory,jbyteArray name) {
    (void)type;(void)directory;(void)name;return create(env);
}
