#include <jni.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
static int calls;
static jint onload(JavaVM *vm,void *reserved){
 JNIEnv *env=NULL;if((*vm)->GetEnv(vm,(void**)&env,JNI_VERSION_1_6)!=JNI_OK)return JNI_ERR;
 jclass owner=(*env)->FindClass(env,"owned/dynamic/Marker");if(!owner)return JNI_ERR;
 jmethodID verify=(*env)->GetStaticMethodID(env,owner,"verify","()V");if(!verify)return JNI_ERR;
 (*env)->CallStaticVoidMethod(env,owner,verify);int failed=(*env)->ExceptionCheck(env);(*env)->DeleteLocalRef(env,owner);
 if(failed)return JNI_ERR;calls++;return JNI_VERSION_1_6;
}
static void *lookup(const char *name){return !strcmp(name,"fixture_dynamic_onload")?(void*)onload:NULL;}
JNIEXPORT void JNICALL Java_DynamicNativeProbe_install(JNIEnv *env,jclass type,jstring file){const char *path=(*env)->GetStringUTFChars(env,file,NULL);if(!path)return;void *runtime=dlopen(path,RTLD_NOW|RTLD_GLOBAL);(*env)->ReleaseStringUTFChars(env,file,path);if(!runtime)abort();int (*registerResolver)(void *(*)(const char*))=dlsym(runtime,"klj_register_import_resolver");if(!registerResolver||!registerResolver(lookup))abort();}
JNIEXPORT jint JNICALL Java_DynamicNativeProbe_calls(JNIEnv *env,jclass type){return calls;}
