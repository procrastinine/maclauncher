#include <jni.h>
#include <stdio.h>
#include <stdint.h>
#include <stddef.h>
static int guest;
static void *slot=(void*)puts;
const char *kl_addr_image(const void *address,size_t *offset){if(address!=&guest)return NULL;*offset=0x1234;return "fixture-guest.so";}
const char *kl_il2cpp_method_at(const void *address){return address==&guest?"fixtureMethod":NULL;}
JNIEXPORT jlongArray JNICALL Java_maclauncher_test_AndroidTestAgent_fixturePointers(JNIEnv *env,jclass type){
 (void)type;jlong values[]={(jlong)(uintptr_t)&slot,(jlong)(uintptr_t)&guest};jlongArray result=(*env)->NewLongArray(env,2);if(result)(*env)->SetLongArrayRegion(env,result,0,2,values);return result;
}
