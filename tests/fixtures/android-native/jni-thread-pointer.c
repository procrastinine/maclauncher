#include <jni.h>
#include <stdint.h>

static uintptr_t constructor_pointer,onload_pointer;
static int constructor_valid,onload_valid;
static __attribute__((noinline)) uintptr_t android_pointer(void){
    uintptr_t pointer;
    __asm__ volatile("mrs %0, tpidr_el0":"=r"(pointer));
    return pointer;
}
static int valid(uintptr_t pointer){
    return pointer&&((const volatile uintptr_t *)pointer)[5]!=0;
}
__attribute__((constructor)) static void construct(void){
    constructor_pointer=android_pointer();
    constructor_valid=valid(constructor_pointer);
}
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm,void *reserved){
    (void)vm;(void)reserved;
    onload_pointer=android_pointer();
    onload_valid=valid(onload_pointer)&&onload_pointer==constructor_pointer;
    return JNI_VERSION_1_6;
}
JNIEXPORT jint JNICALL Java_JniThreadPointerProbe_state(JNIEnv *env,jclass type){
    (void)env;(void)type;
    return constructor_valid|(onload_valid<<1)|(valid(android_pointer())<<2);
}
JNIEXPORT jlong JNICALL Java_JniThreadPointerProbe_pointer(JNIEnv *env,jclass type){
    (void)env;(void)type;
    uintptr_t pointer=android_pointer();
    return valid(pointer)?(jlong)pointer:0;
}
