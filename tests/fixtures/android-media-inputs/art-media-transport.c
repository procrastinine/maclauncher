#include "art-media-transport.h"
#include <assert.h>
extern int64_t maclauncher_art_media(uint64_t,uint64_t);
int64_t klj_art_media_test_call(uint32_t function,void *packet,size_t size){assert(function==8);return maclauncher_art_media((uintptr_t)packet,size);}
/* Off is verified against the real shared device/configuration implementation.
 * Any attempt to reach the physical microphone is a test failure. */
void klj_audio_capture_select(uint32_t selected){assert(selected==0);}
int kl_audio_mic_open(unsigned rate,unsigned channels){(void)rate;(void)channels;assert(0);return -1;}
void kl_audio_mic_close(void){assert(0);}
unsigned kl_audio_mic_rate(void){assert(0);return 0;}
unsigned kl_audio_mic_channels(void){assert(0);return 0;}
int kl_audio_mic_read_i16(int16_t *output,int count){(void)output;(void)count;assert(0);return 0;}
