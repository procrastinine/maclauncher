#include "futex-diagnostics.h"
#include "native-sampling.h"
#include <assert.h>
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <sys/mman.h>
#include <unistd.h>

typedef long (*Futex)(int32_t*,int,uint32_t,const struct timespec*,int32_t*,uint32_t);
typedef int (*Snapshot)(KljFutexWaitState*,uint32_t,uint32_t*,uint32_t*);
static Futex futex;
static Snapshot snapshot;
static int32_t *words;
static int64_t now(void){struct timespec value;assert(!clock_gettime(CLOCK_UPTIME_RAW,&value));return (int64_t)value.tv_sec*1000000000+value.tv_nsec;}
static void *waiter(void *argument){
    uintptr_t index=(uintptr_t)argument;
    assert(!pthread_setname_np(index?"futex-observer-bitset":"futex-observer-plain"));
    struct timespec deadline;assert(!clock_gettime(CLOCK_UPTIME_RAW,&deadline));deadline.tv_sec+=5;
    assert(!futex(&words[index],index?137:128,33,index?&deadline:NULL,NULL,index?8:0));
    return NULL;
}
static void await_count(unsigned wanted){
    const int64_t end=now()+3000000000LL;
    for(;;){KljFutexWaitState states[8];uint32_t count=0,more=0;int result=snapshot(states,8,&count,&more);
        if(!result&&count==wanted)return;assert(result==0||result==EBUSY);assert(now()<end);sched_yield();}
}
static void capture(void){size_t size=0;char *json=test_native_snapshot(1,NULL,NULL,NULL,&size);assert(json);fwrite(json,1,size,stdout);putchar('\n');free(json);}
int main(int argc,char **argv){
    size_t page=(size_t)sysconf(_SC_PAGESIZE);words=mmap(NULL,page,PROT_READ|PROT_WRITE,MAP_ANON|MAP_PRIVATE,-1,0);assert(words!=MAP_FAILED);
    for(unsigned i=0;i<3;i++)words[i]=33;
    assert(argc==2);void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);assert(library);
    futex=(Futex)dlsym(library,"klj_futex");snapshot=(Snapshot)dlsym(library,"klj_futex_snapshot");
    void(*metadataLock)(int)=(void(*)(int))dlsym(library,"fixture_futex_metadata_lock");assert(futex&&snapshot&&metadataLock);
    pthread_t threads[2];for(uintptr_t i=0;i<2;i++)assert(!pthread_create(&threads[i],NULL,waiter,(void*)i));
    await_count(2);KljFutexWaitState states[8];uint32_t count=0,more=0;assert(!snapshot(states,8,&count,&more)&&count==2&&!more);
    for(unsigned i=0;i<count;i++){
        unsigned index=states[i].address==(uintptr_t)&words[1];
        assert(states[i].address==(uintptr_t)&words[index]&&states[i].initialAddress==states[i].address);
        assert(states[i].threadHandle==(uintptr_t)threads[index]);
        assert(states[i].expected==33&&states[i].operation==(index?137u:128u));
        assert(states[i].mask==(index?8u:UINT32_MAX));assert(states[i].hasTimeout==index);
        assert(states[i].parker!=states[i].address);
    }
    assert(!mprotect(words,page,PROT_NONE));capture();assert(!snapshot(states,1,&count,&more)&&count==1&&more);
    assert(!mprotect(words,page,PROT_READ|PROT_WRITE));
    metadataLock(1);assert(snapshot(states,8,&count,&more)==EBUSY&&count==0);capture();metadataLock(0);
    assert(futex(&words[0],131,0,(const struct timespec*)(uintptr_t)1,&words[2],0)==1);
    assert(!snapshot(states,8,&count,&more)&&count==2);
    unsigned requeued=0;for(unsigned i=0;i<count;i++)if(states[i].address==(uintptr_t)&words[2]){assert(states[i].initialAddress==(uintptr_t)&words[0]);assert(states[i].expected==33);requeued++;}assert(requeued==1);
    capture();assert(futex(&words[2],129,1,NULL,NULL,0)==1);assert(futex(&words[1],138,1,NULL,NULL,8)==1);
    for(unsigned i=0;i<2;i++)assert(!pthread_join(threads[i],NULL));await_count(0);capture();
    dlclose(library);capture();assert(!munmap(words,page));
    puts("PASS bounded original futex metadata, local supplier discovery, busy reader, requeue and retirement");
}
