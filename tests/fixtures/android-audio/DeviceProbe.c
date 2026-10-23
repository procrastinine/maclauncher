#include "audio-device.h"
#include <CoreAudio/CoreAudio.h>
#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdatomic.h>
static _Atomic unsigned changes;
static void changed(void *owner){assert(owner==&changes);atomic_fetch_add(&changes,1);}
int main(void){
    uint32_t device=0;assert(klj_audio_device_default_output(&device)==0);
    AudioDeviceID original=0;UInt32 size=sizeof(original);
    AudioObjectPropertyAddress address={kAudioHardwarePropertyDefaultOutputDevice,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    assert(AudioObjectGetPropertyData(kAudioObjectSystemObject,&address,0,NULL,&size,&original)==noErr&&original==device);
    uint32_t *devices=NULL;size_t count=0;assert(klj_audio_device_list(&devices,&count)==0);
    int found=!device;for(size_t i=0;i<count;i++)if(devices[i]==device)found=1;assert(found);free(devices);
    if(device){
        KljAudioDevice output;assert(klj_audio_device_get(device,0,&output)==0);
        assert(output.id==device&&output.channels>0&&output.rate>0&&output.bufferFrames>0&&output.type>0&&output.name&&output.uid);
        double rate=0;address.mSelector=kAudioDevicePropertyNominalSampleRate;size=sizeof(rate);
        assert(AudioObjectGetPropertyData(device,&address,0,NULL,&size,&rate)==noErr&&rate==output.rate);
        klj_audio_device_release(&output);assert(!output.name&&!output.uid);klj_audio_device_release(&output);
    }
    for(unsigned i=0;i<16;i++){KljAudioDeviceMonitor *monitor=klj_audio_device_monitor(changed,&changes);assert(monitor);assert(klj_audio_device_monitor_close(monitor)==0);}
    assert(klj_audio_device_generation()>0);
    puts("PASS shared physical CoreAudio inventory, format, identity, strings and monitor lifetime");
}
