/* Scene-order fixture: actual NativeSurface ownership, no GPU/window output. */
#include <jni.h>
#include <dlfcn.h>
#include <stdint.h>
#include <CoreFoundation/CoreFoundation.h>
#include <pthread.h>
#include <string.h>
#include "media-surface.h"
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

typedef struct {JavaVM *vm;KLJMediaSurface surface;CVPixelBufferRef pixels;jint results[4];} VideoCall;
static void *video_frames(void *opaque){
 VideoCall *call=opaque;JNIEnv *env=NULL;
 if((*call->vm)->AttachCurrentThreadAsDaemon(call->vm,(void**)&env,NULL)!=JNI_OK)return NULL;
 call->results[0]=call->surface.present(call->surface.context,call->pixels,1,0,NULL,NULL);
 call->results[2]=(*env)->ExceptionCheck(env);
 if(!call->results[2]){
  call->results[1]=call->surface.present(call->surface.context,call->pixels,2,0,NULL,NULL);
  call->results[3]=(*env)->ExceptionCheck(env);
 }
 // A failing implementation must still retire this fixture's physical thread.
 if((*env)->ExceptionCheck(env))(*env)->ExceptionClear(env);
 (*call->vm)->DetachCurrentThread(call->vm);return NULL;
}
JNIEXPORT jintArray JNICALL Java_NativeSurfaceFrameworkProbe_videoFailureRecovery(JNIEnv *env,jclass cls,jobject surface){
 (void)cls;VideoCall call={0};call.results[0]=call.results[1]=-10000;
 int (*acquire)(JNIEnv*,jobject,KLJMediaSurface*)=dlsym(RTLD_DEFAULT,"klj_codec_surface_java");
 if(!acquire||acquire(env,surface,&call.surface))return NULL;
 (*env)->GetJavaVM(env,&call.vm);
 if(CVPixelBufferCreate(kCFAllocatorDefault,3,2,kCVPixelFormatType_32BGRA,NULL,&call.pixels)!=kCVReturnSuccess){call.surface.release(call.surface.context);return NULL;}
 CVPixelBufferLockBaseAddress(call.pixels,0);unsigned char *pixels=CVPixelBufferGetBaseAddress(call.pixels);size_t stride=CVPixelBufferGetBytesPerRow(call.pixels);
 for(size_t y=0;y<2;y++)for(size_t x=0;x<3;x++){unsigned char color[]={255,128,0,255};memcpy(pixels+y*stride+x*4,color,4);}
 CVPixelBufferUnlockBaseAddress(call.pixels,0);
 pthread_t thread;if(!pthread_create(&thread,NULL,video_frames,&call))pthread_join(thread,NULL);
 CVPixelBufferRelease(call.pixels);call.surface.release(call.surface.context);
 jintArray result=(*env)->NewIntArray(env,4);if(result)(*env)->SetIntArrayRegion(env,result,0,4,call.results);return result;
}

/* Source-component case: execute the same storage entry points directly. The
 * normal packaged Surface case continues to load only its selected library. */
JNIEXPORT jlongArray JNICALL Java_NativeSurfaceFrameworkProbe_storageInfo(JNIEnv *env,jclass cls,jstring path,jint format){
 (void)cls;const char *file=(*env)->GetStringUTFChars(env,path,NULL);if(!file)return NULL;
 void *library=dlopen(file,RTLD_NOW|RTLD_LOCAL);(*env)->ReleaseStringUTFChars(env,path,file);
 if(!library){jclass error=(*env)->FindClass(env,"java/lang/AssertionError");(*env)->ThrowNew(env,error,dlerror());return NULL;}
 jlong (*create)(JNIEnv*,jclass,jint,jint,jint)=dlsym(library,"Java_maclauncher_android_framework_HostHardwareBuffer_createStorage");
 void (*retire)(JNIEnv*,jclass,jlong)=dlsym(library,"Java_maclauncher_android_framework_HostHardwareBuffer_releaseStorage");
 jint (*count)(JNIEnv*,jclass,jlong)=dlsym(library,"Java_maclauncher_android_framework_HostHardwareBuffer_storagePlaneCount");
 jintArray (*layout)(JNIEnv*,jclass,jlong,jint)=dlsym(library,"Java_maclauncher_android_framework_HostHardwareBuffer_storagePlaneLayout");
 jobject (*plane)(JNIEnv*,jclass,jlong,jint)=dlsym(library,"Java_maclauncher_android_framework_HostHardwareBuffer_storagePlane");
 void (*colors)(JNIEnv*,jclass,jlong,jintArray,jboolean,jboolean)=dlsym(library,"Java_maclauncher_android_framework_HostHardwareBuffer_storagePixels");
 void *(*pixels)(const void*)=dlsym(library,"kl_mediandk_buffer_pixels");
 if(!create||!retire||!count||!layout||!plane||!colors||!pixels){dlclose(library);jclass error=(*env)->FindClass(env,"java/lang/AssertionError");(*env)->ThrowNew(env,error,"Actual hardware storage component exports");return NULL;}
 jint width=4,height=format==33?1:2;jlong storage=create(env,NULL,width,height,format);
 if(!storage){dlclose(library);return NULL;}
 CVPixelBufferRef buffer=pixels((void*)(uintptr_t)storage);OSType type=CVPixelBufferGetPixelFormatType(buffer);
 CFDictionaryRef description=CVPixelFormatDescriptionCreateWithPixelFormatType(kCFAllocatorDefault,type);
 int bits=0;if(description){CFNumberRef value=CFDictionaryGetValue(description,kCVPixelFormatBitsPerBlock);if(value&&CFGetTypeID(value)==CFNumberGetTypeID())CFNumberGetValue(value,kCFNumberIntType,&bits);CFRelease(description);}
 jlong values[14]={CVPixelBufferGetIOSurface(buffer)!=NULL,(jlong)CVPixelBufferGetDataSize(buffer),count(env,NULL,storage),bits,format!=4||type==kCVPixelFormatType_16LE565};
 for(jint i=0;i<values[2]&&i<3;i++){
  jintArray fields=layout(env,NULL,storage,i);jint pair[2]={0};if(!fields)break;(*env)->GetIntArrayRegion(env,fields,0,2,pair);(*env)->DeleteLocalRef(env,fields);
  jobject bytes=plane(env,NULL,storage,i);if(!bytes)break;values[5+3*i]=pair[0];values[6+3*i]=pair[1];values[7+3*i]=(*env)->GetDirectBufferCapacity(env,bytes);(*env)->DeleteLocalRef(env,bytes);
 }
 if(!(*env)->ExceptionCheck(env)&&format!=32&&format!=33){
  jint white[8];for(unsigned i=0;i<8;i++)white[i]=-1;jintArray array=(*env)->NewIntArray(env,8);if(array){(*env)->SetIntArrayRegion(env,array,0,8,white);colors(env,NULL,storage,array,JNI_TRUE,JNI_TRUE);if(!(*env)->ExceptionCheck(env))colors(env,NULL,storage,array,JNI_FALSE,JNI_TRUE);if(!(*env)->ExceptionCheck(env)){(*env)->GetIntArrayRegion(env,array,0,8,white);for(unsigned i=0;i<8;i++)if(white[i]!=-1)values[4]=0;}(*env)->DeleteLocalRef(env,array);}
 }
 retire(env,NULL,storage);dlclose(library);if((*env)->ExceptionCheck(env))return NULL;
 jlongArray result=(*env)->NewLongArray(env,14);if(result)(*env)->SetLongArrayRegion(env,result,0,14,values);return result;
}
