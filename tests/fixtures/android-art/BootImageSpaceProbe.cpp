#include <jni.h>
#include "runtime.h"
#include "gc/heap.h"
#include <android/dlext.h>
#include <nativeloader/dlext_namespaces.h>
#include <dlfcn.h>

extern "C" JNIEXPORT jboolean JNICALL Java_maclauncher_android_LocalBinderThreadProbe_00024BootImageProbe_hasBootImage(JNIEnv* env,jclass) {
 // The original ART APEX namespace owns this existing runtime instance.
 // Resolving there avoids loading a second libart in the system namespace.
 android_dlextinfo info{};info.flags=ANDROID_DLEXT_USE_NAMESPACE;
 info.library_namespace=android_get_exported_namespace("com_android_art");
 if(!info.library_namespace)info.library_namespace=android_get_exported_namespace("default");
 void* library=android_dlopen_ext("libart.so",RTLD_NOW|RTLD_NOLOAD,&info);
 auto instance=library?static_cast<art::Runtime**>(dlsym(library,"_ZN3art7Runtime9instance_E")):nullptr;
 if(!instance||!*instance){env->ThrowNew(env->FindClass("java/lang/AssertionError"),"Original ART runtime instance unavailable");return false;}
 bool actual=(*instance)->GetHeap()->HasBootImageSpace();dlclose(library);return actual;
}
