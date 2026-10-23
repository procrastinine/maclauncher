#include <dlfcn.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <libkern/OSCacheControl.h>
#include "inline-syscall.h"
#define main ownership_main
#include "signal-ownership.c"
#undef main

static void *(*original_lookup)(const char *);
#ifndef ANDROID_SIGNAL_MEMORY_COMPONENT
uint64_t klj_inline_call_slot_offset;
#endif
static int (*classify)(const void *,size_t,size_t,const klx_code_context *);
void *kl_shim_lookup(const char *name){void *result=klj_signal_lookup(name);return result?result:original_lookup(name);}
#include ANDROID_SYSCALL_SOURCE
int kl_x18_is_data_context(const void *code,size_t size,size_t at,const klx_code_context *context){return classify(code,size,at,context);}
static volatile sig_atomic_t received;
static void raw_handler(int signal){received=signal;}
static void unused_restorer(void){}
typedef struct {void *handler;uint64_t flags;void *restorer;uint64_t mask;} kernel_sigaction;
int main(int argc,char **argv){
 assert(argc==3);void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);assert(library);
 int (*configure)(const char *)=dlsym(library,"klj_process_ids_configure");assert(configure&&configure(argv[2])>0);
 #ifdef ANDROID_SIGNAL_MEMORY_COMPONENT
 assert(!klj_executable_thread_enter());
 #else
 int (*native_stack)(void)=dlsym(library,"klj_executable_thread_enter");assert(native_stack&&!native_stack());
 const uint64_t *slot=dlsym(library,"klj_inline_call_slot_offset");assert(slot);klj_inline_call_slot_offset=*slot;
 #endif
 // Native SVC execution has its own stack before Android TP/handler setup.
 original_lookup=dlsym(library,"kl_shim_lookup");classify=dlsym(library,"kl_x18_is_data_context");assert(original_lookup&&classify);
 // Execute original Linux syscall registers through the actual shared SVC
 // veneer and generated Bionic/UAPI dispatcher, not an alternate syscall stub.
 size_t page=(size_t)getpagesize(),used=0;
 void *code=mmap(NULL,page*2,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(code!=MAP_FAILED);
 uint32_t instructions[]={0xd28010c8u,0xd4000001u,0xd65f03c0u};
 memcpy(code,instructions,sizeof instructions);assert(!klj_inline_syscall_patch(code,sizeof instructions,(char *)code+page,page,&used));
 assert(!mprotect(code,page,PROT_READ|PROT_EXEC));sys_icache_invalidate(code,page);
 long (*raw)(int,const kernel_sigaction *,kernel_sigaction *,size_t)=code;
 struct {uint64_t before;kernel_sigaction action;uint64_t after;} old={.before=0x1122334455667788,.after=0x8877665544332211};
 kernel_sigaction action={.handler=raw_handler,.flags=0x10000000,.restorer=unused_restorer,.mask=UINT64_C(1)<<11};
 errno=E2BIG;assert(!raw(10,&action,&old.action,8)&&errno==E2BIG);
 assert(old.before==0x1122334455667788&&old.after==0x8877665544332211);
 kernel_sigaction queried={0};assert(!raw(10,NULL,&queried,8));
 assert(queried.handler==raw_handler&&queried.flags==action.flags&&queried.mask==action.mask&&queried.restorer==unused_restorer);
 struct sigaction native={0};assert(!sigaction(SIGUSR1,NULL,&native));assert(native.sa_flags&SA_RESTART);assert(sigismember(&native.sa_mask,SIGUSR2)==1);
 assert(!kill(getpid(),SIGUSR1)&&received==10);
 kernel_sigaction unchanged;memset(&unchanged,0xa5,sizeof unchanged);queried=unchanged;
 errno=E2BIG;assert(raw(10,&action,&queried,4)==-22&&errno==E2BIG&&!memcmp(&queried,&unchanged,sizeof queried));
 assert(raw(65,&action,&queried,8)==-22&&!memcmp(&queried,&unchanged,sizeof queried));
 assert(!raw(10,&old.action,NULL,8));
 // Original Go c-shared libpreinit queries every Linux realtime signal before
 // a g exists. Registration cannot depend on a Darwin equivalent or VM TLS.
 for(int signal=32;signal<=64;signal++){
  kernel_sigaction before={0},after={0};assert(!raw(signal,NULL,&before,8));
  kernel_sigaction realtime={.handler=raw_handler,.flags=UINT64_C(0x1234000018000004),.restorer=unused_restorer,.mask=UINT64_MAX};
  errno=E2BIG;assert(!raw(signal,&realtime,&after,8)&&errno==E2BIG&&!memcmp(&before,&after,sizeof before));
  assert(!raw(signal,NULL,&after,8));
  const uint64_t allowed=UINT64_MAX&~((UINT64_C(1)<<8)|(UINT64_C(1)<<18));
  assert(after.handler==raw_handler&&after.flags==realtime.flags&&after.restorer==unused_restorer&&after.mask==allowed);
  bionic_sigaction public={0};assert(!klb_sigaction(signal,NULL,&public));
  assert(public.handler==raw_handler&&(uint32_t)public.flags==(uint32_t)realtime.flags&&public.mask==allowed&&public.restorer==unused_restorer);
  public.handler=(void *)SIG_IGN;assert(!klb_sigaction(signal,&public,NULL));assert(!raw(signal,NULL,&after,8)&&after.handler==(void *)SIG_IGN);
  assert(!raw(signal,&before,NULL,8));assert(!raw(signal,NULL,&after,8)&&!memcmp(&before,&after,sizeof before));
 }
 assert(!munmap(code,page*2));
 puts("PASS original raw rt_sigaction ABI, actual signal delivery, shared handler state, guards and Linux errors");
 puts("PASS original realtime dispositions32..64 use the same AIM owner before guest thread initialization");
}
