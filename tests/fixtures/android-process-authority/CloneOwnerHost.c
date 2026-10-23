#include <assert.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdlib.h>
#include "bridge.h"
static int(*reserve_id)(void);
static int64_t(*host_call)(uint32_t,uint64_t,uint64_t,KljArtCallback);
static _Atomic int reservation_error;
__attribute__((constructor))static void initialize(void){
 const char *source=getenv("ANDROID_THREAD_TEST_HOST");assert(source);
 void *owner=dlopen(source,RTLD_NOW|RTLD_LOCAL);assert(owner);
 reserve_id=dlsym(owner,"klj_thread_id_reserve");host_call=dlsym(owner,"maclauncher_art_host_call");assert(reserve_id&&host_call);
}
int klj_thread_id_reserve(void){
 int error=atomic_load(&reservation_error);if(error){errno=error;return -1;}
 return reserve_id();
}
int64_t maclauncher_art_host_call(uint32_t function,uint64_t address,uint64_t size,KljArtCallback callback){
 if(function>=0xff00&&function<=0xff02){
  if(address||size)return -22;
  atomic_store(&reservation_error,function==0xff00?EMFILE:function==0xff01?EACCES:0);return 0;
 }
 return host_call(function,address,size,callback);
}
