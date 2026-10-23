#include <jni.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

JNIEXPORT jbyteArray JNICALL Java_maclauncher_android_framework_StorageNamespaceProbe_nativeEnvironment(JNIEnv *env,jclass type,jstring key){
    (void)type;
    const char *name=(*env)->GetStringUTFChars(env,key,NULL);if(!name)return NULL;
    const char *value=getenv(name);
    (*env)->ReleaseStringUTFChars(env,key,name);
    if(!value)return NULL;
    size_t length=strlen(value);jbyteArray result=(*env)->NewByteArray(env,(jsize)length);
    if(result)(*env)->SetByteArrayRegion(env,result,0,(jsize)length,(const jbyte*)value);
    return result;
}

JNIEXPORT jint JNICALL Java_SandboxProbe_nativeAccess(JNIEnv *env,jclass type,jstring value,jboolean writeAccess){
    (void)type;
    const char *path=(*env)->GetStringUTFChars(env,value,NULL);if(!path)return -1;
    int fd=open(path,writeAccess?O_WRONLY:O_RDONLY),result=fd<0?errno:0;
    (*env)->ReleaseStringUTFChars(env,value,path);
    if(fd>=0){char byte='N';ssize_t count=writeAccess?write(fd,&byte,1):read(fd,&byte,1);if(count!=1)result=count<0?errno:EIO;close(fd);}
    return result;
}
