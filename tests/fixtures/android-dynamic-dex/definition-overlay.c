/* Test-only installation of the current native source over an older runtime. */
#include "framework-dex.c"
/* This fixture replaces only defineBytecode; namespace setup remains on the
 * runtime's original native binding and cannot enter this unused export. */
jstring klj_create_classloader_namespace(JNIEnv *env,jobject loader,jint sdk,jstring search,jstring permitted,jboolean shared,jstring dex,jstring sonames){
 (void)loader;(void)sdk;(void)search;(void)permitted;(void)shared;(void)dex;(void)sonames;
 jclass error=(*env)->FindClass(env,"java/lang/AssertionError");if(error)(*env)->ThrowNew(env,error,"Unexpected namespace call in DEX definition overlay");return NULL;
}
JNIEXPORT void JNICALL Java_DexDefinitionProbe_install(JNIEnv *env,jclass ignored,jclass owner){
 (void)ignored;JNINativeMethod method={"defineBytecode","(Ljava/lang/String;Ljava/lang/ClassLoader;[B)Ljava/lang/Class;",(void*)Java_maclauncher_android_framework_HostDexFiles_defineBytecode};
 (*env)->RegisterNatives(env,owner,&method,1);
}
