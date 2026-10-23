#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char **argv){
 assert(argc==6);void *core=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!core){fprintf(stderr,"%s\n",dlerror());return 2;}
 void *(*load)(const char *)=dlsym(core,"kl_load");void (*publish)(const char *,void *)=dlsym(core,"kl_register_image");
 void *(*symbol)(void *,const char *)=dlsym(core,"kl_sym");void *(*open_guest)(const char *,int)=dlsym(core,"klb_dlopen");
 void *(*lookup)(void *,const char *)=dlsym(core,"klb_dlsym");int (*set_sdk)(unsigned)=dlsym(core,"klj_library_set_target_sdk");
 assert(load&&publish&&symbol&&open_guest&&lookup&&set_sdk);
 const char *mode=argv[5];int legacy=!strcmp(mode,"legacy");
 if(!strcmp(mode,"late-sdk")){void *first=load(argv[2]);assert(first);publish("libscope-local.so",first);assert(!set_sdk(35));puts("PASS target SDK must precede image publication");fflush(stdout);_Exit(0);}
 assert(set_sdk(legacy?22:35));assert(!set_sdk(0));assert(!set_sdk(legacy?35:22));
 void *local;
 if(!strcmp(mode,"global")){local=open_guest(argv[2],2|0x100);assert(local);}
 else{local=load(argv[2]);assert(local);publish("libscope-local.so",local);}
 void *dependency=load(argv[3]);assert(dependency);publish("libscope-dep.so",dependency);
 void *consumer=load(argv[4]);assert(consumer);publish("libscope-consumer.so",consumer);
 assert(set_sdk(legacy?22:35));
 void *(*pointer)(void)=symbol(consumer,"scope_pointer");void *(*guest_lookup)(void *,const char *)=symbol(consumer,"scope_lookup");assert(pointer&&guest_lookup);
 void *choice=symbol(dependency,"scope_choice"),*other=symbol(local,"scope_choice"),*only=symbol(local,"scope_local_only");assert(choice&&other&&only);
 int df=!strcmp(mode,"df-global");assert(pointer()==(df?other:choice));
 assert(lookup(consumer,"scope_dep_only")==symbol(dependency,"scope_dep_only"));
 assert(guest_lookup((void *)-1,"scope_choice")==choice);
 assert(guest_lookup(local,"scope_local_only")==only);
 assert(guest_lookup(NULL,"scope_local_only")==((legacy||df||!strcmp(mode,"global"))?only:NULL));
 assert(lookup(NULL,"scope_local_only")==((legacy||df||!strcmp(mode,"global"))?only:NULL));
 assert(lookup((void *)-1,"scope_choice")==NULL); /* No guest caller. */
 if(!strcmp(mode,"reload-global")){
  assert(open_guest(argv[2],2|4|0x100)==local);assert(lookup(NULL,"scope_local_only")==NULL);
  /* Pinned Bionic preserves existing flags on an already loaded image. */
  assert(pointer()==choice);
 }
 assert(lookup(consumer,"scope_deliberately_missing")==NULL);
 puts("PASS original local/global relocation, caller DEFAULT/NEXT, explicit dependency handles and immutable target SDK");fflush(stdout);_Exit(0);
}
