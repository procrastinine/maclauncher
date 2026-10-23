#include <assert.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
extern void *kl_shim_lookup(const char *);
#define kl_upstream_shim_lookup kl_shim_lookup
#include "native-file-imports.h"
static int descriptor;
static void *reserve(void *unused){(void)unused;for(int i=0;i<20;i++)assert(!klj_file_allocate(descriptor,1,0,262144));return NULL;}
static struct stat state(int fd){struct stat info;assert(!fstat(fd,&info));return info;}
int main(int argc,char **argv){
    assert(argc==2);char file[4096];assert(snprintf(file,sizeof(file),"%s/allocation",argv[1])>0);
    int fd=open(file,O_CREAT|O_EXCL|O_RDWR,0600);assert(fd>=0);descriptor=fd;
    const char marker[]="original bytes";assert(pwrite(fd,marker,sizeof(marker),0)==sizeof(marker));
    assert(lseek(fd,7,SEEK_SET)==7);
    int (*posix_allocate)(int,off_t,off_t)=klj_native_file_lookup("posix_fallocate64");
    int (*allocate)(int,int,off_t,off_t)=klj_native_file_lookup("fallocate64");
    errno=ERANGE;assert(posix_allocate(fd,4096,65536)==0&&errno==ERANGE);
    assert(state(fd).st_size==69632&&lseek(fd,0,SEEK_CUR)==7);
    char bytes[sizeof(marker)];assert(pread(fd,bytes,sizeof(bytes),0)==sizeof(bytes)&&!memcmp(bytes,marker,sizeof(bytes)));
    blkcnt_t first=state(fd).st_blocks;for(int i=0;i<20;i++)assert(!posix_allocate(fd,4096,65536));
    assert(state(fd).st_blocks==first);
    assert(!allocate(fd,1,0,262144)&&state(fd).st_size==69632);
    first=state(fd).st_blocks;pthread_t workers[8];for(int i=0;i<8;i++)assert(!pthread_create(workers+i,NULL,reserve,NULL));for(int i=0;i<8;i++)assert(!pthread_join(workers[i],NULL));
    assert(state(fd).st_blocks==first&&state(fd).st_size==69632);
    pid_t child=fork();assert(child>=0);if(!child)_exit(allocate(fd,1,0,262144)?1:0);
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    assert(!allocate(fd,16,1,7));assert(pread(fd,bytes,sizeof(bytes),0)==sizeof(bytes));
    assert(bytes[0]==marker[0]&&bytes[8]==marker[8]);for(int i=1;i<8;i++)assert(!bytes[i]);
    assert(!allocate(fd,3,0,4096));assert(pread(fd,bytes,sizeof(bytes),0)==sizeof(bytes));for(size_t i=0;i<sizeof(bytes);i++)assert(!bytes[i]);
    assert(lseek(fd,0,SEEK_CUR)==7);
    int readonly=open(file,O_RDONLY);assert(readonly>=0);errno=ERANGE;
    assert(posix_allocate(readonly,0,4096)==9&&errno==ERANGE);assert(posix_allocate(-1,0,4096)==9&&errno==ERANGE);
    assert(posix_allocate(fd,-1,4096)==22&&errno==ERANGE);assert(posix_allocate(fd,LLONG_MAX,4096)==27&&errno==ERANGE);
    int (*runtime_allocate)(int,int,off_t,off_t)=kl_shim_lookup("fallocate64");
    int (*event)(unsigned,int)=kl_shim_lookup("eventfd");assert(runtime_allocate&&event);
    int counter=event(0,0);assert(counter>=0&&klj_pollable_owned(counter)&&!klj_pollable_physical(counter));
    errno=0;assert(runtime_allocate(counter,1,0,4096)==-1&&errno==EOPNOTSUPP);assert(!klj_pollable_close(counter));
    int auxiliary=open(file,O_RDONLY);assert(auxiliary>=0&&!klj_descriptor_readonly_adopt(fd,auxiliary));
    assert(klj_pollable_owned(fd)&&klj_pollable_physical(fd));
    assert(!runtime_allocate(fd,1,0,524288)&&state(fd).st_size==69632&&lseek(fd,0,SEEK_CUR)==7);
    int duplicate=klj_pollable_dup(fd);assert(duplicate>=0&&klj_pollable_physical(duplicate));
    assert(!runtime_allocate(duplicate,1,0,524288));
    assert(!klj_descriptor_readonly_seal(duplicate));errno=0;
    assert(runtime_allocate(duplicate,1,0,524288)==-1&&errno==EBADF);
    assert(!klj_pollable_close(duplicate));
    close(readonly);assert(!klj_pollable_close(fd));fd=open(file,O_RDWR);assert(fd>=0&&state(fd).st_size==69632);close(fd);unlink(file);
    puts("PASS native allocation, preserved bytes/offset/size, bounded repeated/concurrent reservation, zero/punch and POSIX errno");
    puts("PASS adopted native-file allocation and dup preserve capability, readonly access and counter rejection");
}
