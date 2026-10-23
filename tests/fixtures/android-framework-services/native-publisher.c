#include <jni.h>
static int initialized;
static jint wrong(JNIEnv *env,jclass type,...){(void)env;(void)type;return -999;}
static jint remaining(JNIEnv *env,jclass type){(void)env;(void)type;return 42;}
static jint overloaded(JNIEnv *env,jclass type,jstring value){(void)env;(void)type;(void)value;return 82;}
static jint java_overload(JNIEnv *env,jclass type,jstring value){(void)env;(void)type;(void)value;return 83;}
static jint initializations(JNIEnv *env,jclass type){(void)env;(void)type;return initialized;}
static void register_again(JNIEnv *env,jclass type);
static const JNINativeMethod methods[]={
    {"javaBoundary","()I",(void*)wrong},{"remaining","()I",(void*)remaining},
    {"nativeOverride","()I",(void*)wrong},{"overloaded","(I)I",(void*)wrong},
    {"overloaded","(Ljava/lang/String;)I",(void*)overloaded},
    {"javaOverloaded","(I)I",(void*)wrong},{"javaOverloaded","(Ljava/lang/String;)I",(void*)java_overload},
    {"under_score","()I",(void*)wrong},{"initializations","()I",(void*)initializations},
    {"registerAgain","()V",(void*)register_again}
};
static void register_again(JNIEnv *env,jclass type){(*env)->RegisterNatives(env,type,methods,sizeof methods/sizeof*methods);}
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm,void *reserved){
    (void)reserved;JNIEnv *env=NULL;if((*vm)->GetEnv(vm,(void**)&env,JNI_VERSION_1_6)!=JNI_OK)return JNI_ERR;
    jclass bootstrap=(*env)->FindClass(env,"java/lang/String");if(!bootstrap)return JNI_ERR;
    const JNINativeMethod implemented={"length","()I",(void*)wrong};
    jint bootstrap_result=(*env)->RegisterNatives(env,bootstrap,&implemented,1);(*env)->DeleteLocalRef(env,bootstrap);
    if(bootstrap_result!=JNI_OK)return JNI_ERR;
    ++initialized;jclass type=(*env)->FindClass(env,"NativePublisherProbe$Target");if(!type)return JNI_ERR;
    jint result=(*env)->RegisterNatives(env,type,methods,sizeof methods/sizeof*methods);(*env)->DeleteLocalRef(env,type);
    return result==JNI_OK?JNI_VERSION_1_6:JNI_ERR;
}
