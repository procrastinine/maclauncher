#include <assert.h>
#include <elf.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static const uintptr_t arena_top=UINT64_C(0x80000000000);
static const size_t stack_size=8<<20;
static int guard_present;
static void maps(const char *name){
 FILE *file=fopen("/proc/self/maps","r");assert(file);char *line=NULL;size_t size=0;
 printf("MAPS_%s\n",name);
 while(getline(&line,&size,file)>=0){
  unsigned long long lo,hi;char protection[5];
  if(sscanf(line,"%llx-%llx %4s",&lo,&hi,protection)==3&&
     lo<=arena_top-stack_size&&hi>arena_top-stack_size&&
     !strncmp(protection,"---",3))guard_present=1;
  fputs(line,stdout);
 }
 free(line);assert(!fclose(file));printf("END_MAPS_%s\n",name);
}
int main(int argc,char **argv){
 volatile int local=1;uintptr_t stack=(uintptr_t)&local;
 const unsigned long page=getauxval(AT_PAGESZ),vdso=getauxval(AT_SYSINFO_EHDR);
 assert(page==(unsigned long)sysconf(_SC_PAGESIZE)&&page>0);
 assert(vdso&&!memcmp((void *)vdso,ELFMAG,SELFMAG));
 assert(getauxval(AT_PHDR)&&getauxval(AT_PHNUM));
 if(argc>1&&!strcmp(argv[1],"--child")){
  printf("CHILD_STACK %llx\n",(unsigned long long)stack);
  puts("PASS original Bionic fork/exec stack and auxv");return 0;
 }
 printf("STACK %llx VDSO %lx PAGE %lu\n",(unsigned long long)stack,vdso,page);
 // Retire one ordinary mapping and create two later mappings. The original
 // Android 10 merger fails if its last old record disappears in this update.
 void *retired=mmap((void *)(arena_top/4),page,PROT_READ,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
 assert(retired!=MAP_FAILED);
 maps("BEFORE");
 assert(!munmap(retired,page));
 // A valid explicit Linux mmap hint, within the existing guest address space
 // and above ordinary first-fit mappings. No MAP_FIXED replacement is used.
 void *first=mmap((void *)(arena_top/2),page,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
 assert(first!=MAP_FAILED);*(volatile unsigned char *)first=0x5a;
 void *second=mmap((char *)first+2*page,page,PROT_READ,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
 assert(second!=MAP_FAILED);maps("AFTER");
 assert(*(volatile unsigned char *)first==0x5a);printf("GUARD %d\n",guard_present);
 assert(!fflush(stdout));
 pid_t child=fork();assert(child>=0);
 if(!child){execl("/data/local/tmp/stack-layout","stack-layout","--child",(char *)NULL);_exit(111);}
 int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
 assert(!munmap(first,page));assert(!munmap(second,page));
 puts("PASS original Bionic initial stack, mappings, auxv and child retirement");return 0;
}
