#include <jni.h>
#include <android/native_window_jni.h>

JNIEXPORT jint JNICALL Java_ArtWindowBufferProbe_geometry(JNIEnv *env,jclass owner,jobject surface,jint width,jint height){
    (void)owner;ANativeWindow *window=ANativeWindow_fromSurface(env,surface);
    int result=ANativeWindow_setBuffersGeometry(window,width,height,0);ANativeWindow_release(window);return result;
}
JNIEXPORT jlong JNICALL Java_ArtWindowBufferProbe_defaults(JNIEnv *env,jclass owner,jobject surface){
    (void)owner;ANativeWindow *window=ANativeWindow_fromSurface(env,surface);
    jlong result=((jlong)ANativeWindow_getWidth(window)<<32)|(unsigned)ANativeWindow_getHeight(window);ANativeWindow_release(window);return result;
}
