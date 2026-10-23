#include "audio-pcm.h"
#include <assert.h>
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int klj_audio_pcm_device(void){return 0;}
static void near(float actual,float expected){assert(fabsf(actual-expected)<1e-6f);}
static void independent(void){
    void *a=klj_audio_pcm_create(32,2,48000),*b=klj_audio_pcm_create(32,2,24000);assert(a&&b);
    float samples[128];for(int i=0;i<128;i++)samples[i]=.25f;
    assert(klj_audio_pcm_write(a,samples,64)==32);
    assert(klj_audio_pcm_write(b,samples,32)==32);
    klj_audio_pcm_state(a,0);klj_audio_pcm_state(b,0);
    float output[16]={0};klj_audio_pcm_mix(output,8,2,48000);
    for(int i=0;i<16;i++)near(output[i],.5f);
    assert(klj_audio_pcm_position(a)==8&&klj_audio_pcm_position(b)==4);
    klj_audio_pcm_state(a,1);memset(output,0,sizeof output);klj_audio_pcm_mix(output,4,2,24000);
    for(int i=0;i<8;i++)near(output[i],.25f);
    assert(klj_audio_pcm_position(a)==8&&klj_audio_pcm_position(b)==8);
    klj_audio_pcm_state(a,2);assert(klj_audio_pcm_position(a)==0&&klj_audio_pcm_queued(a)==0);
    klj_audio_pcm_destroy(a);klj_audio_pcm_destroy(b);assert(!klj_audio_pcm_has_sources());
}
static void precision(void){
    void *source=klj_audio_pcm_create(442,1,44100);assert(source);
    float values[442];for(int i=0;i<442;i++)values[i]=i*0.0000002f;
    assert(klj_audio_pcm_write(source,values,442)==442);klj_audio_pcm_state(source,0);
    float output[960]={0};klj_audio_pcm_mix(output,480,2,48000);
    for(int i=0;i<480;i++){
        float expected=i*(44100.f/48000.f)*0.0000002f;
        assert(fabsf(output[i*2]-expected)<1e-10f);assert(output[i*2]==output[i*2+1]);
    }
    assert(output[2]>0&&output[2]<1.f/32768); // no intermediate PCM16 quantization
    assert(klj_audio_pcm_position(source)==441&&klj_audio_pcm_queued(source)==1);
    klj_audio_pcm_destroy(source);
}
static void channels_and_controls(void){
    void *source=klj_audio_pcm_create(16,4,48000);assert(source);
    float values[64];for(int i=0;i<16;i++){values[i*4]=.1f;values[i*4+1]=.2f;values[i*4+2]=.3f;values[i*4+3]=.4f;}
    assert(klj_audio_pcm_write(source,values,16)==16);klj_audio_pcm_state(source,0);
    float output[8]={0};klj_audio_pcm_mix(output,2,4,48000);
    for(int i=0;i<8;i++)near(output[i],(i%4+1)*.1f);
    // Controls affect already queued source frames, with one rate conversion.
    klj_audio_pcm_controls(source,96000,.5f,.25f,0);memset(output,0,sizeof output);klj_audio_pcm_mix(output,2,4,48000);
    for(int i=0;i<8;i++)near(output[i],(i%4+1)*.1f*((i&1)?.25f:.5f));
    assert(klj_audio_pcm_position(source)==6);
    klj_audio_pcm_controls(source,48000,1,1,2);memset(output,0,sizeof output);klj_audio_pcm_mix(output,1,2,48000);
    near(output[0],.2f);near(output[1],.2f);
    klj_audio_pcm_state(source,1);uint64_t position=klj_audio_pcm_position(source);memset(output,0,sizeof output);klj_audio_pcm_mix(output,2,4,44100);
    for(int i=0;i<8;i++)near(output[i],0);assert(klj_audio_pcm_position(source)==position);
    klj_audio_pcm_destroy(source);
}
typedef struct {void *source;_Atomic int started;int result;} pending;
static void *write_full(void *argument){pending *p=argument;float samples[16]={0};atomic_store(&p->started,1);p->result=klj_audio_pcm_write(p->source,samples,16);return NULL;}
static void cancellation(void){
    pending p={.source=klj_audio_pcm_create(8,1,48000)};assert(p.source);float samples[8]={0};
    assert(klj_audio_pcm_write(p.source,samples,8)==8);klj_audio_pcm_state(p.source,0);
    pthread_t thread;assert(!pthread_create(&thread,NULL,write_full,&p));while(!atomic_load(&p.started))usleep(100);usleep(5000);
    klj_audio_pcm_state(p.source,1);pthread_join(thread,NULL);assert(p.result==0&&klj_audio_pcm_queued(p.source)==8);
    klj_audio_pcm_state(p.source,0);float output[8]={0};klj_audio_pcm_mix(output,8,1,48000);assert(klj_audio_pcm_position(p.source)==8);
    klj_audio_pcm_destroy(p.source);
}
static void clips(void){
    const int16_t samples[]={8192,-8192,16384,-16384};
    void *a=klj_audio_pcm_clip(samples,2,2,48000),*b=klj_audio_pcm_clip(samples,2,2,24000);assert(a&&b);
    klj_audio_pcm_clip_loops(a,1);klj_audio_pcm_state(a,0);float output[12]={0};
    klj_audio_pcm_mix(output,6,2,48000);
    near(output[0],.25f);near(output[2],.5f);near(output[4],.25f);near(output[6],.5f);near(output[8],0);
    assert(!klj_audio_pcm_playing(a)&&klj_audio_pcm_position(a)==4);
    klj_audio_pcm_state(a,0);assert(klj_audio_pcm_position(a)==0);klj_audio_pcm_state(a,1);
    klj_audio_pcm_controls(b,48000,.5f,.25f,0);klj_audio_pcm_state(b,0);memset(output,0,sizeof output);klj_audio_pcm_mix(output,1,2,48000);
    near(output[0],.125f);near(output[1],-.0625f);assert(klj_audio_pcm_position(a)==0&&klj_audio_pcm_position(b)==1);
    klj_audio_pcm_clip_loops(b,-1);klj_audio_pcm_clip_seek(b,0);memset(output,0,sizeof output);klj_audio_pcm_mix(output,5,2,48000);
    assert(klj_audio_pcm_playing(b)&&klj_audio_pcm_position(b)==5);
    klj_audio_pcm_clip_loops(b,0);memset(output,0,sizeof output);klj_audio_pcm_mix(output,3,2,48000);
    near(output[0],.25f);near(output[2],0);assert(!klj_audio_pcm_playing(b));
    klj_audio_pcm_clip_seek(b,1);klj_audio_pcm_state(b,0);memset(output,0,sizeof output);klj_audio_pcm_mix(output,3,2,48000);
    near(output[0],.25f);near(output[2],0);klj_audio_pcm_state(b,3);assert(klj_audio_pcm_position(b)==0);
    klj_audio_pcm_destroy(a);klj_audio_pcm_destroy(b);
}
int main(void){
    independent();precision();channels_and_controls();cancellation();clips();
    assert(!klj_audio_pcm_has_sources());float output[16]={0};klj_audio_pcm_mix(output,8,2,48000);for(int i=0;i<16;i++)assert(output[i]==0);
    puts("PASS independent PCM queues, original float precision/channels/rate, device conversion, live controls, pause, cancellation and release");
}
