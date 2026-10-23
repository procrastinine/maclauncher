#include <jni.h>
extern void *klj_graphics_symbol(const char *);
static void problem(JNIEnv *env,const char *message){jclass type=(*env)->FindClass(env,"java/lang/IllegalArgumentException");if(type)(*env)->ThrowNew(env,type,message);}
JNIEXPORT jint JNICALL Java_maclauncher_android_bridge_NativeSymbols_check(JNIEnv *env,jclass type,jobjectArray names){
    jsize count=(*env)->GetArrayLength(env,names);if(count>256){problem(env,"ANGLE preflight symbol list exceeds its bound");return 0;}
    for(jsize i=0;i<count;i++){
        jstring value=(*env)->GetObjectArrayElement(env,names,i);if(!value||(*env)->ExceptionCheck(env))return 0;
        const char *name=(*env)->GetStringUTFChars(env,value,NULL);if(!name)return 0;
        void *symbol=klj_graphics_symbol(name);(*env)->ReleaseStringUTFChars(env,value,name);(*env)->DeleteLocalRef(env,value);
        if(!symbol)return 0;
    }
    return count;
}
