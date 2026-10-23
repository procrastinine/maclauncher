#include "audio-capture.h"
#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
static int enabled=1,opened,opens,closes,constant;
static unsigned position;
int kl_audio_mic_open(unsigned rate,unsigned channels){(void)rate;(void)channels;if(!enabled||opened)return -1;opened=1;opens++;position=0;return 0;}
void kl_audio_mic_close(void){assert(opened);opened=0;closes++;}
unsigned kl_audio_mic_rate(void){return 48000;}
unsigned kl_audio_mic_channels(void){return 1;}
int kl_audio_mic_read_i16(int16_t *samples,int count){for(int i=0;i<count;i++)samples[i]=constant?8192:(int16_t)(1000*position++);return count;}
static void near(float actual,float expected){assert(fabsf(actual-expected)<1e-6f);}
int main(void){
    KljAudioCapture *capture=klj_audio_capture_create(48000,2,2);assert(capture&&klj_audio_capture_rate(capture)==48000&&klj_audio_capture_channels(capture)==1);
    assert(!klj_audio_capture_create(48000,1,1));
    struct {float samples[6];uint32_t guard;} output={{0},0x91a7c531};
    assert(klj_audio_capture_read(capture,output.samples,3,0)==3);
    for(unsigned i=0;i<3;i++)for(unsigned channel=0;channel<2;channel++)near(output.samples[2*i+channel],i*1000/32768.0f);
    assert(klj_audio_capture_read(capture,output.samples,3,0)==3);
    for(unsigned i=0;i<3;i++)for(unsigned channel=0;channel<2;channel++)near(output.samples[2*i+channel],(i+3)*1000/32768.0f);
    assert(output.guard==0x91a7c531);klj_audio_capture_destroy(capture);assert(opens==1&&closes==1);
    constant=1;capture=klj_audio_capture_create(24000,1,2);assert(capture);
    assert(klj_audio_capture_read(capture,output.samples,2,0)==2);near(output.samples[0],0.125f);near(output.samples[1],0.21875f);
    assert(klj_audio_capture_read(capture,output.samples,2,0)==2);near(output.samples[0],0.2421875f);near(output.samples[1],0.248046875f);
    klj_audio_capture_destroy(capture);assert(opens==2&&closes==2);
    capture=klj_audio_capture_create(48000,1,1);assert(capture);int16_t pcm[3]={0};assert(klj_audio_capture_read(capture,pcm,3,0)==3);for(unsigned i=0;i<3;i++)assert(pcm[i]==8192);
    klj_audio_capture_destroy(capture);enabled=0;assert(!klj_audio_capture_create(48000,1,1));assert(opens==3&&closes==3);
    puts("PASS original shared capture conversion, fractional carry, anti-alias state, format, exact bounds and physical lifetime");
}
