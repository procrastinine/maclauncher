#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <unistd.h>
#include <dlfcn.h>
extern int kl_errno_to_linux(int);
static const char *mapped;
static const char *kl_guest_path(const char *path,char *buffer,size_t size){(void)buffer;(void)size;return !strcmp(path,"/android/statfs-probe")?mapped:path;}
#include "statfs-unit.c"
#include "statfs-layout.h"
static int (*path_stat)(const char *,void *)=klb_statfs;
static int (*descriptor_stat)(int,void *)=klb_fstatfs;
static int (*advice_call)(int,int64_t,int64_t,int)=klb_posix_fadvise;
#define klb_statfs path_stat
#define klb_fstatfs descriptor_stat
#define klb_posix_fadvise advice_call
int main(int argc,char **argv){
 assert(argc==2||argc==3);mapped=argv[1];
 if(argc==3){
   void *library=dlopen(argv[2],RTLD_NOW|RTLD_LOCAL);assert(library);void *(*lookup)(const char *)=dlsym(library,"kl_shim_lookup");assert(lookup);
   path_stat=lookup("statfs");descriptor_stat=lookup("fstatfs");advice_call=lookup("posix_fadvise");assert(path_stat&&descriptor_stat&&advice_call);
   assert(lookup("statfs64")==path_stat&&lookup("fstatfs64")==descriptor_stat&&lookup("posix_fadvise64")==advice_call);
   assert(lookup("statvfs64")==lookup("statvfs")&&lookup("statvfs")&&lookup("fstatvfs64")==lookup("fstatvfs")&&lookup("fstatvfs"));
 }
 struct {uint64_t before;bionic_statfs value;uint64_t after;} output={.before=0x12345678,.after=0x87654321};
 int fd=open(mapped,O_RDONLY);assert(fd>=0);struct statfs native;assert(!fstatfs(fd,&native));
 errno=E2BIG;assert(!klb_statfs(argc==3?mapped:"/android/statfs-probe",&output.value)&&errno==E2BIG);
 assert(output.value.f_bsize==(uint64_t)native.f_bsize&&output.value.f_frsize==(uint64_t)native.f_bsize);
 assert(output.value.f_blocks==native.f_blocks&&output.value.f_namelen==255);
 assert(!klb_fstatfs(fd,&output.value)&&output.value.f_fsid[0]==native.f_fsid.val[0]&&output.value.f_fsid[1]==native.f_fsid.val[1]);
 assert(output.before==0x12345678&&output.after==0x87654321);for(unsigned i=0;i<4;i++)assert(!output.value.f_spare[i]);
 assert(klb_fstatfs(fd,NULL)==-1&&errno==EFAULT);assert(!close(fd));
 bionic_statfs unchanged;memset(&unchanged,0xa5,sizeof unchanged);output.value=unchanged;
 assert(klb_fstatfs(fd,&output.value)==-1&&errno==EBADF&&!memcmp(&unchanged,&output.value,sizeof unchanged));
 assert(klb_statfs("/android/does-not-exist",&output.value)==-1&&errno==ENOENT);
 char filename[PATH_MAX];snprintf(filename,sizeof filename,"%s/advice",mapped);fd=open(filename,O_CREAT|O_RDWR,0600);assert(fd>=0);assert(write(fd,"advice",6)==6);off_t position=lseek(fd,0,SEEK_CUR);
 for(int advice=0;advice<=5;advice++){errno=E2BIG;assert(!klb_posix_fadvise(fd,0,6,advice)&&errno==E2BIG);assert(lseek(fd,0,SEEK_CUR)==position);}
 errno=E2BIG;assert(klb_posix_fadvise(fd,-1,6,0)==EINVAL&&errno==E2BIG);assert(klb_posix_fadvise(fd,0,-1,0)==EINVAL);assert(klb_posix_fadvise(fd,0,0,6)==EINVAL);assert(klb_posix_fadvise(fd,INT64_MAX,2,0)==EINVAL);
 assert(!close(fd));assert(klb_posix_fadvise(fd,0,0,0)==EBADF);int pipefd[2];assert(!pipe(pipefd));assert(klb_posix_fadvise(pipefd[0],0,0,0)==ESPIPE);close(pipefd[0]);close(pipefd[1]);
 puts("PASS original filesystem-stat records, descriptor lifetime and advisory errors");
}
