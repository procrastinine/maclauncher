#include <jni.h>
#include <dlfcn.h>
__attribute__((disable_tail_calls)) void *vm_self(const char *name){return dlsym(RTLD_SELF,name);}
__attribute__((disable_tail_calls)) void *vm_next(const char *name){return dlsym(RTLD_NEXT,name);}
void *vm_direct(void){return (void*)JNI_CreateJavaVM;}
