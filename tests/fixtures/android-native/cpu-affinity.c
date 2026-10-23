#include <assert.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static long cpus;
static unsigned word;
long kl_cpu_count(void){return cpus;}
unsigned klj_library_word_bytes(void){return word;}
#include "cpu-affinity.inc"

static unsigned count(const unsigned char *mask,size_t size){unsigned n=0;for(size_t i=0;i<size;i++)n+=(unsigned)__builtin_popcount(mask[i]);return n;}
static void check(long expected,unsigned width){
 cpus=expected;word=width;unsigned char mask[8192];size_t bytes=((size_t)cpus+word*8-1)/(word*8)*word;
 memset(mask,0xa5,sizeof mask);errno=73;
 assert(klj_sched_getaffinity_kernel(0,sizeof mask,mask)==(int)bytes&&errno==73);
 assert(count(mask,bytes)==(unsigned)cpus);for(size_t i=bytes;i<sizeof mask;i++)assert(mask[i]==0xa5);
 memset(mask,0xa5,sizeof mask);assert(!klb_sched_getaffinity(0,sizeof mask,mask));
 assert(count(mask,sizeof mask)==(unsigned)cpus);for(size_t i=bytes;i<sizeof mask;i++)assert(mask[i]==0);
 memset(mask,0xa5,sizeof mask);assert(klj_sched_getaffinity_kernel(0,bytes-1,mask)==-1&&errno==EINVAL);assert(mask[0]==0xa5);
 assert(klj_sched_getaffinity_kernel(0,sizeof mask,NULL)==-1&&errno==EFAULT);
}
int main(int argc,char **argv){
 for(unsigned width=4;width<=8;width+=4)for(unsigned i=0;i<5;i++)check((long[]){1,12,64,65,1024}[i],width);
 if(argc>1){
  void *core=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!core){puts(dlerror());return 2;}
  void *(*lookup)(const char *)=dlsym(core,"kl_shim_lookup");long(*expected)(void)=dlsym(core,"kl_cpu_count");
  void(*width)(unsigned)=dlsym(core,"klj_set_library_elf_class");long(*raw)(long,long,long,long,long,long,long)=dlsym(core,"klb_syscall");assert(lookup&&expected&&width&&raw);
  int(*public)(int,size_t,void *)=lookup("sched_getaffinity"),(*kernel)(int,size_t,void *)=lookup("__sched_getaffinity");assert(public&&kernel);
  for(unsigned elf=1;elf<=2;elf++){
   width(elf);unsigned char mask[8192];memset(mask,0xa5,sizeof mask);int bytes=kernel(0,sizeof mask,mask);assert(bytes>0&&bytes%(elf==1?4:8)==0);
   assert(count(mask,(size_t)bytes)==(unsigned)expected());for(size_t i=(size_t)bytes;i<sizeof mask;i++)assert(mask[i]==0xa5);
   assert(!public(0,sizeof mask,mask)&&count(mask,sizeof mask)==(unsigned)expected());
   if(elf==2){memset(mask,0xa5,sizeof mask);assert(raw(123,0,sizeof mask,(long)(uintptr_t)mask,0,0,0)==bytes);assert(count(mask,(size_t)bytes)==(unsigned)expected());}
  }
  width(2);
 }
 puts("PASS shared LP32/LP64 CPU masks, libc/kernel results, partial bits, zero tail, errno and raw dispatcher");
}
