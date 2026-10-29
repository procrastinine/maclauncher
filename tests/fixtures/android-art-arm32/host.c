#include "arm32-bridge.h"
#ifdef ANDROID_IDENTITY_PROOF
#include "process-ids.h"
#include <stdatomic.h>
#include <stdio.h>
#include <unistd.h>
#endif
#ifdef ANDROID_PACKAGED_HOST
#include <assert.h>
#include <dlfcn.h>
#include <pthread.h>
static pthread_once_t owner_once=PTHREAD_ONCE_INIT;
static int64_t (*owner_call)(uint32_t,uint64_t,uint64_t,KljArtCallback);
static void load_owner(void){
 void *owner=dlopen(ANDROID_PACKAGED_HOST,RTLD_NOW|RTLD_LOCAL);assert(owner);
 owner_call=dlsym(owner,"maclauncher_art_host_call");assert(owner_call);
}
#endif
__attribute__((visibility("default")))
int64_t maclauncher_art_host_call(uint32_t function,uint64_t address,uint64_t size,KljArtCallback callback){
#ifdef ANDROID_IDENTITY_PROOF
 static atomic_bool observed;
 if(!atomic_exchange(&observed,1))fprintf(stderr,"SHARED_IDENTITY logical=%d physical=%d\n",klj_process_id(),getpid());
#endif
#ifdef ANDROID_PACKAGED_HOST
 assert(!pthread_once(&owner_once,load_owner));
 return owner_call(function,address,size,callback);
#else
 return function==9?maclauncher_art_arm32(address,size,callback):-38;
#endif
}
