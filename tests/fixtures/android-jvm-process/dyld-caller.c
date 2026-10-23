#include <dlfcn.h>
extern int scope_dependency(void);
int scope_same(void){return 101;}
__attribute__((disable_tail_calls)) void *scope_lookup(void *handle,const char *name){return dlsym(handle,name);}
int scope_linked_dependency(void){return scope_dependency();}
