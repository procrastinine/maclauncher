#include <jni.h>
#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <dlfcn.h>
#include <stdatomic.h>
#include <stdint.h>
#include <math.h>
#include <stdio.h>

// This process-only render notification observes the test's output AudioUnit.
// It neither opens a capture device nor records another application's audio.
static _Atomic uintptr_t output;
static _Atomic uint64_t created,started,callbacks,nonzero,nonzeroMarkedSilent;
static _Atomic uint32_t peak;
static OSStatus observe(void *ref,AudioUnitRenderActionFlags *flags,const AudioTimeStamp *time,UInt32 bus,UInt32 frames,AudioBufferList *buffers){
 (void)ref;(void)time;(void)bus;(void)frames;
 if(!flags||!(*flags&kAudioUnitRenderAction_PostRender)||!buffers)return noErr;
 atomic_fetch_add(&callbacks,1);uint32_t maximum=0;
 for(UInt32 b=0;b<buffers->mNumberBuffers;b++){const float *samples=buffers->mBuffers[b].mData;if(!samples)continue;for(size_t i=0;i<buffers->mBuffers[b].mDataByteSize/sizeof(float);i++)if(isfinite(samples[i])){float value=fabsf(samples[i]);uint32_t level=(uint32_t)(fminf(value,1)*1000000);if(level>maximum)maximum=level;}}
 if(maximum){atomic_fetch_add(&nonzero,1);if(*flags&kAudioUnitRenderAction_OutputIsSilence)atomic_fetch_add(&nonzeroMarkedSilent,1);uint32_t prior=atomic_load(&peak);while(prior<maximum&&!atomic_compare_exchange_weak(&peak,&prior,maximum)){} }
 return noErr;
}
static OSStatus create_output(AudioComponent component,AudioComponentInstance *instance){
 OSStatus result=AudioComponentInstanceNew(component,instance);AudioComponentDescription description={0};
 if(result==noErr&&AudioComponentGetDescription(component,&description)==noErr&&description.componentType==kAudioUnitType_Output){atomic_store(&output,(uintptr_t)*instance);atomic_fetch_add(&created,1);result=AudioUnitAddRenderNotify(*instance,observe,NULL);}
 return result;
}
static OSStatus start_output(AudioUnit unit){OSStatus result=AudioOutputUnitStart(unit);if(result==noErr&&(uintptr_t)unit==atomic_load(&output))atomic_fetch_add(&started,1);return result;}
static OSStatus dispose_output(AudioComponentInstance unit){uintptr_t expected=(uintptr_t)unit;atomic_compare_exchange_strong(&output,&expected,0);return AudioComponentInstanceDispose(unit);}
__attribute__((used)) static struct{const void *replacement,*original;} interposers[] __attribute__((section("__DATA,__interpose")))={
 {(const void*)create_output,(const void*)AudioComponentInstanceNew},{(const void*)start_output,(const void*)AudioOutputUnitStart},{(const void*)dispose_output,(const void*)AudioComponentInstanceDispose}
};
JNIEXPORT jlongArray JNICALL Java_NativeAudioTrackProbe_audioSnapshot(JNIEnv *env,jclass unused){
 (void)unused;AudioUnit unit=(AudioUnit)atomic_load(&output);AudioDeviceID device=0;UInt32 size=sizeof(device);if(unit)AudioUnitGetProperty(unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,0,&device,&size);
 UInt32 muted=0,running=0;Float32 volume=0;Float64 rate=0;AudioObjectPropertyAddress address={kAudioDevicePropertyMute,kAudioDevicePropertyScopeOutput,kAudioObjectPropertyElementMain};size=sizeof(muted);int hasMute=device&&AudioObjectGetPropertyData(device,&address,0,NULL,&size,&muted)==noErr;
 address.mSelector=kAudioDevicePropertyVolumeScalar;size=sizeof(volume);int hasVolume=device&&AudioObjectGetPropertyData(device,&address,0,NULL,&size,&volume)==noErr;
 address.mSelector=kAudioDevicePropertyDeviceIsRunningSomewhere;address.mScope=kAudioObjectPropertyScopeGlobal;size=sizeof(running);if(device)AudioObjectGetPropertyData(device,&address,0,NULL,&size,&running);
 address.mSelector=kAudioDevicePropertyNominalSampleRate;size=sizeof(rate);if(device)AudioObjectGetPropertyData(device,&address,0,NULL,&size,&rate);
 jlong values[]={atomic_load(&created),atomic_load(&started),atomic_load(&callbacks),atomic_load(&nonzero),atomic_load(&peak),device,hasMute?(jlong)muted:-1,hasVolume?(jlong)(volume*1000000):-1,running,(jlong)rate,atomic_load(&nonzeroMarkedSilent)};
 jlongArray result=(*env)->NewLongArray(env,11);if(result)(*env)->SetLongArrayRegion(env,result,0,11,values);return result;
}
JNIEXPORT jint JNICALL Java_NativeAudioTrackProbe_playAaudio(JNIEnv *env,jclass unused,jstring path){
 (void)unused;const char *file=(*env)->GetStringUTFChars(env,path,NULL);if(!file)return -1;void *library=dlopen(file,RTLD_NOW|RTLD_LOCAL);(*env)->ReleaseStringUTFChars(env,path,file);if(!library)return -2;
 void *(*lookup)(const char*)=dlsym(library,"kl_aaudio_lookup");if(!lookup){dlclose(library);return -3;}
 int (*create)(void**)=lookup("AAudio_createStreamBuilder"),(*open)(void*,void**)=lookup("AAudioStreamBuilder_openStream"),(*start)(void*)=lookup("AAudioStream_requestStart"),(*write)(void*,const void*,int,int64_t)=lookup("AAudioStream_write"),(*close)(void*)=lookup("AAudioStream_close"),(*delete)(void*)=lookup("AAudioStreamBuilder_delete");
 void (*rate)(void*,int)=lookup("AAudioStreamBuilder_setSampleRate"),(*channels)(void*,int)=lookup("AAudioStreamBuilder_setChannelCount"),(*format)(void*,int)=lookup("AAudioStreamBuilder_setFormat");
 void *builder=NULL,*stream=NULL;int result=-4;
 if(create&&open&&start&&write&&close&&delete&&rate&&channels&&format&&create(&builder)==0){
  rate(builder,48000);channels(builder,2);format(builder,1);
  if(open(builder,&stream)==0&&start(stream)==0){int16_t samples[9600*2];for(int i=0;i<9600;i++)samples[i*2]=samples[i*2+1]=(int16_t)lrint(1024*sin(2*3.141592653589793*440*i/48000.0));result=write(stream,samples,9600,1000000000);}
  if(stream)close(stream);delete(builder);
 }
 void (*report)(FILE*)=dlsym(library,"kl_audio_report");if(report)report(stderr);dlclose(library);return result;
}
