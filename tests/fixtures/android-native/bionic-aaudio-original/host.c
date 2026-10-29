#include "probe.h"
#include "runtime-host.h"
#include "image-loader.h"
#include "native-image-provider.h"
#include "jni-provider.h"
#include "aaudio-host.h"
#include <assert.h>
#include <stdio.h>
#include <unistd.h>
static KljBionicRuntime *runtime;static JavaVM *vm;static jlong image;static _Atomic unsigned callbacks;
extern void *kl_aaudio_lookup(const char*);
extern int kl_audio_active(void);
extern void *klj_guest_image_symbol(jlong,const char*);
static int64_t invoke(void *unused,JNIEnv *env,uintptr_t caller,KljCallPacket *packet){
 (void)unused;void *actual=(void*)1;assert(kl_audio_active());
 assert(!env&&(*vm)->GetEnv(vm,&actual,JNI_VERSION_1_6)==JNI_EDETACHED&&!actual);
 const void *identity=klj_jni_provider_identity((void*)caller);assert(identity&&(jlong)(uintptr_t)identity==image);
 int accepted=klj_native_image_invoke(NULL,image,packet);callbacks++;
 actual=(void*)1;assert((*vm)->GetEnv(vm,&actual,JNI_VERSION_1_6)==JNI_EDETACHED&&!actual);
 return accepted?packet->status:-22;
}
static int64_t host_call(void *unused,KljBionicRuntime *owner,JNIEnv *env,uint32_t code,uint64_t raw,uint64_t length){
 (void)unused;assert(owner==runtime);return code==KLJ_BIONIC_AAUDIO_HOSTCALL&&length==sizeof(KljBionicNdkPacket)?klj_bionic_aaudio_dispatch(env,(void*)(uintptr_t)raw):-38;
}
JNIEXPORT jint JNICALL Java_maclauncher_android_bridge_AAudioProbe_initialize(JNIEnv *env,jclass ignored,jobjectArray paths){
 (void)ignored;assert((*env)->GetJavaVM(env,&vm)==JNI_OK&&(*env)->GetArrayLength(env,paths)==8);
 const char *text[8];jstring values[8];for(unsigned i=0;i<8;i++){values[i]=(*env)->GetObjectArrayElement(env,paths,i);text[i]=(*env)->GetStringUTFChars(env,values[i],NULL);assert(text[i]);}
 extern char **environ;size_t count=0;while(environ[count])count++;
 KljBionicRuntimeOptions options={sizeof options,1,text[0],text[1],text[2],text[3],text[4],text[5],text[6],(const char*const*)environ,count};
 int64_t status=klj_bionic_runtime_prepare(env,&options,&runtime);
 if(!status)status=klj_bionic_images_install(runtime,env);
 if(!status){KljBionicAAudioOwner owner={.resolve=kl_aaudio_lookup,.invoke=invoke,.context=NULL,.vm=vm};status=klj_bionic_aaudio_prepare(&owner);}
 if(!status)status=klj_bionic_runtime_host_callback(runtime,host_call,NULL);
 if(!status){KljBionicSymbol symbol={sizeof symbol,1,klj_bionic_runtime_guest(runtime)->helper.handle,"klj_bionic_aaudio_install",NULL,NULL,0};
  status=klj_bionic_runtime_symbol(runtime,env,&symbol);uint64_t result=0;if(!status)status=klj_bionic_runtime_invoke(runtime,env,(uintptr_t)symbol.symbol,(uintptr_t)klj_bionic_aaudio_bindings(),&result);if(!status)status=(int64_t)result;
 }
 if(!status){KljBionicSymbol symbol={sizeof symbol,1,klj_bionic_runtime_guest(runtime)->helper.handle,"klj_bionic_application_libraries",NULL,NULL,0};
  status=klj_bionic_runtime_symbol(runtime,env,&symbol);uint64_t result=0;if(!status)status=klj_bionic_runtime_invoke(runtime,env,(uintptr_t)symbol.symbol,(uintptr_t)text[7],&result);if(!status)status=(int64_t)result;
 }
 for(unsigned i=0;i<8;i++){(*env)->ReleaseStringUTFChars(env,values[i],text[i]);(*env)->DeleteLocalRef(env,values[i]);}return (jint)status;
}
JNIEXPORT void JNICALL Java_maclauncher_android_bridge_AAudioProbe_exercise(JNIEnv *env,jclass type,jstring core,jstring file,jobject preparation){
 jstring name=(*env)->NewStringUTF(env,"libaaudio-original-control.so");image=klj_load_prepared(env,type,core,file,name,preparation);(*env)->DeleteLocalRef(env,name);assert(image&&!(*env)->ExceptionCheck(env));
 JNIEnv *outer=NULL;JavaVM *guest_vm=NULL;assert(klj_native_image_jni_context(env,image,&outer,&guest_vm)==1);
 void *entry=klj_guest_image_symbol(image,"aaudio_original_exercise");assert(entry);AAudioProbeCall call={.vm=guest_vm};uint64_t result=0;
 int64_t status=klj_bionic_runtime_invoke(runtime,env,(uintptr_t)entry,(uintptr_t)&call,&result);
 fprintf(stderr,"AAudio original owner status=%lld line=%llu callbacks=%d tlsRetired=%d failures=%d otherContinued=%d\n",(long long)status,(unsigned long long)result,call.callbacks,call.tls_retired,call.failures,call.other_continued);
 fprintf(stderr,"AAudio frame progress first=%lld second=%lld->%lld released=%lld\n",(long long)call.first_frames_read,(long long)call.second_frames_read_before,(long long)call.second_frames_read_after,(long long)call.released_frames_read);
 fprintf(stderr,"Bionic detached dlopen before=%d constructor=%d after=%d value=%d closed=%d tid=%d error=%s\n",call.loader_detached_before,call.loader_constructor_detached,call.loader_detached_after,call.loader_value,call.loader_closed,call.loader_tid,call.loader_error);
 if(call.failures)fprintf(stderr,"AAudio control facts errno=%d flush=%d timestamp=%d hardware=%d/%d\n",call.observed_errno,call.flush_result,call.timestamp_result,call.hardware_rate,call.hardware_channels);
 assert(!status&&!result&&!call.failures&&call.callbacks==8&&call.tls_retired==2&&callbacks>=16&&call.other_continued>=4);
 assert(call.loader_detached_before&&call.loader_constructor_detached&&call.loader_detached_after&&call.loader_value==73&&call.loader_closed&&call.loader_tid>0&&!call.loader_error[0]);
}
JNIEXPORT void JNICALL Java_maclauncher_android_bridge_AAudioProbe_complete(JNIEnv *env,jclass ignored){
 (void)ignored;int64_t status=-16;for(unsigned i=0;i<2000&&status==-16;i++){status=klj_bionic_runtime_try_close(runtime,env);if(status==-16)usleep(1000);}assert(!status);
}
