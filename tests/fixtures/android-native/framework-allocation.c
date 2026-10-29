#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <assert.h>
static _Atomic int released;
static void release(void *pointer) {
    // Original NativeAllocationRegistry invokes this host callback directly;
    // a Klepton guest invocation scope is not part of its callback contract.
    if(!pointer||*(uint64_t *)pointer!=UINT64_C(0xabcdef1234567890))abort();
    free(pointer);atomic_fetch_add(&released,1);
}
JNIEXPORT jlong JNICALL Java_FrameworkAllocationProbe_allocate(JNIEnv *env,jclass type) {
    (void)env;(void)type;uint64_t *p=malloc(sizeof *p);
    if(!p)return 0;*p=UINT64_C(0xabcdef1234567890);return (jlong)(uintptr_t)p;
}
JNIEXPORT jlong JNICALL Java_FrameworkAllocationProbe_freeFunction(JNIEnv *env,jclass type) {
    (void)env;(void)type;return (jlong)(uintptr_t)release;
}
JNIEXPORT jint JNICALL Java_FrameworkAllocationProbe_released(JNIEnv *env,jclass type) {
    (void)env;(void)type;return atomic_load(&released);
}
