#include <assert.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include <initializer_list>
#include "kl_x18.h"

// The original public Bionic sizes; the build test also verifies these against
// the original header rather than borrowing Darwin's incompatible jmp_buf.
typedef long guest_jmp_buf[32];
typedef long guest_sigjmp_buf[33];
extern "C" {
int klj_jump_setjmp(guest_jmp_buf) __attribute__((returns_twice));
int klj_jump__setjmp(guest_jmp_buf) __attribute__((returns_twice));
int klj_jump_sigsetjmp(guest_sigjmp_buf,int) __attribute__((returns_twice));
[[noreturn]] void klj_jump_longjmp(guest_jmp_buf,int);
[[noreturn]] void klj_jump__longjmp(guest_jmp_buf,int);
[[noreturn]] void klj_jump_siglongjmp(guest_sigjmp_buf,int);
void* klj_nonlocal_jump_lookup(const char*);
int probe_jump_registers();
int kl_errno_to_linux(int error){return error;}
uint32_t klj_process_uid_from_host(uint32_t uid){return uid;}
int klb_sigaction(int,const void*,void*){abort();}
}

static void claim_guest_slot(){
  pthread_key_t keys[512];size_t count=0;
  do {assert(count<512);assert(pthread_key_create(&keys[count],nullptr)==0);} while(keys[count++]!=KLX_TSD_SLOT);
  while(--count)pthread_key_delete(keys[count-1]);
}

static void mask_tests(){
  sigset_t block,prior,current;sigemptyset(&block);sigaddset(&block,SIGUSR1);
  assert(pthread_sigmask(SIG_BLOCK,&block,&prior)==0);
  guest_sigjmp_buf saved;int value=klj_jump_sigsetjmp(saved,1);
  if(!value){pthread_sigmask(SIG_UNBLOCK,&block,nullptr);klj_jump_siglongjmp(saved,37);}
  assert(value==37);pthread_sigmask(SIG_SETMASK,nullptr,&current);assert(sigismember(&current,SIGUSR1));
  guest_jmp_buf plain;value=klj_jump__setjmp(plain);
  if(!value){pthread_sigmask(SIG_UNBLOCK,&block,nullptr);klj_jump__longjmp(plain,0);}
  assert(value==1);pthread_sigmask(SIG_SETMASK,nullptr,&current);assert(!sigismember(&current,SIGUSR1));
  pthread_sigmask(SIG_BLOCK,&block,nullptr);value=klj_jump_setjmp(plain);
  if(!value){pthread_sigmask(SIG_UNBLOCK,&block,nullptr);klj_jump_longjmp(plain,-7);}
  assert(value==-7);pthread_sigmask(SIG_SETMASK,nullptr,&current);assert(sigismember(&current,SIGUSR1));
  pthread_sigmask(SIG_SETMASK,&prior,nullptr);
}

static void* thread_probe(void* opaque){
  uintptr_t base=(uintptr_t)opaque;
  for(int n=0;n<1000;n++){
    pthread_setspecific(KLX_TSD_SLOT,(void*)(base|0x123));
    guest_sigjmp_buf outer,inner;
    int value=klj_jump_sigsetjmp(outer,0);
    if(!value){
      pthread_setspecific(KLX_TSD_SLOT,(void*)(base|0x345));
      if(!klj_jump_sigsetjmp(inner,0))klj_jump_siglongjmp(inner,4);
      assert((uintptr_t)pthread_getspecific(KLX_TSD_SLOT)==(base|0x345));
      pthread_setspecific(KLX_TSD_SLOT,(void*)(base|0x678));
      klj_jump_siglongjmp(outer,9);
    }
    assert(value==9);assert((uintptr_t)pthread_getspecific(KLX_TSD_SLOT)==(base|0x123));
  }
  pthread_setspecific(KLX_TSD_SLOT,nullptr);return nullptr;
}

static void corruption_test(bool cookie){
  pid_t child=fork();assert(child>=0);
  if(!child){
    guest_sigjmp_buf saved;
    if(!klj_jump_sigsetjmp(saved,0)){
      if(cookie){saved[0]^=2;for(int i=2;i<16;i++)saved[i]^=2;saved[24]^=2;}else saved[24]^=2;
      klj_jump_siglongjmp(saved,1);
    }
    _exit(2);
  }
  int status=0;assert(waitpid(child,&status,0)==child);assert(WIFSIGNALED(status)&&WTERMSIG(status)==SIGABRT);
}

int main(){
  claim_guest_slot();
  for(const char* name: {"setjmp","_setjmp","sigsetjmp","siglongjmp","longjmp","_longjmp"})assert(klj_nonlocal_jump_lookup(name));
  assert(!klj_nonlocal_jump_lookup("unrelated"));
  mask_tests();assert(probe_jump_registers()==0);
  pthread_t workers[4];for(uintptr_t n=0;n<4;n++)assert(!pthread_create(&workers[n],nullptr,thread_probe,(void*)((n+1)<<16)));
  for(auto worker:workers)pthread_join(worker,nullptr);
  corruption_test(false);corruption_test(true);
  puts("PASS Bionic jump family: registers, signal masks, zero return, nested thread buffers, guest x18, integrity");
}
