#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <elf.h>
#include <link.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#ifdef RELRO_LIBRARY
int writable_value = 17;
/* Enough relocation data to retain complete native read-only pages as well
 * as the final 4K RELRO page next to writable data. */
void *const relocated[8192] = { &writable_value };
int update_value(void) { return ++writable_value + (relocated[0] == &writable_value); }
#else
static void check(int yes, const char *why) { if (!yes) { fprintf(stderr,"FAIL %s: %s\n",why,dlerror()); exit(2); } }
static int protection(uintptr_t pointer) {
 FILE *maps=fopen("/proc/self/maps","r"); check(maps!=NULL,"maps");
 char line[2048],mode[5]; unsigned long lo,hi; int result=-1;
 while(fgets(line,sizeof(line),maps)) if(sscanf(line,"%lx-%lx %4s",&lo,&hi,mode)==3 && lo<=pointer && pointer<hi) {
  result=(mode[0]=='r'?1:0)|(mode[1]=='w'?2:0)|(mode[2]=='x'?4:0); break;
 }
 fclose(maps); return result;
}
static int phdr(struct dl_phdr_info *info,size_t size,void *context) {
 (void)size;
 if (!strstr(info->dlpi_name,"librelro.so")) return 0;
 size_t page=(size_t)sysconf(_SC_PAGESIZE); int *count=context;
 for(unsigned i=0;i<info->dlpi_phnum;i++) if(info->dlpi_phdr[i].p_type==PT_GNU_RELRO) {
  uintptr_t lo=info->dlpi_addr+info->dlpi_phdr[i].p_vaddr,hi=lo+info->dlpi_phdr[i].p_memsz;
  check(hi%page!=0,"fixture must share its final native page with data");
  for(uintptr_t at=(lo+page-1)&~(page-1);at+page<=hi;at+=page) { check(protection(at)==PROT_READ,"complete RELRO page read-only");++*count; }
 }
 return 0;
}
int main(int argc,char **argv) {
 check(argc>=2,"library argument");
 if(!strcmp(argv[1],"memory")) {
  size_t page=(size_t)sysconf(_SC_PAGESIZE);
  unsigned char *base=mmap(NULL,3*page,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  check(base!=MAP_FAILED,"anonymous BSS reservation");base[3*page-1]=37;
  check(mprotect(base,page,PROT_READ)==0,"split native region");
  check(mprotect(base,page+1,PROT_READ|PROT_EXEC)==0,"RX spans regions and rounds its final page");
  check(protection((uintptr_t)base)==(PROT_READ|PROT_EXEC),"first RX page");
  check(protection((uintptr_t)(base+page))==(PROT_READ|PROT_EXEC),"second RX page");
  check(protection((uintptr_t)(base+2*page))==(PROT_READ|PROT_WRITE)&&base[3*page-1]==37,"anonymous tail remains writable");
  check(munmap(base,3*page)==0,"release memory probe");
  for(int i=0;i<16;i++){errno=0;check(mprotect(NULL,page,PROT_READ|PROT_EXEC)==-1&&errno==ENOMEM,"unmapped RX keeps Linux ENOMEM");}
  puts("PASS anonymous BSS, clipped multi-region RX and unchanged Linux mprotect errors");return 0;
 }
 void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);check(library!=NULL,"original dlopen");
 if(argc>2) {
  int(*initialize)(void)=dlsym(library,"sqlite3_initialize");
  int(*open_db)(const char*,void**)=dlsym(library,"sqlite3_open");
  int(*close_db)(void*)=dlsym(library,"sqlite3_close");
  check(initialize&&open_db&&close_db,"original SQLite exports");
  check(initialize()==0,"original SQLite initialize writable globals");
  void *db=NULL;check(open_db(":memory:",&db)==0&&db,"original SQLite open");check(close_db(db)==0,"original SQLite close");
  puts("PASS original SQLite initialization and database lifetime");
 } else {
  int(*update)(void)=dlsym(library,"update_value");int *value=dlsym(library,"writable_value");
  check(update&&value,"exports");check(protection((uintptr_t)value)==(PROT_READ|PROT_WRITE),"data remains writable");
  check(update()==19&&*value==18,"writable store");int count=0;dl_iterate_phdr(phdr,&count);check(count>0,"retained complete RELRO pages");
  size_t page=(size_t)sysconf(_SC_PAGESIZE);void *base=(void*)((uintptr_t)value&~(page-1));
  check(mprotect(base,page,PROT_READ)==0,"ordinary application mprotect");check(protection((uintptr_t)value)==PROT_READ,"application read-only request preserved");
  check(mprotect(base,page,PROT_READ|PROT_WRITE)==0,"restore ordinary data mapping");check(update()==20,"restored data store");
  puts("PASS original loader RELRO, writable neighbor and application mprotect");
 }
 check(dlclose(library)==0,"dlclose");return 0;
}
#endif
