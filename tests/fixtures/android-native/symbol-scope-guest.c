#include <dlfcn.h>
#if defined(SCOPE_CONSUMER)
extern int scope_choice(void);
void *scope_pointer(void){return (void *)scope_choice;}
__attribute__((disable_tail_calls)) void *scope_lookup(void *handle,const char *name){return dlsym(handle,name);}
#elif defined(SCOPE_DEPENDENCY)
int scope_choice(void){return 37;}
int scope_dep_only(void){return 41;}
#else
int scope_choice(void){return 19;}
int scope_local_only(void){return 23;}
#endif
