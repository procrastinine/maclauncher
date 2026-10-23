#include <dlfcn.h>

#ifndef MAIN_HANDLE_SECOND
#ifndef MAIN_HANDLE_LOCAL
__attribute__((visibility("default"))) int main_handle_choice(void){return 77;}
#else
__attribute__((visibility("default"))) int main_handle_local_only(void){return 99;}
#endif

__attribute__((visibility("default"),disable_tail_calls)) void *main_handle_lookup(unsigned kind,const char *name){
    void *handle=kind==0?dlopen(0,RTLD_NOW):kind==1?RTLD_DEFAULT:RTLD_NEXT;
    return dlsym(handle,name);
}
#else
__attribute__((visibility("default"))) int main_handle_choice(void){return 88;}
#endif
