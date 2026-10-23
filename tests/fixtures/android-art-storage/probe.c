#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static void name(int fd,const char* expected){char proc[64],actual[PATH_MAX];snprintf(proc,sizeof(proc),"/proc/self/fd/%d",fd);ssize_t size=readlink(proc,actual,sizeof(actual)-1);assert(size>=0);actual[size]=0;if(strcmp(actual,expected)){fprintf(stderr,"descriptor %d: %s != %s\n",fd,actual,expected);abort();}}
static void canonical(const char* path){char* actual=realpath(path,NULL);if(!actual||strcmp(actual,path)){fprintf(stderr,"realpath %s: %s errno %d\n",path,actual?actual:"NULL",errno);abort();}free(actual);}
int main(int argc,char** argv){
 const char* data="/data/user/0/org.example.storage";
 const char* file="/data/user/0/org.example.storage/files/original";
 const char* renamed="/data/user/0/org.example.storage/files/renamed";
 if(argc==4&&!strcmp(argv[1],"--exec")){name(atoi(argv[2]),renamed);name(atoi(argv[3]),"/sdcard/renamed");puts("PASS exec opened namespace");return 0;}
 canonical(data);canonical("/data/user/0/org.example.storage/files");canonical("/data/user/0/org.example.storage/cache");canonical("/sdcard");
 int fd=open(file,O_CREAT|O_RDWR,0600);assert(fd>=0);assert(write(fd,"original",8)==8);name(fd,file);
 int alias=open("/sdcard/original",O_PATH);assert(alias>=0);name(alias,"/sdcard/original");
 int copy=dup(fd);assert(copy>=0);name(copy,file);assert(close(fd)==0);
 int directory=open("/data/user/0/org.example.storage/files",O_RDONLY|O_DIRECTORY);assert(directory>=0);
 int relative=openat(directory,"original",O_RDONLY|O_CLOEXEC);assert(relative>=0);name(relative,file);assert(close(relative)==0);assert(close(directory)==0);
 assert(rename(file,renamed)==0);name(copy,renamed);name(alias,"/sdcard/renamed");
 pid_t child=fork();assert(child>=0);if(!child){name(copy,renamed);name(alias,"/sdcard/renamed");char a[32],b[32];snprintf(a,sizeof(a),"%d",copy);snprintf(b,sizeof(b),"%d",alias);execl(argv[0],argv[0],"--exec",a,b,NULL);perror("exec");_exit(1);}
 int status;assert(waitpid(child,&status,0)==child);assert(WIFEXITED(status)&&WEXITSTATUS(status)==0);
 assert(close(copy)==0);assert(close(alias)==0);assert(unlink(renamed)==0);
 puts("PASS original Bionic aliases, descriptor duplication, relative open, rename, fork and exec");return 0;
}
