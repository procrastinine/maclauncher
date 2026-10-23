#include <stdint.h>
#include <pthread.h>
#include <dlfcn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include GO_ANDROID_CGO_SOURCE

static inline void **thread_pointer(void){void **pointer;__asm__ volatile("mrs %0,tpidr_el0":"=r"(pointer));return pointer;}
uintptr_t thread_pointer_probe(uintptr_t magic){
    void **pointer=thread_pointer(),*offset=(void *)(2*sizeof(void *));
    x_cgo_inittls(&offset,pointer);
    if(offset!=(void *)(2*sizeof(void *))||!pointer[5])abort();
    pointer[2]=(void *)magic;
    pthread_key_t key;if(pthread_key_create(&key,NULL))abort();
    if(pthread_setspecific(key,(void *)(magic+1))||pthread_getspecific(key)!=(void *)(magic+1))abort();
    if(pointer[2]!=(void *)magic||pthread_key_delete(key))abort();
    return (uintptr_t)pointer;
}
uintptr_t thread_pointer_value(void){return (uintptr_t)thread_pointer()[2];}
uintptr_t thread_pointer_roundtrip(void *replacement){
    void *prior,*seen;
    __asm__ volatile("mrs %0,tpidr_el0\nmsr tpidr_el0,%2\nmrs %1,tpidr_el0\nmsr tpidr_el0,%0":"=&r"(prior),"=&r"(seen):"r"(replacement):"memory");
    return (uintptr_t)seen;
}
