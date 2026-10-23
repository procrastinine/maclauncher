#include <errno.h>
#include <pthread.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

// The real shim supplies these two existing Klepton functions. Intercept the
// fatal boundary here to inspect an untouched destination without aborting a
// host process; production continues through Klepton's original fatal handler.
static int kl_errno_to_linux(int e){return e==EAGAIN?11:e==ENOTSUP?95:e;}
static jmp_buf fatal;
static const char *fatal_message;
__attribute__((noreturn)) static void die(const char *message){fatal_message=message;longjmp(fatal,1);}
#include "native-imports.h"

static unsigned checks;
#define CHECK(condition) do {++checks;if(!(condition)){fprintf(stderr,"FAIL line %d: %s\n",__LINE__,#condition);exit(1);}}while(0)
static int (*barrier_init)(void*,const void*,unsigned);
static int (*barrier_wait)(void*);
static int (*barrier_destroy)(void*);
static unsigned char storage[48];
static void *barrier;
static int values[4];
static atomic_uint failures,serial;
static void *worker(void *argument){
    const unsigned id=(unsigned)(uintptr_t)argument;
    for(unsigned round=1;round<=1000;++round){
        values[id]=(int)round;
        int result=barrier_wait(barrier);
        if(result==-1)atomic_fetch_add(&serial,1);else if(result)atomic_fetch_add(&failures,1);
        for(unsigned i=0;i<4;++i)if(values[i]!=(int)round)atomic_fetch_add(&failures,1);
        result=barrier_wait(barrier);
        if(result==-1)atomic_fetch_add(&serial,1);else if(result)atomic_fetch_add(&failures,1);
    }
    return NULL;
}
static void *one_waiter(void *argument){return (void*)(intptr_t)barrier_wait(argument);}
int main(void){
    barrier_init=klj_native_import_lookup("pthread_barrier_init");barrier_wait=klj_native_import_lookup("pthread_barrier_wait");barrier_destroy=klj_native_import_lookup("pthread_barrier_destroy");
    size_t (*copy)(char*,const char*,size_t,size_t)=klj_native_import_lookup("__strlcpy_chk");
    size_t (*append)(char*,const char*,size_t,size_t)=klj_native_import_lookup("__strlcat_chk");
    CHECK(barrier_init&&barrier_wait&&barrier_destroy&&copy&&append);CHECK(!klj_native_import_lookup("unknown"));
    // Deliberately four-byte, not eight-byte aligned, as permitted by Bionic.
    barrier=(void*)((((uintptr_t)storage+7)&~(uintptr_t)7)+4);memset(storage,0xa5,sizeof(storage));
    CHECK(barrier_init(barrier,NULL,0)==22);CHECK(barrier_wait(barrier)==22);CHECK(barrier_destroy(barrier)==22);
    unsigned attributes;CHECK(klj_barrierattr_init(&attributes)==0);CHECK(klj_barrierattr_setpshared(&attributes,1)==0);
    int shared=-1;CHECK(klj_barrierattr_getpshared(&attributes,&shared)==0&&shared==1);CHECK(barrier_init(barrier,&attributes,2)==95);
    CHECK(klj_barrierattr_setpshared(&attributes,0)==0);CHECK(klj_barrierattr_setpshared(&attributes,2)==22);
    CHECK(barrier_init(barrier,&attributes,1)==0);for(unsigned i=0;i<100;++i)CHECK(barrier_wait(barrier)==-1);CHECK(barrier_destroy(barrier)==0);
    CHECK(barrier_init(barrier,NULL,4)==0);CHECK(barrier_init(barrier,NULL,4)==16);
    pthread_t threads[4];for(unsigned i=0;i<4;++i)CHECK(pthread_create(&threads[i],NULL,worker,(void*)(uintptr_t)i)==0);
    for(unsigned i=0;i<4;++i)CHECK(pthread_join(threads[i],NULL)==0);
    CHECK(!atomic_load(&failures));CHECK(atomic_load(&serial)==2000);CHECK(barrier_destroy(barrier)==0);
    CHECK(barrier_init(barrier,NULL,2)==0);CHECK(pthread_create(&threads[0],NULL,one_waiter,barrier)==0);
    bool waiting=false;for(unsigned i=0;i<1000&&!waiting;++i){
        pthread_mutex_lock(&klj_barrier_registry_lock);waiting=(*klj_barrier_entry(barrier))->users!=0;pthread_mutex_unlock(&klj_barrier_registry_lock);
        if(!waiting){struct timespec delay={0,1000000};nanosleep(&delay,NULL);}
    }
    CHECK(waiting);CHECK(barrier_destroy(barrier)==16);
    int first=barrier_wait(barrier);void *other;CHECK(pthread_join(threads[0],&other)==0);CHECK((first==-1&&(intptr_t)other==0)||(first==0&&(intptr_t)other==-1));CHECK(barrier_destroy(barrier)==0);
    for(unsigned i=0;i<1000;++i){CHECK(barrier_init(barrier,NULL,1)==0);CHECK(barrier_wait(barrier)==-1);CHECK(barrier_destroy(barrier)==0);}
    CHECK(klj_barrier_count==0);for(unsigned i=0;i<sizeof(storage);++i)CHECK(storage[i]==0xa5);
    char destination[8];memset(destination,0x55,sizeof(destination));CHECK(copy(destination,"abcdef",4,sizeof(destination))==6);CHECK(!memcmp(destination,"abc\0",4));CHECK((unsigned char)destination[4]==0x55);
    CHECK(copy(NULL,"abcdef",0,0)==6);CHECK(copy(destination,"abc",sizeof(destination),(size_t)-1)==3);
    CHECK(append(destination,"defghi",sizeof(destination),sizeof(destination))==9);CHECK(!strcmp(destination,"abcdefg"));
    memset(destination,'x',sizeof(destination));CHECK(append(destination,"abc",sizeof(destination),sizeof(destination))==11);for(unsigned i=0;i<sizeof(destination);++i)CHECK(destination[i]=='x');
    CHECK(append(NULL,"abc",0,0)==3);
    for(unsigned mode=0;mode<2;++mode){
        memset(destination,0x55,sizeof(destination));fatal_message=NULL;
        if(setjmp(fatal)==0){(mode?append:copy)(destination,"a",sizeof(destination)+1,sizeof(destination));CHECK(0);}
        CHECK(fatal_message&&strstr(fatal_message,mode?"__strlcat_chk":"__strlcpy_chk"));
        for(unsigned i=0;i<sizeof(destination);++i)CHECK((unsigned char)destination[i]==0x55);
    }
    printf("PASS %u checks, 8000 waits with synchronized memory, 2000 serial elections, bounded lifecycle and FORTIFY rejection before writes\n",checks);return 0;
}
