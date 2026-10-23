#define _GNU_SOURCE
#include <assert.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <unistd.h>
#include "proc-maps.h"

static void origin(int fd,const char *expected){
    char path[96],value[128];snprintf(path,sizeof path,"/proc/self/fd/%d",fd);
    ssize_t length=readlink(path,value,sizeof value-1);
    if(length<0){perror("readlink opened maps");exit(21);}
    value[length]=0;
    if(strcmp(value,expected)){fprintf(stderr,"opened maps identity: %s != %s\n",value,expected);exit(22);}
}
static int snapshot(FILE *output,void *context){
    int fd=*(int *)context;char bytes[4096];ssize_t count;assert(lseek(fd,0,SEEK_SET)==0);
    while((count=read(fd,bytes,sizeof bytes))>0)if(fwrite(bytes,1,(size_t)count,output)!=(size_t)count)return 0;
    return count==0;
}
int main(int argc,char **argv){
    if(argc==5&&!strcmp(argv[1],"exec")){
        int fd=atoi(argv[2]),published=atoi(argv[3]);origin(fd,argv[4]);origin(published,argv[4]);char bytes[64];assert(read(fd,bytes,sizeof bytes)>0);close(fd);close(published);
        puts("PASS maps opened origin precedes parsing and survives dup, fork and exec");return 0;
    }
    assert(argc==1);char expected[96];snprintf(expected,sizeof expected,"/proc/%d/maps",getpid());
    int fd=open(expected,O_RDONLY);assert(fd>=0);
    // The original caller validates this magic-link target before reading or
    // parsing any maps bytes, then trusts the returned mapping permissions.
    origin(fd,expected);
    assert(!mkdir("/tmp/snapshot",0700));char path[256];
    if(!klj_proc_maps_publish("/tmp/snapshot",path,sizeof path,snapshot,&fd,(uint64_t)getpid())){perror("publish maps snapshot");return 24;}
    int published=open(path,O_RDONLY);assert(published>=0);origin(published,expected);
    assert(lseek(fd,0,SEEK_SET)==0);int copy=dup(fd);assert(copy>=0);close(fd);origin(copy,expected);
    pid_t child=fork();assert(child>=0);
    if(child==0){origin(copy,expected);origin(published,expected);_exit(0);}
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    char number[32],file[32];snprintf(number,sizeof number,"%d",copy);snprintf(file,sizeof file,"%d",published);execl(argv[0],argv[0],"exec",number,file,expected,(char *)NULL);
    perror("exec maps origin");return 23;
}
