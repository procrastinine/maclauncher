#include <SLES/OpenSLES.h>
#include <SLES/OpenSLES_Android.h>
#include <dlfcn.h>
#include <stdatomic.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

#define CHECK(value) do {if(!(value))return __LINE__;}while(0)
static _Atomic unsigned callbacks;
static void finished(SLAndroidSimpleBufferQueueItf queue,void *context){
 (void)queue;(void)context;atomic_fetch_add(&callbacks,1);
}
static int get(SLAndroidConfigurationItf config,const SLchar *key,SLuint32 expected){
 SLuint32 bytes=0,value=99;
 CHECK((*config)->GetConfiguration(config,key,&bytes,0)==SL_RESULT_SUCCESS&&bytes==sizeof value);
 bytes=1;CHECK((*config)->GetConfiguration(config,key,&bytes,&value)==SL_RESULT_BUFFER_INSUFFICIENT&&bytes==sizeof value&&value==99);
 CHECK((*config)->GetConfiguration(config,key,&bytes,&value)==SL_RESULT_SUCCESS&&value==expected);
 return 0;
}
int OpenSlConfigurationProbe(void){
 void *library=dlopen("libOpenSLES.so",RTLD_NOW);CHECK(library);
 SLresult (*create)(SLObjectItf*,SLuint32,const SLEngineOption*,SLuint32,const SLInterfaceID*,const SLboolean*)=dlsym(library,"slCreateEngine");CHECK(create);
#define IID(name) const SLInterfaceID name=*(const SLInterfaceID*)dlsym(library,#name)
 IID(SL_IID_ENGINE);IID(SL_IID_ANDROIDCONFIGURATION);IID(SL_IID_PLAY);IID(SL_IID_ANDROIDSIMPLEBUFFERQUEUE);
 SLObjectItf engineObject=0,mix=0,player=0,second=0;SLEngineItf engine=0;
 CHECK(create(&engineObject,0,0,0,0,0)==SL_RESULT_SUCCESS);
 CHECK((*engineObject)->Realize(engineObject,SL_BOOLEAN_FALSE)==SL_RESULT_SUCCESS);
 CHECK((*engineObject)->GetInterface(engineObject,SL_IID_ENGINE,&engine)==SL_RESULT_SUCCESS);
 CHECK((*engine)->CreateOutputMix(engine,&mix,0,0,0)==SL_RESULT_SUCCESS);
 SLDataLocator_AndroidSimpleBufferQueue locator={SL_DATALOCATOR_ANDROIDSIMPLEBUFFERQUEUE,2};
 SLDataFormat_PCM pcm={SL_DATAFORMAT_PCM,2,48000000,16,16,SL_SPEAKER_FRONT_LEFT|SL_SPEAKER_FRONT_RIGHT,SL_BYTEORDER_LITTLEENDIAN};
 SLDataLocator_OutputMix output={SL_DATALOCATOR_OUTPUTMIX,mix};SLDataSource source={&locator,&pcm};SLDataSink sink={&output,0};
 CHECK((*engine)->CreateAudioPlayer(engine,&player,&source,&sink,0,0,0)==SL_RESULT_SUCCESS);
 SLAndroidConfigurationItf config=0;CHECK((*player)->GetInterface(player,SL_IID_ANDROIDCONFIGURATION,&config)==SL_RESULT_SUCCESS);
 SLuint32 value=SL_ANDROID_PERFORMANCE_LATENCY,bytes=sizeof value;
 CHECK((*config)->SetConfiguration(config,0,&value,bytes)==SL_RESULT_PARAMETER_INVALID);
 CHECK((*config)->SetConfiguration(config,SL_ANDROID_KEY_PERFORMANCE_MODE,0,bytes)==SL_RESULT_PARAMETER_INVALID);
 CHECK((*config)->SetConfiguration(config,SL_ANDROID_KEY_PERFORMANCE_MODE,&value,0)==SL_RESULT_PARAMETER_INVALID);
 CHECK((*config)->SetConfiguration(config,SL_ANDROID_KEY_PERFORMANCE_MODE,&value,1)==SL_RESULT_BUFFER_INSUFFICIENT);
 CHECK((*config)->GetConfiguration(config,SL_ANDROID_KEY_PERFORMANCE_MODE,0,&value)==SL_RESULT_PARAMETER_INVALID);
 CHECK((*config)->SetConfiguration(config,(const SLchar*)"unknown",&value,bytes)==SL_RESULT_PARAMETER_INVALID);
 CHECK((*config)->GetConfiguration(config,(const SLchar*)"unknown",&bytes,&value)==SL_RESULT_PARAMETER_INVALID);
 for(value=SL_ANDROID_STREAM_VOICE;value<=SL_ANDROID_STREAM_NOTIFICATION;value++){
  CHECK((*config)->SetConfiguration(config,SL_ANDROID_KEY_STREAM_TYPE,&value,sizeof value)==SL_RESULT_SUCCESS);
  CHECK(!get(config,SL_ANDROID_KEY_STREAM_TYPE,value));
 }
 for(value=SL_ANDROID_PERFORMANCE_NONE;value<=SL_ANDROID_PERFORMANCE_POWER_SAVING;value++){
  CHECK((*config)->SetConfiguration(config,SL_ANDROID_KEY_PERFORMANCE_MODE,&value,sizeof value)==SL_RESULT_SUCCESS);
  CHECK(!get(config,SL_ANDROID_KEY_PERFORMANCE_MODE,value));
 }
 value=99;CHECK((*config)->SetConfiguration(config,SL_ANDROID_KEY_PERFORMANCE_MODE,&value,sizeof value)==SL_RESULT_PARAMETER_INVALID);
 value=SL_ANDROID_STREAM_MEDIA;CHECK((*config)->SetConfiguration(config,SL_ANDROID_KEY_STREAM_TYPE,&value,sizeof value)==SL_RESULT_SUCCESS);
 CHECK((*player)->Realize(player,SL_BOOLEAN_FALSE)==SL_RESULT_SUCCESS);
 // Oboe finishes opening by querying actual performance after realization.
 CHECK(!get(config,SL_ANDROID_KEY_PERFORMANCE_MODE,SL_ANDROID_PERFORMANCE_NONE));
 value=SL_ANDROID_PERFORMANCE_LATENCY;
 CHECK((*config)->SetConfiguration(config,SL_ANDROID_KEY_PERFORMANCE_MODE,&value,sizeof value)==SL_RESULT_PRECONDITIONS_VIOLATED);
 CHECK((*engine)->CreateAudioPlayer(engine,&second,&source,&sink,0,0,0)==SL_RESULT_SUCCESS&&second!=player);
 SLAndroidConfigurationItf secondConfig=0;CHECK((*second)->GetInterface(second,SL_IID_ANDROIDCONFIGURATION,&secondConfig)==SL_RESULT_SUCCESS);
 value=SL_ANDROID_STREAM_ALARM;CHECK((*secondConfig)->SetConfiguration(secondConfig,SL_ANDROID_KEY_STREAM_TYPE,&value,sizeof value)==SL_RESULT_SUCCESS);
 CHECK(!get(config,SL_ANDROID_KEY_STREAM_TYPE,SL_ANDROID_STREAM_MEDIA));
 CHECK(!get(secondConfig,SL_ANDROID_KEY_STREAM_TYPE,SL_ANDROID_STREAM_ALARM));
 SLPlayItf play=0;SLAndroidSimpleBufferQueueItf queue=0;
 CHECK((*player)->GetInterface(player,SL_IID_PLAY,&play)==SL_RESULT_SUCCESS);
 CHECK((*player)->GetInterface(player,SL_IID_ANDROIDSIMPLEBUFFERQUEUE,&queue)==SL_RESULT_SUCCESS);
 CHECK((*queue)->RegisterCallback(queue,finished,0)==SL_RESULT_SUCCESS);
 int16_t samples[480*2];for(unsigned i=0;i<sizeof samples/sizeof samples[0];i++)samples[i]=(i&1)?4096:-4096;
 CHECK((*queue)->Enqueue(queue,samples,sizeof samples)==SL_RESULT_SUCCESS);
 CHECK((*play)->SetPlayState(play,SL_PLAYSTATE_PLAYING)==SL_RESULT_SUCCESS);
 for(int i=0;i<1000&&!atomic_load(&callbacks);i++)usleep(1000);
 CHECK(atomic_load(&callbacks)==1);
 CHECK((*play)->SetPlayState(play,SL_PLAYSTATE_STOPPED)==SL_RESULT_SUCCESS);
 (*second)->Destroy(second);(*player)->Destroy(player);(*mix)->Destroy(mix);(*engineObject)->Destroy(engineObject);
 return 0;
}
