#include <jni.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <limits.h>
#include <sys/mount.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <assert.h>
#include <dirent.h>

typedef const char *(*Resolver)(const char *,char *,size_t);
static Resolver resolver;
#ifdef KL_TEST_DIRECT_MAPPER
/* Mapping-only fixture; actual descriptor ownership has a separate native proof. */
int klj_directory_descriptor_adopt(int fd){(void)fd;return 0;}
const char *kl_guest_path(const char *path,char *buffer,size_t capacity){const char *mapped=resolver(path,buffer,capacity);return mapped?mapped:path;}
#endif
#ifdef KL_TEST_STATFS_SOURCE
#include KL_TEST_STATFS_SOURCE
#endif
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm,void *unused){
    (void)vm;(void)unused;
#ifdef KL_TEST_DIRECT_MAPPER
    resolver=(Resolver)dlsym(RTLD_DEFAULT,"klj_mapped_guest_path");
#else
    resolver=(Resolver)dlsym(RTLD_DEFAULT,"kl_guest_path");
#endif
    return resolver?JNI_VERSION_1_6:JNI_ERR;
}
static char *input(JNIEnv *env,jbyteArray bytes){jsize length=(*env)->GetArrayLength(env,bytes);char *path=malloc((size_t)length+1);if(path){(*env)->GetByteArrayRegion(env,bytes,0,length,(jbyte*)path);path[length]=0;}return path;}
JNIEXPORT void JNICALL Java_NativeGuestPathsProbe_storageStats(JNIEnv *env,jclass owner,jbyteArray guest,jbyteArray host){
    (void)owner;int (*query)(const char *,void *)=dlsym(RTLD_DEFAULT,"klb_statfs");
#if defined(KL_TEST_DIRECT_MAPPER) && !defined(KL_TEST_STATFS_SOURCE)
    if(!query)return; /* The mapping-only fixture has no guest libc supplier. */
#endif
    char *virtual=input(env,guest),*actual=input(env,host);struct statfs expected;
    uint64_t words[15]={0};int good=query&&virtual&&actual&&!statfs(actual,&expected)&&!query(virtual,words);
    if(good)good=words[1]==expected.f_bsize&&words[2]==expected.f_blocks&&words[3]<=words[2]&&words[4]<=words[2];
    free(virtual);free(actual);if(!good){jclass error=(*env)->FindClass(env,"java/lang/AssertionError");if(error)(*env)->ThrowNew(env,error,"Guest statfs did not describe the mapped private filesystem");}
}
JNIEXPORT jbyteArray JNICALL Java_NativeGuestPathsProbe_resolve(JNIEnv *env,jclass owner,jbyteArray bytes,jint capacity){
    (void)owner;char *path=input(env,bytes),*buffer=malloc((size_t)capacity);if(!path||!buffer){free(path);free(buffer);return NULL;}
    const char *mapped=resolver(path,buffer,(size_t)capacity);if(!mapped)mapped=path;
    jsize size=(jsize)strlen(mapped);jbyteArray result=(*env)->NewByteArray(env,size);if(result)(*env)->SetByteArrayRegion(env,result,0,size,(const jbyte*)mapped);free(path);free(buffer);return result;
}
JNIEXPORT jbyteArray JNICALL Java_NativeGuestPathsProbe_read(JNIEnv *env,jclass owner,jbyteArray bytes){
    (void)owner;char *path=input(env,bytes),buffer[4096];if(!path)return NULL;const char *mapped=resolver(path,buffer,sizeof buffer);if(!mapped)mapped=path;
    FILE *file=fopen(mapped,"rb");if(!file){jclass error=(*env)->FindClass(env,"java/io/IOException");if(error)(*env)->ThrowNew(env,error,strerror(errno));free(path);return NULL;}
    char data[256];size_t size=fread(data,1,sizeof data,file);fclose(file);free(path);jbyteArray result=(*env)->NewByteArray(env,(jsize)size);if(result)(*env)->SetByteArrayRegion(env,result,0,(jsize)size,(const jbyte*)data);return result;
}
