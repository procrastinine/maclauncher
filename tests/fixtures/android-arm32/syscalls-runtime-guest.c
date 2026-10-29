#include "syscall-test-numbers.h"
#include <jni.h>
#include <stdint.h>
__attribute__((visibility("default")))
jint Java_SyscallFixture_pid(JNIEnv *environment,jclass type){
  (void)environment;(void)type;
  register unsigned number __asm__("r7")=NR_getpid;
  register int result __asm__("r0")=0;
  __asm__ volatile("svc #0" : "+r"(result) : "r"(number) : "memory");
  return result;
}
jint Java_SyscallFixture_borrowedBuffer(JNIEnv *environment,jclass type,jintArray array) {
  (void)type;
  jint *value=(*environment)->GetIntArrayElements(environment,array,0);
  *value+=7;
  uintptr_t address=(uintptr_t)value;
  (*environment)->ReleaseIntArrayElements(environment,array,value,0);
  return (jint)address;
}
jint Java_SyscallFixture_readRetired(JNIEnv *environment,jclass type,jint address) {
  (void)environment;(void)type;
  return *(volatile jint *)(uintptr_t)(uint32_t)address;
}
// A native finalizer commonly has no exported symbol. Preserve the Thumb bit
// and dispatch its actual address through the same invocation as named exports.
static void finish_buffer(JNIEnv *environment,jclass type,jintArray array) {
  (void)type;
  jint *value=(*environment)->GetIntArrayElements(environment,array,0);
  *value=*value*3+1;
  (*environment)->ReleaseIntArrayElements(environment,array,value,0);
}
jint Java_SyscallFixture_bufferFinalizer(JNIEnv *environment,jclass type) {
  (void)environment;(void)type;
  return (jint)(uintptr_t)finish_buffer;
}
