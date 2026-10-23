#include <assert.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
int main(int argc,char**argv){
 assert(argc==3);void* core=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);assert(core);
 void* device=dlopen(argv[2],RTLD_NOW|RTLD_LOCAL);if(!device)fprintf(stderr,"%s\n",dlerror());assert(device);
 int(*load)(void*,void*)=dlsym(device,"JNI_OnLoad");void*(*lookup)(const char*)=dlsym(core,"klj_resolve_import");assert(load&&lookup);
 assert(load(NULL,NULL)==0x00010006&&load(NULL,NULL)==0x00010006);
 const char* names[]={"klj_video_device_open","klj_video_device_close","klj_video_device_submit","klj_video_device_complete","klj_video_device_drain","klj_video_device_flush","klj_video_device_pull","klj_video_picture_release","klj_video_picture_copy","klj_video_device_profiles","klj_video_device_hardware"};
 for(size_t i=0;i<sizeof(names)/sizeof(names[0]);i++)assert(lookup(names[i])&&lookup(names[i])==dlsym(device,names[i]));
 assert(!lookup("AMediaFormat_new")&&!lookup("AMediaCodec_createDecoderByType")&&!lookup("AImageReader_new"));
 assert(!lookup("klj_video_device_absent")&&!dlsym(device,"AMediaFormat_new"));
 size_t(*profiles)(const char*,int32_t*,int32_t*,size_t)=lookup("klj_video_device_profiles");assert(profiles("video/avc",NULL,NULL,0)>0);
 uint64_t(*openDevice)(const char*)=lookup("klj_video_device_open");void(*closeDevice)(uint64_t)=lookup("klj_video_device_close");
 uint64_t decoder=openDevice("video/avc");assert(decoder);closeDevice(decoder);
 puts("PASS typed media device imports and original framework ownership");return 0;
}
