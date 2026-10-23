#include <assert.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static void (*enter)(void);
static int *(*address)(void),*(*hidden)(void),*(*dependency)(void),*(*weak)(void),*(*legacy)(void);
static unsigned char *(*zero)(void);
static void *(*thread_pointer)(void);
static int (*increment)(int);
static void *(*symbol)(void *,const char *);
static void *guest;
static pthread_mutex_t lock=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed=PTHREAD_COND_INITIALIZER;
static int arrived,leave;
static pthread_key_t late_key;
static _Atomic unsigned late_callbacks;
static int *pointers[2];
extern int tls_registers(const uintptr_t *);
static void check_initial(void){
    enter();assert(thread_pointer());
    assert(*address()==37&&*hidden()==11&&*dependency()==83&&!weak());
    assert(address()==symbol(guest,"tls_initialized"));
    assert(address()==legacy());
    unsigned char *bytes=zero();assert(!((uintptr_t)bytes&63));
    for(unsigned n=0;n<73;n++)assert(bytes[n]==0);
}
static void late(void *opaque){
    unsigned index=(unsigned)(uintptr_t)opaque-1;
    assert(address()==pointers[index]&&*address()==47+(int)index&&*dependency()==90+(int)index);
    assert(address()==legacy());atomic_fetch_add(&late_callbacks,1);
}
static void *worker(void *opaque){
    unsigned index=(unsigned)(uintptr_t)opaque;check_initial();
    pointers[index]=address();assert(increment(10+(int)index)==47+(int)index);
    assert(!pthread_setspecific(late_key,(void *)(uintptr_t)(index+1)));
    *dependency()=90+(int)index;zero()[72]=(unsigned char)(index+1);
    pthread_mutex_lock(&lock);++arrived;pthread_cond_broadcast(&changed);
    while(!leave)pthread_cond_wait(&changed,&lock);
    pthread_mutex_unlock(&lock);
    assert(*address()==47+(int)index&&*dependency()==90+(int)index&&zero()[72]==index+1);
    return NULL;
}
int main(int argc,char **argv){
    assert(argc==4);void *core=dlopen(argv[1],RTLD_NOW|RTLD_GLOBAL);
    if(!core){fprintf(stderr,"%s\n",dlerror());return 2;}
    void *(*load)(const char *)=dlsym(core,"kl_load");symbol=dlsym(core,"kl_sym");
    const char *(*error)(void)=dlsym(core,"kl_error");
    void (*publish)(const char *,void *)=dlsym(core,"kl_register_image");
    enter=dlsym(core,"kl_thread_init");assert(load&&symbol&&error&&publish&&enter);
    int (*configure)(const char *)=dlsym(core,"klj_process_ids_configure");
    assert(configure&&configure(getenv("KL_ANDROID_ID_DIRECTORY"))>0);
    uintptr_t (*tls_register)(const void *,size_t,size_t,size_t,size_t)=dlsym(core,"klj_elf_tls_register");
    void (*tls_unregister)(uintptr_t)=dlsym(core,"klj_elf_tls_unregister");
    void *resolver=dlsym(core,"klj_elf_tls_resolver");assert(tls_register&&tls_unregister&&resolver);
    enter();int initial=19;
    uintptr_t module=tls_register(&initial,sizeof initial,32,64,0);assert(module);
    uintptr_t index[]={module,0},descriptor[]={(uintptr_t)resolver,(uintptr_t)index};
    assert(!tls_registers(descriptor));tls_unregister(module);
    void *provider=load(argv[2]);if(!provider){fprintf(stderr,"%s\n",error());return 3;}
    publish("libtls-dependency.so",provider);
    guest=load(argv[3]);if(!guest){fprintf(stderr,"%s\n",error());return 4;}
    address=symbol(guest,"tls_address");hidden=symbol(guest,"tls_hidden_address");
    dependency=symbol(guest,"tls_dependency_address");weak=symbol(guest,"tls_weak_address");
    zero=symbol(guest,"tls_zero_address");increment=symbol(guest,"tls_increment");
    thread_pointer=symbol(guest,"tls_thread_pointer");
    legacy=symbol(guest,"tls_legacy_address");
    assert(address&&hidden&&dependency&&weak&&zero&&increment&&thread_pointer&&legacy);
    check_initial();int *main_pointer=address();assert(increment(5)==42);zero()[0]=7;
    assert(!pthread_key_create(&late_key,late));
    pthread_t threads[2];for(unsigned n=0;n<2;n++)assert(!pthread_create(&threads[n],NULL,worker,(void *)(uintptr_t)n));
    pthread_mutex_lock(&lock);while(arrived<2)pthread_cond_wait(&changed,&lock);
    assert(pointers[0]!=pointers[1]&&pointers[0]!=main_pointer&&pointers[1]!=main_pointer);
    assert(*address()==42&&zero()[0]==7&&*dependency()==83);
    leave=1;pthread_cond_broadcast(&changed);pthread_mutex_unlock(&lock);
    for(unsigned n=0;n<2;n++)assert(!pthread_join(threads[n],NULL));
    assert(atomic_load(&late_callbacks)==2);
    /* The physical caller survives fork with the same TCB and TLS values. */
    pid_t child=fork();assert(child>=0);
    if(!child){enter();_exit(address()==main_pointer&&*address()==42&&zero()[0]==7?0:5);}
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    puts("PASS ELF TLS initialization, alignment, weak/external/hidden symbols, per-thread values and fork preserve the real Android TP");
}
