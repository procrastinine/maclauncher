#include <jni.h>
#include <dlfcn.h>
#include <string.h>
#include <stdlib.h>
static char *strings;
static void *prepared;
static void construct(char *value){strings=value;memcpy(strings,"Java_",5);memcpy(strings+80,"Java_",5);memcpy(strings+640,"Java_",5);}
static jint manual(JNIEnv *env,jclass owner){(void)env;(void)owner;return 91;}
static jint inherited(JNIEnv *env,jclass owner){(void)env;(void)owner;return 95;}
static jint prefix(JNIEnv *env,jclass owner){(void)env;(void)owner;return 92;}
static jint onload(JavaVM *vm,void *unused){
 (void)unused;JNIEnv *env=NULL;if((*vm)->GetEnv(vm,(void**)&env,JNI_VERSION_1_6)!=JNI_OK)return JNI_ERR;
 memcpy(strings+240,"Java_",5);
 jclass type=(*env)->FindClass(env,"owned/live/Probe");if(!type)return JNI_ERR;
 JNINativeMethod methods[]={{"manual","()I",(void*)manual},{"inherited","()I",(void*)inherited}};jint result=(*env)->RegisterNatives(env,type,methods,2);(*env)->DeleteLocalRef(env,type);return result==JNI_OK?JNI_VERSION_1_6:JNI_ERR;
}
static void *lookup(const char *name){return !strcmp(name,"fixture_live_construct")?(void*)construct:!strcmp(name,"fixture_live_onload")?(void*)onload:NULL;}
JNIEXPORT void JNICALL Java_LiveNativeProbe_install(JNIEnv *env,jclass ignored,jstring path,jstring binding){(void)ignored;const char *file=(*env)->GetStringUTFChars(env,path,NULL);if(!file)return;void *core=dlopen(file,RTLD_NOW|RTLD_GLOBAL);(*env)->ReleaseStringUTFChars(env,path,file);if(!core)abort();int(*install)(void *(*)(const char*))=dlsym(core,"klj_register_import_resolver");if(!install||!install(lookup))abort();file=(*env)->GetStringUTFChars(env,binding,NULL);if(!file)return;void *owner=dlopen(file,RTLD_NOW|RTLD_LOCAL);(*env)->ReleaseStringUTFChars(env,binding,file);if(!owner)abort();prepared=dlsym(owner,"klj_load_prepared");}
JNIEXPORT void JNICALL Java_LiveNativeProbe_prepareEntry(JNIEnv *env,jclass ignored,jclass entry){(void)ignored;if(!prepared)abort();JNINativeMethod method={"loadPrepared","(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/util/function/LongConsumer;)J",prepared};if((*env)->RegisterNatives(env,entry,&method,1)!=JNI_OK)abort();}
JNIEXPORT void JNICALL Java_LiveNativeProbe_unregister(JNIEnv *env,jclass ignored,jclass target){(void)ignored;if((*env)->UnregisterNatives(env,target)!=JNI_OK)abort();}
JNIEXPORT void JNICALL Java_LiveNativeProbe_registerPartial(JNIEnv *env,jclass ignored,jclass target){
 (void)ignored;JNINativeMethod methods[]={{"manual","()I",(void*)prefix},{"missingAfterPrefix","()I",(void*)prefix}};
 /* Leave the original NoSuchMethodError pending. The VM has already committed
  * the first method, even though the whole registration call returns error. */
 (void)(*env)->RegisterNatives(env,target,methods,2);
}
JNIEXPORT void JNICALL Java_LiveNativeProbe_clearManual(JNIEnv *env,jclass ignored,jclass target){
 (void)ignored;JNINativeMethod method={"manual","()I",NULL};(void)(*env)->RegisterNatives(env,target,&method,1);
}
JNIEXPORT void JNICALL Java_LiveNativeProbe_registerDisposable(JNIEnv *env,jclass ignored,jclass target){
 (void)ignored;JNINativeMethod method={"lifetime","()I",(void*)inherited};(void)(*env)->RegisterNatives(env,target,&method,1);
}
JNIEXPORT void JNICALL Java_LiveNativeProbe_exposeLifetime(JNIEnv *env,jclass ignored){(void)env;(void)ignored;memcpy(strings+720,"Java_",5);}
