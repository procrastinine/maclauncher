#include <dlfcn.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include <cassert>
#include <cerrno>
#include <cstdio>
#include <initializer_list>

int main(int argc,char**argv){
 assert(argc==2);void* library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){fprintf(stderr,"%s\n",dlerror());return 2;}
 auto create=(int(*)(const char*,size_t))dlsym(library,"ashmem_create_region");
 auto protect=(int(*)(int,int))dlsym(library,"ashmem_set_prot_region");
 auto map=(void*(*)(void*,size_t,int,int,int,off_t))dlsym(library,"klj_ashmem_mmap");
 auto closefd=(int(*)(int))dlsym(library,"klj_pollable_close");assert(create&&protect&&map&&closefd);
 const size_t size=(size_t)getpagesize();
 int nativeMappings=0,nativeFailures=0;
 for(int mask=0;mask<8;mask++){
  int fd=create("protection matrix",size);assert(fd>=0&&!protect(fd,mask));
  for(int invalid:{8,-1}){errno=0;assert(protect(fd,invalid)<0&&errno==EINVAL);errno=0;assert(map(nullptr,size,invalid,MAP_SHARED,fd,0)==MAP_FAILED&&errno==EINVAL);}
  for(int requested=0;requested<8;requested++){
   errno=0;void* control=mmap(nullptr,size,requested,MAP_SHARED,fd,0);int nativeError=errno;
   errno=0;void* memory=map(nullptr,size,requested,MAP_SHARED,fd,0);
   if(requested&~mask){assert(memory==MAP_FAILED&&errno==EPERM);if(control!=MAP_FAILED)assert(!munmap(control,size));continue;}
   if(control==MAP_FAILED){assert(memory==MAP_FAILED&&errno==nativeError);nativeFailures++;continue;}
   assert(!munmap(control,size));nativeMappings++;
   if(memory==MAP_FAILED){fprintf(stderr,"mask=%d requested=%d errno=%d\n",mask,requested,errno);return 3;}
   if(!(mask&PROT_WRITE)){errno=0;assert(mprotect(memory,size,PROT_READ|PROT_WRITE)<0&&errno==EACCES);}
   assert(!munmap(memory,size));
  }
  assert((fcntl(fd,F_GETFL)&O_ACCMODE)==((mask&PROT_WRITE)?O_RDWR:O_RDONLY));assert(!closefd(fd));
  for(int next=0;next<8;next++){
   int region=create("monotonic matrix",size);assert(region>=0&&!protect(region,mask));errno=0;int result=protect(region,next);
   if(next&~mask)assert(result<0&&errno==EINVAL);else assert(!result);assert(!closefd(region));
  }
 }
 int fd=create("retained writable map",size);assert(fd>=0);auto* memory=(int*)map(nullptr,size,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);assert(memory!=MAP_FAILED);*memory=7;
 assert(!protect(fd,PROT_NONE));*memory=11;assert(*memory==11);errno=0;assert(map(nullptr,size,PROT_READ,MAP_SHARED,fd,0)==MAP_FAILED&&errno==EPERM);assert(!munmap(memory,size)&&!closefd(fd));
 printf("PASS native mmap controls accepted=%d rejected=%d\n",nativeMappings,nativeFailures);
 puts("PASS all eight native ashmem protection masks, mmap authority, native write sealing, monotonic transitions, invalid bits and existing writable mappings");return 0;
}
