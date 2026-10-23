#include <jni.h>
#include <stdlib.h>
#include <string.h>
#include <malloc/malloc.h>
extern jlong Java_android_os_Debug_getNativeHeapAllocatedSize(JNIEnv*,jclass);
JNIEXPORT jlongArray JNICALL Java_HeapProbe_allocationDelta(JNIEnv*e,jclass type,jint n){
 if(n<1||n>16777216)return NULL;
 jlong v[3];v[0]=Java_android_os_Debug_getNativeHeapAllocatedSize(e,type);
 void*p=malloc((size_t)n);if(!p)return NULL;memset(p,0x55,(size_t)n);
 if(malloc_size(p)<(size_t)n){free(p);return NULL;}
 v[1]=Java_android_os_Debug_getNativeHeapAllocatedSize(e,type);free(p);v[2]=Java_android_os_Debug_getNativeHeapAllocatedSize(e,type);
 jlongArray result=(*e)->NewLongArray(e,3);if(result)(*e)->SetLongArrayRegion(e,result,0,3,v);return result;
}
