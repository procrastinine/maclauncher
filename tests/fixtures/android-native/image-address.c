#include <assert.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int same_name(const char *left,const char *right) {
    return left&&right?!strcmp(left,right):left==right;
}
int main(int argc,char **argv) {
    assert(argc==3);
    void *core=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!core){fprintf(stderr,"%s\n",dlerror());return 1;}
    int (*address)(const void *,Dl_info *)=dlsym(core,"klb_dladdr");
    void *(*lookup)(const char *)=dlsym(core,"kl_shim_lookup");
    void *(*load)(const char *,int)=dlsym(core,"klb_dlopen");
    void *(*symbol)(void *,const char *)=dlsym(core,"klb_dlsym");
    void *(*base)(void *)=dlsym(core,"kl_base");
    assert(address&&lookup&&load&&symbol&&base);
    for(const char **name=(const char *[]) {"malloc","strlen","creat",NULL};*name;name++) {
        void *function=lookup(*name);assert(function);
        Dl_info expected={0},actual={0};assert(dladdr(function,&expected));
        assert(address(function,&actual));
        assert(same_name(actual.dli_fname,expected.dli_fname));
        assert(actual.dli_fbase==expected.dli_fbase);
        assert(same_name(actual.dli_sname,expected.dli_sname));
        assert(actual.dli_saddr==expected.dli_saddr);
        if(actual.dli_sname)assert(address(actual.dli_saddr,&actual));
    }
    Dl_info unknown={0};assert(!address((void *)(uintptr_t)1,&unknown));
    void *guest=load(argv[2],2);assert(guest);
    void *function=symbol(guest,"construction_count");assert(function);
    Dl_info translated={0};assert(address(function,&translated));
    const char *filename=strrchr(argv[2],'/');filename=filename?filename+1:argv[2];
    assert(translated.dli_fname && !strcmp(translated.dli_fname,filename));
    assert(translated.dli_fbase==base(guest));
    assert(!translated.dli_sname && !translated.dli_saddr);
    puts("PASS dladdr retains guest ELF ownership and exact Darwin provider metadata for native imports");
}
