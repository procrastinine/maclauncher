#include <jni.h>
#include <stdlib.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <assert.h>
// Force allocator reuse instead of relying on a probabilistic allocation loop.
static union {max_align_t alignment;unsigned char bytes[256];} slot;
static int occupied;
static void *reuse_calloc(size_t count,size_t size){assert(!occupied&&count*size<=sizeof slot.bytes);occupied=1;memset(slot.bytes,0,sizeof slot.bytes);return slot.bytes;}
static void reuse_free(void *pointer){assert(pointer==slot.bytes&&occupied);occupied=0;}
#define calloc reuse_calloc
#define free reuse_free
#include ANDROID_HANDLE_SOURCE
#undef free
#undef calloc
JNIEXPORT void JNICALL Java_NativeHandleLifetimeProbe_finalizeHandle(JNIEnv *env,jclass owner,jlong finalizer,jlong handle){
    (void)env;(void)owner;((void(*)(void*))(uintptr_t)finalizer)((void*)(uintptr_t)handle);
}
