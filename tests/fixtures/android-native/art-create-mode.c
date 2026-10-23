#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#define CHECK(value,label) do { if(!(value)){fprintf(stderr,"FAIL %s errno%d\n",label,errno);return 2;} } while(0)
int main(int argc,char **argv){
 CHECK(argc==2,"directory argument");char directory[1024],file[1100];
 CHECK(snprintf(directory,sizeof directory,"%s/cache",argv[1])>0,"directory");
 CHECK(snprintf(file,sizeof file,"%s/shaders",directory)>0,"file");
 CHECK(geteuid()==0,"initial root setup identity");CHECK(mkdir(directory,0777)==0,"mkdir");
 CHECK(chown(directory,10154,20154)==0,"set directory owner/group");CHECK(chmod(directory,02771)==0,"setgid directory");
 gid_t groups[]={20154};CHECK(setgroups(1,groups)==0,"supplementary group");
 CHECK(setresgid(10154,10154,10154)==0,"app gid");CHECK(setresuid(10154,10154,10154)==0,"app uid");umask(0);
 int fd=open(file,O_CREAT|O_EXCL|O_RDWR,0);CHECK(fd>=0,"app mode000 create");
 CHECK(write(fd,"cache",5)==5,"owner writes through descriptor");CHECK(fchmod(fd,0400)==0,"owner fchmod0400");CHECK(close(fd)==0,"close");
 struct stat s;CHECK(stat(file,&s)==0,"stat");CHECK(s.st_uid==10154&&s.st_gid==20154&&(s.st_mode&07777)==0400,"uid/setgid-group/mode");
 fd=open(file,O_RDONLY);CHECK(fd>=0,"owner reopens read-only");char bytes[6]={0};CHECK(read(fd,bytes,5)==5&&!strcmp(bytes,"cache"),"read preserved contents");CHECK(close(fd)==0,"close read");
 errno=0;CHECK(open(file,O_WRONLY)==-1&&errno==EACCES,"guest write permission remains restricted");
 puts("PASS original Bionic app mode000 create/write/fchmod0400, uid10154 inheritedgid20154 and guest DAC");return 0;
}
