#include <assert.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static void (*enter)(void);
static uintptr_t (*probe)(uintptr_t),(*value)(void),(*roundtrip)(void *);
static uintptr_t (*x18_pointer)(void),(*x18_roundtrip)(void *);
static uintptr_t pointers[32];
static pthread_mutex_t lock=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t condition=PTHREAD_COND_INITIALIZER;
static unsigned ready;
static void *worker(void *argument){
    uintptr_t index=(uintptr_t)argument,magic=0x12340000+index;
    enter();pointers[index]=probe(magic);
    pthread_mutex_lock(&lock);ready++;pthread_cond_broadcast(&condition);
    while(ready<32)pthread_cond_wait(&condition,&lock);
    pthread_mutex_unlock(&lock);
    assert(value()==magic);
    uintptr_t local[11]={0};assert(roundtrip(local)==(uintptr_t)local&&value()==magic);
    assert(x18_pointer()==pointers[index]&&x18_roundtrip(local)==(uintptr_t)local&&value()==magic);
    return NULL;
}
int main(int argc,char **argv){
    assert(argc==4);void *runtime=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!runtime){puts(dlerror());return 2;}
    int (*configure)(const char *)=dlsym(runtime,"klj_process_ids_configure");assert(configure&&configure(argv[3])>0);
    void *(*lookup)(const char *)=dlsym(runtime,"kl_shim_lookup");assert(lookup);
    void *(*load)(const char *,int)=lookup("dlopen"),*(*symbol)(void *,const char *)=lookup("dlsym");
    int (*close_image)(void *)=lookup("dlclose");const char *(*error)(void)=lookup("dlerror");
    enter=dlsym(runtime,"kl_thread_init");assert(load&&symbol&&close_image&&error&&enter);
    void *libc=load("libc.so",2);assert(libc);
    int (*level)(void)=symbol(libc,"android_get_device_api_level");assert(level&&level()==36);assert(!close_image(libc));
    enter();
    void *image=load(argv[2],2);if(!image){puts(error());return 3;}
    probe=symbol(image,"thread_pointer_probe");value=symbol(image,"thread_pointer_value");roundtrip=symbol(image,"thread_pointer_roundtrip");assert(probe&&value&&roundtrip);
    x18_pointer=symbol(image,"thread_pointer_x18");x18_roundtrip=symbol(image,"thread_pointer_x18_roundtrip");assert(x18_pointer&&x18_roundtrip);
    uintptr_t native;__asm__ volatile("mrs %0,tpidrro_el0":"=r"(native));
    void *before[8];memcpy(before,(void *)native,sizeof before);
    uintptr_t base=probe(0x6789);assert(base&&base!=native&&value()==0x6789);
    assert(!memcmp(before,(void *)native,sizeof before));
    pthread_t threads[32];for(uintptr_t i=0;i<32;i++)assert(!pthread_create(threads+i,NULL,worker,(void *)i));
    for(unsigned i=0;i<32;i++)assert(!pthread_join(threads[i],NULL));
    for(unsigned i=0;i<32;i++){assert(pointers[i]!=base);for(unsigned j=0;j<i;j++)assert(pointers[i]!=pointers[j]);}
    assert(value()==0x6789);assert(!close_image(image));
    puts("PASS original Android cgo initialization, allocated guest TP, native TSD preservation, stack guards and32 isolated physical threads");
}
