#include <jni.h>
#include <assert.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
typedef void (*Install)(JNIEnv *,jclass,jobjectArray,jobjectArray);
JNIEXPORT jint JNICALL Java_PathProbe_probe(JNIEnv *env,jclass owner,jstring core_path,jobjectArray prefixes,jobjectArray targets,jobjectArray replacement,jstring guest_path,jstring file_path,jstring renamed_path,jstring outside_path,jboolean baseline){
 const char *core=(*env)->GetStringUTFChars(env,core_path,NULL),*guest=(*env)->GetStringUTFChars(env,guest_path,NULL);
 const char *file=(*env)->GetStringUTFChars(env,file_path,NULL),*renamed=(*env)->GetStringUTFChars(env,renamed_path,NULL),*outside=(*env)->GetStringUTFChars(env,outside_path,NULL);assert(core&&guest&&file&&renamed&&outside);
 void *runtime=dlopen(core,RTLD_NOW|RTLD_LOCAL);if(!runtime){fputs(dlerror(),stderr);return 2;}
 Install install=(Install)dlsym(runtime,"Java_maclauncher_android_framework_HostFilesystem_installNativePaths");
 void *(*load)(const char *,int)=dlsym(runtime,"klb_dlopen"),*(*symbol)(void *,const char *)=dlsym(runtime,"klb_dlsym");
 void *(*base)(void *)=dlsym(runtime,"kl_base");int (*address)(const void *,Dl_info *)=dlsym(runtime,"klb_dladdr");
 int (*sdk)(unsigned)=dlsym(runtime,"klj_library_set_target_sdk"),(*startup)(int,const char *const *,size_t,const char *const *)=dlsym(runtime,"klj_library_set_startup");
 assert(install&&load&&symbol&&base&&address&&sdk&&startup);const char *args[]={"owned.path.probe",NULL},*environment[]={NULL};assert(sdk(35)&&startup(1,args,0,environment));
 install(env,owner,prefixes,targets);assert(!(*env)->ExceptionCheck(env));
 /* The existing mapper canonicalizes the symlink target into the admitted
  * canonical guest alias, rather than returning a host directory. */
 void *image=load("/data/app/alias/lib/arm64/libdisk.so",2);assert(image);
 int (*value)(void)=symbol(image,"path_value");assert(value&&value()==73);
 Dl_info info={0};assert(address(value,&info)&&info.dli_fbase==base(image));
 if(strcmp(info.dli_fname,guest)){
  assert(baseline);assert(!strcmp(info.dli_fname,"libdisk.so"));
  fprintf(stderr,"FAIL dladdr returned basename instead of admitted guest pathname\n");return 42;
 }
 assert(!baseline);const char *retained=info.dli_fname;
 assert(!strstr(retained,file));
 void *private_image=load(outside,2);assert(private_image);void *private_value=symbol(private_image,"path_value");assert(private_value);
 Dl_info private_info={0};assert(address(private_value,&private_info));assert(!strcmp(private_info.dli_fname,"libprivate.so")&&!strstr(private_info.dli_fname,outside));
 assert(address(value,&info)&&info.dli_fname==retained&&!strcmp(retained,guest));
 install(env,owner,replacement,targets);assert(!(*env)->ExceptionCheck(env));
 assert(address(value,&info)&&info.dli_fname==retained&&!strcmp(info.dli_fname,guest));
 assert(rename(file,renamed)==0);assert(value()==73);
 assert(address(value,&info)&&info.dli_fname==retained&&!strcmp(info.dli_fname,guest));
 Dl_info native={0},actual={0};assert(dladdr((void *)malloc,&native)&&address((void *)malloc,&actual));
 assert(actual.dli_fbase==native.dli_fbase&&actual.dli_saddr==native.dli_saddr&&!strcmp(actual.dli_fname,native.dli_fname));
 assert((!actual.dli_sname&&!native.dli_sname)||(actual.dli_sname&&native.dli_sname&&!strcmp(actual.dli_sname,native.dli_sname)));
 (*env)->ReleaseStringUTFChars(env,core_path,core);(*env)->ReleaseStringUTFChars(env,guest_path,guest);(*env)->ReleaseStringUTFChars(env,file_path,file);(*env)->ReleaseStringUTFChars(env,renamed_path,renamed);(*env)->ReleaseStringUTFChars(env,outside_path,outside);
 puts("PASS dladdr canonical admitted guest path, symlink alias, configuration/rename lifetime, outside-path privacy and native provider identity");return 0;
}
