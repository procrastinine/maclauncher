#include "media-platform.h"
#include <cassert>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <cstdint>
static unsigned selections;
extern "C" void klj_audio_capture_select(uint32_t selected){assert(selected==0);++selections;}
extern "C" int kl_audio_mic_open(unsigned,unsigned){assert(false);return -1;}
extern "C" void kl_audio_mic_close(void){assert(false);}
extern "C" unsigned kl_audio_mic_rate(void){assert(false);return 0;}
extern "C" unsigned kl_audio_mic_channels(void){assert(false);return 0;}
extern "C" int kl_audio_mic_read_i16(int16_t *,int){assert(false);return 0;}
int main(){
    char *devices=klj_media_devices();assert(devices&&std::strstr(devices,"audioInputs")&&std::strstr(devices,"cameraInputs"));std::free(devices);
    assert(klj_media_configure("missing-microphone-physical-identity","")==KLJ_MEDIA_NOT_FOUND);
    assert(klj_media_configure("","")==0&&selections==1);assert(!klj_media_authorized(0)&&!klj_media_authorized(1)&&!klj_media_audio_device());
    assert(klj_media_configure("","")==KLJ_MEDIA_CONFIGURED);
    assert(klj_media_audio_open(48000,1)==0&&!klj_media_audio_start(0));int16_t pcm[4];assert(klj_media_audio_read(0,pcm,4)==-3);
    size_t count=0;int *sizes=klj_media_camera_sizes(&count);assert(count==0);std::free(sizes);
    assert(klj_media_camera_open()==0&&!klj_media_camera_start(0,320,240));unsigned char frame[8];assert(klj_media_camera_read(0,frame,sizeof(frame))==-1);
    klj_media_audio_stop(0);klj_media_audio_close(0);klj_media_camera_stop(0);klj_media_camera_close(0);
    klj_media_shutdown();klj_media_shutdown();assert(selections==2&&klj_media_configure("","")==KLJ_MEDIA_CONFIGURED);
    std::cout<<"PASS shared complete media family, actual device inventory, selection privacy and idempotent retirement without implicit capture\n";
}
