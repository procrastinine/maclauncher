#include <jni.h>
#include <android/log.h>
#include <poll.h>
#include <string.h>
#include <unistd.h>

JNIEXPORT jint JNICALL Java_maclauncher_android_ArtLogInitProbe_probe(JNIEnv *env,jclass owner){
 (void)env;(void)owner;int descriptors[2],savedOut=dup(1),savedErr=dup(2),result=0;
 if(__android_log_get_minimum_priority()!=ANDROID_LOG_INFO)return 11;
 __android_log_write(ANDROID_LOG_DEBUG,"LogInitControl","CONTROL_NATIVE_DEBUG_AFTER_VM");
 if(savedOut<0||savedErr<0||pipe(descriptors))return 1;
 if(dup2(descriptors[1],1)!=1||dup2(descriptors[1],2)!=2){result=2;goto done;}
 if(__android_log_write(4,"ArtNative","after redirect")<0){result=3;goto done;}
 const char marker[]="ordinary-guest-stdio";char bytes[256]={0};
 if(write(2,marker,sizeof marker-1)!=(ssize_t)sizeof marker-1){result=4;goto done;}
 ssize_t count=read(descriptors[0],bytes,sizeof bytes);
 if(count!=(ssize_t)sizeof marker-1||memcmp(bytes,marker,sizeof marker-1)){result=5;goto done;}
 struct pollfd wait={.fd=descriptors[0],.events=POLLIN};
 if(poll(&wait,1,20)!=0){result=6;goto done;}
 if(close(1)||close(2)){result=7;goto done;}
 if(__android_log_print(5,"ArtNative","after close %d",42)<0){result=8;goto done;}
 jmethodID report=(*env)->GetStaticMethodID(env,owner,"reportAfterClose","()V");
 if(!report){result=9;goto done;}
 (*env)->CallStaticVoidMethod(env,owner,report);
 if((*env)->ExceptionCheck(env)){result=10;goto done;}
done:
 dup2(savedOut,1);dup2(savedErr,2);close(savedOut);close(savedErr);close(descriptors[0]);close(descriptors[1]);return result;
}
