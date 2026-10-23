#include <jni.h>
#include <stdio.h>
#include <assert.h>
JNIEXPORT jstring JNICALL Java_maclauncher_android_FusedPathsProbe_readOffset(JNIEnv *env,jclass type,jstring path,jint offset){
 (void)type;const char *name=(*env)->GetStringUTFChars(env,path,0);FILE *file=fopen(name,"rb");
 (*env)->ReleaseStringUTFChars(env,path,name);assert(file);assert(!fseek(file,offset,SEEK_SET));
 char bytes[128]={0};size_t count=fread(bytes,1,sizeof(bytes)-1,file);assert(!ferror(file)&&count);assert(!fclose(file));
 return (*env)->NewStringUTF(env,bytes);
}
