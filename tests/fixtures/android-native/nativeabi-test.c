#include <jni.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
extern void *klj_native_abi(void *,const char *,char *,size_t);
extern void klj_abi_capture_target(void);
uint64_t klj_abi_capture_values[32];
uint32_t klj_abi_capture_stack;
JNIEXPORT void JNICALL Java_probe_NativeAbiProbe_grow(JNIEnv *e,jclass cls){
    (void)cls;static unsigned char targets[3073];char error[512];
    for(size_t i=0;i<sizeof targets;i++){
        void *first=klj_native_abi(targets+i,"(IIIIIIII)J",error,sizeof error);
        if(!first||first!=klj_native_abi(targets+i,"(IIIIIIII)J",error,sizeof error)){
            jclass failure=(*e)->FindClass(e,"java/lang/AssertionError");
            if(failure)(*e)->ThrowNew(e,failure,first?"Stack adapter identity changed":error);return;
        }
    }
}
JNIEXPORT void JNICALL Java_probe_NativeAbiProbe_bind(JNIEnv *e,jclass cls,jstring method,jstring descriptor,jint count){
    const char *name=(*e)->GetStringUTFChars(e,method,NULL);if(!name)return;
    const char *signature=(*e)->GetStringUTFChars(e,descriptor,NULL);if(!signature){(*e)->ReleaseStringUTFChars(e,method,name);return;}
    char error[512];void *entry=klj_native_abi(klj_abi_capture_target,signature,error,sizeof error);
    if(!entry){jclass failure=(*e)->FindClass(e,"java/lang/IllegalStateException");if(failure)(*e)->ThrowNew(e,failure,error);}
    else{klj_abi_capture_stack=count;JNINativeMethod binding={(char*)name,(char*)signature,entry};(*e)->RegisterNatives(e,cls,&binding,1);}
    (*e)->ReleaseStringUTFChars(e,method,name);(*e)->ReleaseStringUTFChars(e,descriptor,signature);
}
JNIEXPORT jlongArray JNICALL Java_probe_NativeAbiProbe_capture(JNIEnv *e,jclass cls){(void)cls;jlongArray values=(*e)->NewLongArray(e,32);if(values)(*e)->SetLongArrayRegion(e,values,0,32,(jlong*)klj_abi_capture_values);return values;}

JNIEnv *klj_guest_env(JNIEnv *env){return env;}
