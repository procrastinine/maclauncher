#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc,char **argv){
    assert(argc==7);
    void *core=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!core){fprintf(stderr,"%s\n",dlerror());return 2;}
    void *(*open_guest)(const char *,int)=dlsym(core,"klb_dlopen");
    void *(*lookup)(void *,const char *)=dlsym(core,"klb_dlsym");
    void *(*symbol)(void *,const char *)=dlsym(core,"kl_sym");
    char *(*error)(void)=dlsym(core,"klb_dlerror");
    int (*close_guest)(void *)=dlsym(core,"klb_dlclose");
    int (*sdk)(unsigned)=dlsym(core,"klj_library_set_target_sdk");
    int (*startup)(int,const char *const *,size_t,const char *const *)=dlsym(core,"klj_library_set_startup");
    assert(open_guest&&lookup&&symbol&&error&&close_guest&&sdk&&startup);
    const char *args[]={"main.handle.control",NULL},*environment[]={NULL};
    unsigned target=(unsigned)strtoul(argv[5],NULL,10);
    assert(sdk(target)&&startup(1,args,0,environment));
    void *first=open_guest(argv[2],2|0x100);assert(first);
    void *second=open_guest(argv[3],2|0x100);assert(second);
    void *local=open_guest(argv[4],2);assert(local);
    void *(*guest_lookup)(unsigned,const char *)=symbol(first,"main_handle_lookup");
    void *(*local_lookup)(unsigned,const char *)=symbol(local,"main_handle_lookup");
    void *choice=symbol(first,"main_handle_choice"),*next=symbol(second,"main_handle_choice");
    void *local_only=symbol(local,"main_handle_local_only");
    assert(guest_lookup&&local_lookup&&choice&&next&&choice!=next&&local_only);
    void *main_handle=open_guest(NULL,2);
    void *self=guest_lookup(0,"main_handle_choice");
    if(self!=choice){
        assert(!strcmp(argv[6],"baseline"));
        assert(main_handle==(void *)-1&&self==next);
        fprintf(stderr,"FAIL dlopen(NULL) aliases RTLD_NEXT: main=%p expected=%p got=%p\n",main_handle,choice,self);
        return 42;
    }
    assert(strcmp(argv[6],"baseline"));
    assert(main_handle&&main_handle!=(void *)-1);
    assert(open_guest(NULL,2|4)==main_handle);
    assert(lookup(main_handle,"main_handle_choice")==choice);
    assert(guest_lookup(1,"main_handle_choice")==choice);
    assert(guest_lookup(2,"main_handle_choice")==next);
    assert(lookup((void *)-1,"main_handle_choice")==NULL); /* No guest NEXT caller. */
    (void)error();
    assert(local_lookup(1,"main_handle_local_only")==local_only);
    assert(local_lookup(0,"main_handle_local_only")==((target<23)?local_only:NULL));
    assert(lookup(main_handle,"main_handle_local_only")==((target<23)?local_only:NULL));
    (void)error();
    assert(lookup(main_handle,"getpid"));assert(!error());
    assert(!lookup(main_handle,"main_handle_missing_symbol"));
    const char *failure=error();assert(failure&&strstr(failure,"main_handle_missing_symbol"));
    assert(!error());
    assert(close_guest(main_handle)==0&&open_guest(NULL,2)==main_handle);
    assert(guest_lookup(0,"main_handle_choice")==choice);
    puts("PASS main-program handle, global scope, SDK-local compatibility, DEFAULT/NEXT, dlerror and repeated close/open");
    fflush(stdout);_Exit(0);
}
