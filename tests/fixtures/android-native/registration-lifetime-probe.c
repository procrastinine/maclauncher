#include "registration-instrumented.c"
static jvmtiEnv *fixture_ti;
static jvmtiEnv *fixture_owner;
jvmtiEnv *klj_jni_vm_tooling(JNIEnv *env){if(!fixture_owner){JavaVM *vm=NULL;if((*env)->GetJavaVM(env,&vm)!=JNI_OK||(*vm)->GetEnv(vm,(void**)&fixture_owner,JVMTI_VERSION_1_2)!=JNI_OK)return NULL;test_live_environments++;}return fixture_owner;}
static unsigned aborted;
void *kl_base(void *image){return (void*)0x10000;}
size_t kl_span(void *image){return 4096;}
void *klj_native_abi(void *p,const char *s,char *e,size_t n){return p;}
int klj_jni_calls_prepare(JNIEnv *e,jniNativeInterface *table,jvmtiEnv *ti){fixture_ti=ti;return 1;}
int klj_class_lookup_prepare(JNIEnv *e,jniNativeInterface *table){return 1;}
int klj_field_lookup_prepare(JNIEnv *e,jniNativeInterface *table){return 1;}
int klj_framework_registration(JNIEnv *e,jclass c,const JNINativeMethod *methods,jint count,JNINativeMethod **adapted,jint *adapted_count){*adapted=NULL;return 0;}
void klj_jni_calls_abort(jvmtiEnv *ti){if(fixture_ti==ti)fixture_ti=NULL;aborted++;}
JNIEXPORT jlong JNICALL Java_RegistrationLifetimeProbe_attempt(JNIEnv *e,jclass c,jint stage,jthrowable pending){
 Dl_info info;if(!dladdr((void*)kl_base,&info))return -1;void *runtime=dlopen(info.dli_fname,RTLD_NOW|RTLD_LOCAL);if(!runtime)return -2;
 test_fail_stage=stage;if(pending)(*e)->Throw(e,pending);
 int okay=klj_registration_prepare(e,runtime,(void*)1);dlclose(runtime);return okay;
}
JNIEXPORT jlong JNICALL Java_RegistrationLifetimeProbe_live(JNIEnv *e,jclass c){return test_live_environments;}
JNIEXPORT jlong JNICALL Java_RegistrationLifetimeProbe_aborts(JNIEnv *e,jclass c){return aborted;}
JNIEXPORT jboolean JNICALL Java_RegistrationLifetimeProbe_classified(JNIEnv *e,jclass c){return klj_guest_address((void*)0x10000);}
JNIEXPORT jboolean JNICALL Java_RegistrationLifetimeProbe_usable(JNIEnv *e,jclass c){jint version=0;return fixture_ti&&(*fixture_ti)->GetVersionNumber(fixture_ti,&version)==JVMTI_ERROR_NONE&&version!=0;}
JNIEXPORT jboolean JNICALL Java_RegistrationLifetimeProbe_ownerUsable(JNIEnv *e,jclass c){jint version=0;return fixture_owner&&(*fixture_owner)->GetVersionNumber(fixture_owner,&version)==JVMTI_ERROR_NONE&&version!=0;}
