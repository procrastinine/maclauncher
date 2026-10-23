#include <jni.h>
#include <jvmti.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stddef.h>

extern int klj_registration_prepare(JNIEnv*,void*,void*);
static int abi_count;
static jint guest(JNIEnv *env,jclass type){(void)env;(void)type;return 77;}
static jint closure(JNIEnv *env,jclass type){(void)env;(void)type;return 78;}
// A one-address synthetic guest image exercises the real shared dispatcher
// without pretending the publisher or platform's other functions are ELF code.
void *kl_base(void *image){(void)image;return (void*)guest;}
size_t kl_span(void *image){(void)image;return 1;}
void *klj_native_abi(void *entry,const char *descriptor,char *error,size_t size){(void)descriptor;(void)error;(void)size;++abi_count;return entry;}
int klj_jni_calls_prepare(JNIEnv *env,jniNativeInterface *table,jvmtiEnv *ti){(void)env;(void)ti;return table->RegisterNatives!=NULL;}
int klj_class_lookup_prepare(JNIEnv *env,jniNativeInterface *table){(void)env;return table->RegisterNatives!=NULL;}
int klj_field_lookup_prepare(JNIEnv *env,jniNativeInterface *table){(void)env;return table->GetFieldID!=NULL;}
void klj_jni_calls_abort(jvmtiEnv *ti){(void)ti;}
JNIEXPORT jint JNICALL Java_NativePublisherProbe_00024Target_nativeOverride(JNIEnv *env,jclass type){(void)env;(void)type;return 700;}
JNIEXPORT jint JNICALL Java_NativePublisherProbe_00024Target_overloaded__I(JNIEnv *env,jclass type,jint value){(void)env;(void)type;return 700+value;}
JNIEXPORT jint JNICALL Java_NativePublisherProbe_00024Target_under_1score(JNIEnv *env,jclass type){(void)env;(void)type;return 704;}
JNIEXPORT jint JNICALL Java_NativePublisherProbe_00024SystemTarget_nativeOverride(JNIEnv *env,jclass type){(void)env;(void)type;return 901;}
JNIEXPORT void JNICALL Java_NativePublisherProbe_installGuestHooks(JNIEnv *env,jclass type){
    (void)type;Dl_info info={0};if(!dladdr((void*)guest,&info))return;
    void *library=dlopen(info.dli_fname,RTLD_NOW|RTLD_LOCAL);
    if(library){klj_registration_prepare(env,library,(void*)1);dlclose(library);}
}
JNIEXPORT void JNICALL Java_NativePublisherProbe_registerGuest(JNIEnv *env,jclass type){
    (void)type;jclass owner=(*env)->FindClass(env,"NativePublisherProbe$Guest");if(!owner)return;
    const JNINativeMethod method={"call","()I",(void*)guest};(*env)->RegisterNatives(env,owner,&method,1);(*env)->DeleteLocalRef(env,owner);
}
JNIEXPORT jint JNICALL Java_NativePublisherProbe_adaptations(JNIEnv *env,jclass type){(void)env;(void)type;return abi_count;}
JNIEXPORT void JNICALL Java_NativePublisherProbe_registerSystem(JNIEnv *env,jclass type){
    (void)type;jclass owner=(*env)->FindClass(env,"NativePublisherProbe$SystemTarget");if(!owner)return;
    const JNINativeMethod methods[]={
        {"javaBoundary","()I",(void*)guest},{"nativeOverride","()I",(void*)guest},
        {"nativeRemaining","()I",(void*)guest},{"closureRemaining","()I",(void*)closure}
    };
    (*env)->RegisterNatives(env,owner,methods,sizeof methods/sizeof*methods);(*env)->DeleteLocalRef(env,owner);
}
JNIEXPORT void JNICALL Java_NativePublisherProbe_registerApplication(JNIEnv *env,jclass type,jclass owner,jboolean java_method){
    (void)type;const JNINativeMethod method={java_method?"javaBoundary":"nativeOverride","()I",(void*)closure};
    (*env)->RegisterNatives(env,owner,&method,1);
}
JNIEXPORT void JNICALL Java_NativePublisherProbe_registerMissing(JNIEnv *env,jclass type){
    (void)type;jclass owner=(*env)->FindClass(env,"NativePublisherProbe$SystemTarget");if(!owner)return;
    const JNINativeMethod method={"missing","()I",(void*)closure};
    (*env)->RegisterNatives(env,owner,&method,1);(*env)->DeleteLocalRef(env,owner);
}
