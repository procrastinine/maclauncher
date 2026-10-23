#include <SLES/OpenSLES.h>
#include <SLES/OpenSLES_Android.h>
#include <string.h>

// A local ELF owner with the original NDK ABI. Its UUID comes from the actual
// complete original OpenSL IID source; no constants or layouts are copied.
static SLresult count(SLEngineItf self,SLuint32 object,SLuint32 *out){
 (void)self;(void)object;*out=INTERFACE_OWNER;return SL_RESULT_SUCCESS;
}
static const struct SLObjectItf_ *object;
static SLresult create_mix(SLEngineItf self,SLObjectItf *out,SLuint32 n,const SLInterfaceID *ids,const SLboolean *required){
 (void)self;(void)n;(void)ids;(void)required;*out=&object;return SL_RESULT_SUCCESS;
}
static SLresult create_player(SLEngineItf self,SLObjectItf *out,SLDataSource *source,SLDataSink *sink,SLuint32 n,const SLInterfaceID *ids,const SLboolean *required){
 (void)self;(void)n;(void)ids;(void)required;
 const SLDataLocator_OutputMix *mix=sink->pLocator;
 if(mix->locatorType!=SL_DATALOCATOR_OUTPUTMIX||mix->outputMix!=&object||sink->pFormat)return SL_RESULT_PARAMETER_INVALID;
 SLuint32 tag=*(SLuint32 *)source->pLocator;
 if(tag==SL_DATALOCATOR_ANDROIDSIMPLEBUFFERQUEUE){
  const SLDataLocator_AndroidSimpleBufferQueue *queue=source->pLocator;
  const SLAndroidDataFormat_PCM_EX *pcm=source->pFormat;
  if(queue->numBuffers!=2||pcm->formatType!=SL_ANDROID_DATAFORMAT_PCM_EX||pcm->numChannels!=2||pcm->sampleRate!=44100000||pcm->representation!=SL_ANDROID_PCM_REPRESENTATION_FLOAT)return SL_RESULT_PARAMETER_INVALID;
 }else if(tag==SL_DATALOCATOR_URI){
  const SLDataLocator_URI *uri=source->pLocator;const SLDataFormat_MIME *mime=source->pFormat;
  if(strcmp((const char *)uri->URI,"fixture://original")||mime->formatType!=SL_DATAFORMAT_MIME||strcmp((const char *)mime->mimeType,"audio/test")||mime->containerType!=SL_CONTAINERTYPE_UNSPECIFIED)return SL_RESULT_PARAMETER_INVALID;
 }else if(tag==SL_DATALOCATOR_ANDROIDFD){
  const SLDataLocator_AndroidFD *fd=source->pLocator;
  if(fd->fd!=7||fd->offset!=0x100000003LL||fd->length!=0x200000005LL)return SL_RESULT_PARAMETER_INVALID;
 }else return SL_RESULT_PARAMETER_INVALID;
 *out=&object;return SL_RESULT_SUCCESS;
}
static const struct SLEngineItf_ engine_methods={.CreateAudioPlayer=create_player,.CreateOutputMix=create_mix,.QueryNumSupportedInterfaces=count};
static const struct SLEngineItf_ *engine=&engine_methods;
static SLresult query(SLObjectItf self,const SLInterfaceID id,void *out){
 (void)self;
 if(!memcmp(id,SL_IID_ENGINE,sizeof *id)){*(SLEngineItf *)out=&engine;return SL_RESULT_SUCCESS;}
 *(void **)out=0;return SL_RESULT_FEATURE_UNSUPPORTED;
}
static void destroy(SLObjectItf self){(void)self;}
static const struct SLObjectItf_ object_methods={.GetInterface=query,.Destroy=destroy};
static const struct SLObjectItf_ *object=&object_methods;
SLresult slCreateEngine(SLObjectItf *out,SLuint32 n,const SLEngineOption *options,
 SLuint32 count,const SLInterfaceID *ids,const SLboolean *required){
 (void)n;(void)options;(void)count;(void)ids;(void)required;*out=&object;return SL_RESULT_SUCCESS;
}
