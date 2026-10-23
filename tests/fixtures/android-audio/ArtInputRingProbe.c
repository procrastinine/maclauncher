#include <assert.h>
#include <fcntl.h>
#include "../../../src/modules/android/art/native/audio-host.c"
static unsigned selected,format,starts,stops,closes,generated;
static int active;
int klj_media_configure(const char *audio,const char *video){(void)audio;(void)video;return 0;}
uint32_t klj_media_audio_device(void){return selected;}
int64_t klj_media_audio_open_format(int rate,int channels,int requested){assert(rate==48000&&channels==2);format=requested;return 7;}
int klj_media_audio_start(uint64_t token){assert(token==7);active=1;generated=0;starts++;return 1;}
int klj_media_audio_read_frames(uint64_t token,void *data,size_t frames){
 assert(token==7&&active&&frames==256);if(generated)return 0;generated=1;
 for(unsigned i=0;i<16;i++){if(format==2)((float*)data)[i]=0.25f;else ((int16_t*)data)[i]=8192;}return 8;
}
void klj_media_audio_stop(uint64_t token){assert(token==7);if(active){active=0;stops++;}}
void klj_media_audio_close(uint64_t token){assert(token==7);assert(!active);closes++;}
int klj_audio_pcm_device(void){assert(0);return -1;}
static void waitFrames(Ring *ring,uint64_t frames){for(unsigned i=0;i<1000&&atomic_load(&ring->write)<frames;i++)usleep(1000);assert(atomic_load(&ring->write)==frames);}
int main(void){
 unsetenv("MACLAUNCHER_ANDROID_AUDIO_INPUT_UID");
 for(unsigned sampleFormat=1;sampleFormat<=2;sampleFormat++){
  char name[]="/tmp/android-art-input-XXXXXX";int fd=mkstemp(name);assert(fd>=0);unlink(name);
  size_t bytes=sampleFormat==1?2:4,length=256+32*2*bytes;assert(!ftruncate(fd,(off_t)length));
  Ring *ring=mmap(NULL,length,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);assert(ring!=MAP_FAILED);ring->capacity=32;ring->frameBytes=2*bytes;
  Open open={.direction=1,.format=sampleFormat,.rate=48000,.channels=2,.fd=fd,.length=length};selected=0;
  assert(maclauncher_art_audio(2,(uintptr_t)&open,sizeof(open))==-13);selected=1;
  assert(maclauncher_art_audio(2,(uintptr_t)&open,sizeof(open))==0&&open.stream);assert(!atomic_load(&ring->callbacks));
  assert(maclauncher_art_audio(3,(uintptr_t)&open.stream,8)==0);waitFrames(ring,8);
  for(unsigned i=0;i<16;i++){if(sampleFormat==2)assert(((float*)((char*)ring+256))[i]==0.25f);else assert(((int16_t*)((char*)ring+256))[i]==8192);}
  assert(atomic_load(&ring->callbacks)&&atomic_load(&ring->peakBits));atomic_store(&ring->read,8);
  assert(maclauncher_art_audio(4,(uintptr_t)&open.stream,8)==0&&!active);
  assert(maclauncher_art_audio(3,(uintptr_t)&open.stream,8)==0);waitFrames(ring,16);atomic_store(&ring->read,16);
  assert(maclauncher_art_audio(5,(uintptr_t)&open.stream,8)==0&&!streams);munmap(ring,length);close(fd);
 }
 assert(starts==4&&stops==4&&closes==2);puts("PASS original ART input ring, explicit selection, exact I16/float frames, restart and retirement");
}
