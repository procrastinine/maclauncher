#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {int argc;char **argv;char **envp;} Startup;
int main(int argc,char **argv){
    assert(argc==4);void *core=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!core){fputs(dlerror(),stderr);return 2;}
    void *(*load)(const char *)=dlsym(core,"kl_load");void *(*symbol)(void *,const char *)=dlsym(core,"kl_sym");
    int (*initialize)(void *,int(*)(void *),void *)=dlsym(core,"klj_run_initializers");
    void (*publish)(const char *,void *)=dlsym(core,"kl_register_image");
    int (*install)(int,const char *const *,size_t,const char *const *)=dlsym(core,"klj_library_set_startup");
    const Startup *(*get)(void)=dlsym(core,"klj_library_startup");assert(load&&symbol&&initialize&&publish);
    const char *args[]={"startup.owner","before","","\xf0\x9f\x8e\xae",NULL};
    const char *env[]={"HOME=/guest/\xe6\xb8\xb8\xe6\x88\x8f","EMPTY=","ANDROID_DATA=/data",NULL};
    const char *bad[]={"BAD-KEY=value",NULL},*duplicate[]={"A=one","A=two",NULL};
    int baseline=!strcmp(argv[3],"baseline");
    if(!baseline){assert(install&&get);assert(!get());assert(!install(0,args,3,env));assert(!install(4,args,1,bad));assert(!install(4,args,2,duplicate));}
    if(!strcmp(argv[3],"missing")){
        void *image=load(argv[2]);assert(image);int *calls=symbol(image,"startup_calls");assert(calls);assert(!initialize(image,NULL,NULL));
        assert(*calls==0);puts("PASS missing startup fails before constructors");return 0;
    }
    if(!strcmp(argv[3],"late")){
        void *image=load(argv[2]);assert(image);publish("libstartup.so",image);assert(!install(4,args,3,env));assert(!get());puts("PASS startup rejects first configuration after publication");return 0;
    }
    if(!baseline){assert(install(4,args,3,env));assert(install(4,args,3,env));}
    const Startup *startup=baseline?NULL:get();if(startup){assert(startup->argc==4);assert(startup->argv!=(char **)args&&startup->envp!=(char **)env);assert(!strcmp(startup->argv[1],"before"));}
    void *image=load(argv[2]);assert(image);
    *(int *)symbol(image,"startup_expected_argc")=4;
    *(char ***)symbol(image,"startup_expected_argv")=baseline?(char **)args:startup->argv;
    *(char ***)symbol(image,"startup_expected_envp")=baseline?(char **)env:startup->envp;
    int result=initialize(image,NULL,NULL);assert(result);
    int status=*(int *)symbol(image,"startup_status");
    if(baseline){if(status!=1){fprintf(stderr,"Unexpected baseline status %d\n",status);return 43;}fputs("FAIL original constructor ABI omitted startup arguments\n",stderr);return 42;}
    assert(!status);assert(*(int *)symbol(image,"startup_order")==3);assert(*(int *)symbol(image,"startup_calls")==3);
    assert(!strcmp(startup->argv[1],"Before"));assert(install(4,args,3,env));
    const char *changed[]={"different.owner","before","","\xf0\x9f\x8e\xae",NULL};assert(!install(4,changed,3,env));
    const char *changedEnv[]={"HOME=/different","EMPTY=","ANDROID_DATA=/data",NULL};assert(!install(4,args,3,changedEnv));assert(get()==startup);
    assert(initialize(image,NULL,NULL));assert(*(int *)symbol(image,"startup_calls")==3);
    puts("PASS constructor ABI, order, sentinels, UTF8, writable sharing and immutable repeat");return 0;
}
