#include <dlfcn.h>
#if defined(NAMESPACE_PARENT)
void *open_companion(const char *name){return dlopen(name,RTLD_NOW|RTLD_LOCAL);}
#elif defined(NAMESPACE_DEPENDENCY)
int namespace_dependency(void){return 37;}
#elif defined(NAMESPACE_COMPANION)
extern int namespace_dependency(void);
int namespace_value(void){return namespace_dependency()+5;}
#else
int namespace_peer(void){return 99;}
#endif
