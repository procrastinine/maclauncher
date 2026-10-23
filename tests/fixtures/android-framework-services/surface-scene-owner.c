/* Scene-order fixture: actual NativeSurface ownership, no GPU/window output. */
#include <jni.h>
#include <dlfcn.h>
#include <stdint.h>
#include <CoreFoundation/CoreFoundation.h>
static void (*host)(void*),(*record)(void*,void*),(*end)(void*),(*release)(void*);
static void *(*window)(JNIEnv*,jobject),*(*begin)(void*,void**,int*,int*,int);
JNIEXPORT void JNICALL Java_NativeSurfaceFrameworkProbe_scenePresenter(JNIEnv *env,jclass cls,jstring path,jboolean enabled){
 (void)cls;if(!host){const char *name=(*env)->GetStringUTFChars(env,path,NULL);if(!name)return;void *library=dlopen(name,RTLD_NOW);(*env)->ReleaseStringUTFChars(env,path,name);
 host=dlsym(library,"klj_surface_host");window=dlsym(library,"klj_surface_native_window");begin=dlsym(library,"klj_surface_begin_egl");record=dlsym(library,"klj_surface_record_egl");end=dlsym(library,"klj_surface_end_egl");release=dlsym(library,"klj_surface_release_window");
 if(!host||!window||!begin||!record||!end||!release){jclass error=(*env)->FindClass(env,"java/lang/AssertionError");(*env)->ThrowNew(env,error,"Native scene owner exports");return;}}
 host(enabled?(void*)(uintptr_t)1:NULL);
}
JNIEXPORT jlong JNICALL Java_NativeSurfaceFrameworkProbe_sceneAttach(JNIEnv *env,jclass cls,jobject surface){
 (void)cls;void *owned=window(env,surface),*presenter=NULL;int width=0,height=0;
 void *storage=owned?begin(owned,&presenter,&width,&height,0):NULL;
 if(!storage){if(owned)release(owned);jclass error=(*env)->FindClass(env,"java/lang/AssertionError");(*env)->ThrowNew(env,error,"Native scene producer attachment");return 0;}
 CFRelease(storage);record(owned,(void*)(uintptr_t)2);return(jlong)(uintptr_t)owned;
}
JNIEXPORT void JNICALL Java_NativeSurfaceFrameworkProbe_sceneDetach(JNIEnv *env,jclass cls,jlong pointer){(void)env;(void)cls;void *owned=(void*)(uintptr_t)pointer;end(owned);release(owned);}
