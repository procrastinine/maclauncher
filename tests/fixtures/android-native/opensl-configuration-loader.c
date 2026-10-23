#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>

int main(int argc,char **argv){
 assert(argc==4);void *core=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!core){fprintf(stderr,"%s\n",dlerror());return 1;}
 int(*configure)(const char*)=dlsym(core,"klj_process_ids_configure");assert(configure&&configure(argv[3])>0);
 void(*vm)(void*)=dlsym(core,"klj_set_guest_thread_vm");assert(vm);vm(0);
 void(*enter)(void)=dlsym(core,"kl_thread_init");assert(enter);enter();
 void *(*lookup)(const char*)=dlsym(core,"kl_shim_lookup");assert(lookup);
 void *(*load)(const char*,int)=lookup("dlopen"),*(*symbol)(void*,const char*)=lookup("dlsym");assert(load&&symbol);
 void *library=load(argv[2],2);assert(library);int(*probe)(void)=symbol(library,"OpenSlConfigurationProbe");assert(probe);
 int line=probe();if(line){fprintf(stderr,"OpenSL configuration failed at guest line %d\n",line);return 2;}
 puts("PASS original Android OpenSL configuration, per-stream ownership and playback callbacks");return 0;
}
