#include <assert.h>
#include <dlfcn.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static uint64_t word(uintptr_t at) { uint64_t value;memcpy(&value,(void *)at,sizeof value);return value; }
int main(int argc,char **argv) {
    assert(argc==5);
    void *core=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!core){fprintf(stderr,"core: %s\n",dlerror());return 2;}
    void *(*load)(const char *)=dlsym(core,"kl_load");void *(*base)(void *)=dlsym(core,"kl_base");
    void *(*symbol)(void *,const char *)=dlsym(core,"kl_sym");
    void (*publish)(const char *,void *)=dlsym(core,"kl_register_image");
    assert(load&&base&&symbol&&publish);
    int (*set_sdk)(unsigned)=dlsym(core,"klj_library_set_target_sdk");if(set_sdk)assert(set_sdk(35));
    const char *name="_ZNSt6__ndk18ios_base4initEPv";
    void *local=load(argv[2]);assert(local);publish("libscope-local.so",local);
    uintptr_t local_symbol=(uintptr_t)symbol(local,name);assert(local_symbol);
    void *cpp=load(argv[3]);assert(cpp);publish("libc++_shared.so",cpp);
    uintptr_t cpp_symbol=(uintptr_t)symbol(cpp,name);assert(cpp_symbol==(uintptr_t)base(cpp)+UINT64_C(0xe1fcc));
    void *jsi=load(argv[4]);assert(jsi);uintptr_t jsi_slot=(uintptr_t)base(jsi)+UINT64_C(0x67cc8);
    uint64_t resolved=word(jsi_slot);
    printf("{\"loadOnly\":true,\"originalInitializersCalled\":false,\"localExporter\":\"0x%" PRIxPTR "\",\"cppDefinition\":\"0x%" PRIxPTR "\",\"jsiSlot\":\"0x%" PRIxPTR "\",\"resolved\":\"0x%" PRIx64 "\",\"matchesDependency\":%s,\"leakedLocalExporter\":%s}\n",local_symbol,cpp_symbol,jsi_slot,resolved,resolved==cpp_symbol?"true":"false",resolved==local_symbol?"true":"false");
    fflush(stdout);_Exit(resolved==cpp_symbol?0:1);
}
