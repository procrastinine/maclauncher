#include <jni.h>
#include <assert.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
JNIEXPORT jintArray JNICALL Java_maclauncher_android_ProcessAuthority_pair(JNIEnv *env,jclass type){
    (void)type;int fd[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,fd));
    assert(!fcntl(fd[0],F_SETFL,O_NONBLOCK));
    jint values[2]={fd[0],fd[1]};jintArray out=(*env)->NewIntArray(env,2);(*env)->SetIntArrayRegion(env,out,0,2,values);return out;
}
JNIEXPORT void JNICALL Java_maclauncher_android_ProcessAuthority_echo(JNIEnv *env,jclass type,jint fd,jbyteArray expected){
    (void)type;uint32_t header;assert(read(fd,&header,4)==4);size_t size=ntohl(header);
    assert(size==(size_t)(*env)->GetArrayLength(env,expected));char *data=malloc(size);assert(data&&read(fd,data,size)==(ssize_t)size);
    jbyte *bytes=(*env)->GetByteArrayElements(env,expected,NULL);assert(!memcmp(data,bytes,size));(*env)->ReleaseByteArrayElements(env,expected,bytes,JNI_ABORT);
    assert(write(fd,&header,4)==4);assert(write(fd,data,size)==(ssize_t)size);free(data);
}
JNIEXPORT jboolean JNICALL Java_maclauncher_android_ProcessAuthority_closed(JNIEnv *env,jclass type,jint fd){(void)env;(void)type;return fcntl(fd,F_GETFD)==-1&&errno==EBADF;}
JNIEXPORT void JNICALL Java_maclauncher_android_ProcessAuthority_sendFixture(JNIEnv *env,jclass type,jint fd,jbyteArray data){
    (void)type;jsize length=(*env)->GetArrayLength(env,data);uint32_t header=htonl((uint32_t)length);assert(write(fd,&header,sizeof header)==sizeof header);
    if(length){jbyte *bytes=(*env)->GetByteArrayElements(env,data,NULL);assert(bytes&&write(fd,bytes,(size_t)length)==length);(*env)->ReleaseByteArrayElements(env,data,bytes,JNI_ABORT);}
}
JNIEXPORT void JNICALL Java_maclauncher_android_ProcessAuthority_closeFixture(JNIEnv *env,jclass type,jint fd){(void)env;(void)type;close(fd);}
