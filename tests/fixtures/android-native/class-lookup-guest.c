#include <jni.h>
__attribute__((noinline)) jclass guest_find(JNIEnv *env,const char *name){
    jclass value=(*env)->FindClass(env,name);
    __asm__ volatile("" : "+r"(value) :: "memory");
    return value;
}
