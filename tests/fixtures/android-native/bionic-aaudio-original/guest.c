#include "probe.h"
#include <aaudio/AAudio.h>
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
static pthread_key_t key;
static JavaVM *probe_vm;
JavaVM *aaudio_original_probe_vm(void){return probe_vm;}
static int detached(JavaVM *vm){void *env=(void*)1;return (*vm)->GetEnv(vm,&env,JNI_VERSION_1_6)==JNI_EDETACHED&&!env;}
static void *load_plugin(void *raw){
 AAudioProbeCall *call=raw;call->loader_tid=gettid();call->loader_detached_before=detached(call->vm);
 void *plugin=dlopen("libaaudio-original-plugin.so",RTLD_NOW|RTLD_LOCAL);
 if(plugin){
  int (*value)(void)=(int(*)(void))dlsym(plugin,"aaudio_original_plugin_value");
  int (*constructor_detached)(void)=(int(*)(void))dlsym(plugin,"aaudio_original_plugin_constructor_detached");
  if(value&&constructor_detached){call->loader_value=value();call->loader_constructor_detached=constructor_detached();}
  else{const char *error=dlerror();snprintf(call->loader_error,sizeof(call->loader_error),"%s",error?error:"plugin symbol missing");}
  call->loader_closed=dlclose(plugin)==0;
 }else{const char *error=dlerror();snprintf(call->loader_error,sizeof(call->loader_error),"%s",error?error:"plugin open failed");}
 call->loader_detached_after=detached(call->vm);return NULL;
}
static void finish(void *raw){AAudioProbeCall *call=raw;if(!detached(call->vm))call->failures++;call->tls_retired++;}
static aaudio_data_callback_result_t data(AAudioStream *stream,void *raw,void *audio,int32_t frames){
 AAudioProbeCall *call=raw;int tid=gettid();
 if(!detached(call->vm)||stream!=call->stream||frames!=64||!audio)call->failures|=1;
 if(call->callback_tid&&call->callback_tid!=tid)call->failures|=2;call->callback_tid=tid;
 if(pthread_setspecific(key,call))call->failures|=4;
 errno=EINTR;int sample_rate=AAudioStream_getSampleRate(stream);call->observed_errno=errno;
 if(sample_rate!=48000||errno!=EINTR)call->failures|=8;
 call->flush_result=AAudioStream_requestFlush(stream);if(call->flush_result!=AAUDIO_ERROR_INVALID_STATE)call->failures|=16;
 int64_t position=17,nanos=19;
 call->timestamp_result=AAudioStream_getTimestamp(stream,CLOCK_MONOTONIC,&position,&nanos);
 if(call->timestamp_result!=AAUDIO_ERROR_UNIMPLEMENTED||position!=17||nanos!=19)call->failures|=32;
 call->hardware_rate=AAudioStream_getHardwareSampleRate(stream);call->hardware_channels=AAudioStream_getHardwareChannelCount(stream);
 if(call->hardware_rate<=0||call->hardware_channels<=0)call->failures|=64;
 memset(audio,0,(size_t)frames*2*sizeof(int16_t));
 int goal=call->goal?call->goal:4;
 return ++call->callbacks>=goal?AAUDIO_CALLBACK_RESULT_STOP:AAUDIO_CALLBACK_RESULT_CONTINUE;
}
#define CHECK(x) do{if(!(x))return __LINE__;}while(0)
static int wait_stopped(AAudioProbeCall *call,AAudioStream *stream,int goal,int retired){
 for(unsigned i=0;i<2000;i++){
  if(call->callbacks>=goal&&call->tls_retired>=retired&&AAudioStream_getState(stream)==AAUDIO_STREAM_STATE_STOPPED)return 1;
  usleep(1000);
 }
 return 0;
}
static int concurrent_outputs(AAudioProbeCall *owner){
 AAudioProbeCall first={.vm=owner->vm,.goal=4},second={.vm=owner->vm,.goal=100000};
 AAudioStreamBuilder *builder=NULL;AAudioStream *a=NULL,*b=NULL;
 CHECK(AAudio_createStreamBuilder(&builder)==AAUDIO_OK);
 AAudioStreamBuilder_setFormat(builder,AAUDIO_FORMAT_PCM_I16);AAudioStreamBuilder_setChannelCount(builder,2);
 AAudioStreamBuilder_setSampleRate(builder,48000);AAudioStreamBuilder_setFramesPerDataCallback(builder,64);
 AAudioStreamBuilder_setDataCallback(builder,data,&first);CHECK(AAudioStreamBuilder_openStream(builder,&a)==AAUDIO_OK);first.stream=a;
 AAudioStreamBuilder_setDataCallback(builder,data,&second);CHECK(AAudioStreamBuilder_openStream(builder,&b)==AAUDIO_OK);second.stream=b;
 CHECK(AAudioStreamBuilder_delete(builder)==AAUDIO_OK);
 CHECK(AAudioStream_requestStart(b)==AAUDIO_OK&&AAudioStream_requestStart(a)==AAUDIO_OK);
 CHECK(wait_stopped(&first,a,4,1));CHECK(AAudioStream_close(a)==AAUDIO_OK);
 int before=second.callbacks;for(unsigned i=0;i<2000&&second.callbacks<before+4;i++)usleep(1000);
 owner->other_continued=second.callbacks-before;CHECK(owner->other_continued>=4);
 second.goal=second.callbacks+4;CHECK(wait_stopped(&second,b,second.goal,1));
 CHECK(AAudioStream_close(b)==AAUDIO_OK);CHECK(!first.failures&&!second.failures);return 0;
}
int aaudio_original_exercise(AAudioProbeCall *call){
 AAudioStreamBuilder *builder=NULL;AAudioStream *stream=NULL;
 probe_vm=call->vm;pthread_t loader;
 CHECK(!pthread_create(&loader,NULL,load_plugin,call));CHECK(!pthread_join(loader,NULL));
 CHECK(call->loader_detached_before&&call->loader_constructor_detached&&call->loader_detached_after);
 CHECK(call->loader_value==73&&call->loader_closed&&call->loader_tid>0&&!call->loader_error[0]);
 CHECK(!pthread_key_create(&key,finish));CHECK(AAudio_createStreamBuilder(&builder)==AAUDIO_OK&&builder);
 AAudioStreamBuilder_setFormat(builder,AAUDIO_FORMAT_PCM_I16);AAudioStreamBuilder_setChannelCount(builder,2);
 AAudioStreamBuilder_setSampleRate(builder,48000);AAudioStreamBuilder_setFramesPerDataCallback(builder,64);
 AAudioStreamBuilder_setDataCallback(builder,data,call);
 CHECK(AAudioStreamBuilder_openStream(builder,&stream)==AAUDIO_OK&&stream);
 CHECK(AAudioStream_getUsage(stream)==AAUDIO_USAGE_MEDIA&&AAudioStream_getContentType(stream)==AAUDIO_CONTENT_TYPE_MUSIC);
 CHECK(AAudioStream_getAllowedCapturePolicy(stream)==AAUDIO_ALLOW_CAPTURE_BY_ALL&&!AAudioStream_isContentSpatialized(stream)&&!AAudioStream_isPrivacySensitive(stream));
 CHECK(AAudioStream_close(stream)==AAUDIO_OK);stream=NULL;
 AAudioStreamBuilder_setUsage(builder,AAUDIO_USAGE_GAME);AAudioStreamBuilder_setContentType(builder,AAUDIO_CONTENT_TYPE_SPEECH);
 AAudioStreamBuilder_setAllowedCapturePolicy(builder,AAUDIO_ALLOW_CAPTURE_BY_NONE);AAudioStreamBuilder_setIsContentSpatialized(builder,true);
 CHECK(AAudioStreamBuilder_openStream(builder,&stream)==AAUDIO_OK&&stream);call->stream=stream;
 CHECK(AAudioStream_getUsage(stream)==AAUDIO_USAGE_GAME&&AAudioStream_getContentType(stream)==AAUDIO_CONTENT_TYPE_SPEECH);
 CHECK(AAudioStream_getAllowedCapturePolicy(stream)==AAUDIO_ALLOW_CAPTURE_BY_NONE&&AAudioStream_isContentSpatialized(stream));
 CHECK(AAudioStreamBuilder_delete(builder)==AAUDIO_OK);
 CHECK(AAudioStream_requestStart(stream)==AAUDIO_OK);
 CHECK(wait_stopped(call,stream,4,1));
 call->goal=8;call->callback_tid=0;CHECK(AAudioStream_requestStart(stream)==AAUDIO_OK);
 CHECK(wait_stopped(call,stream,8,2));CHECK(AAudioStream_requestStop(stream)==AAUDIO_OK);
 CHECK(AAudioStream_release(stream)==AAUDIO_OK&&AAudioStream_getState(stream)==AAUDIO_STREAM_STATE_CLOSING);
 CHECK(AAudioStream_requestStart(stream)==AAUDIO_ERROR_INVALID_STATE&&AAudioStream_requestFlush(stream)==AAUDIO_ERROR_INVALID_STATE);
 usleep(10000);CHECK(call->callbacks==8);
 CHECK(AAudioStream_close(stream)==AAUDIO_OK);CHECK(call->tls_retired==2&&!call->failures&&call->callback_tid>0);
 int concurrent=concurrent_outputs(call);CHECK(!concurrent);
 CHECK(!pthread_key_delete(key));return 0;
}
