#include <sys/inotify.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <poll.h>
#include <errno.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "operations.h"
static int await(int fd,int wd,unsigned mask,const char *name){
    unsigned char buffer[8192];
    for(int attempt=0;attempt<20;attempt++){
        struct pollfd poller={fd,POLLIN,0};if(poll(&poller,1,100)<=0)continue;
        ssize_t n=read(fd,buffer,sizeof(buffer));for(size_t p=0;n>0&&p+sizeof(struct inotify_event)<=(size_t)n;){
            struct inotify_event event;memcpy(&event,buffer+p,sizeof(event));const char *path=(char*)buffer+p+sizeof(event);
            if(event.wd==wd&&(event.mask&mask)&&(!name||!strcmp(path,name)))return 1;p+=sizeof(event)+event.len;
        }
    }return 0;
}
int main(int argc,char **argv){assert(argc==2);char path[4096];snprintf(path,sizeof(path),"%s/payload",argv[1]);
    int source=open(path,O_CREAT|O_RDWR|O_TRUNC,0600);assert(source>=0);close(source);
    int fd=inotify_init1(IN_NONBLOCK|IN_CLOEXEC);assert(fd>=0);assert(fcntl(fd,F_GETFL)&O_NONBLOCK);assert(fcntl(fd,F_GETFD)&FD_CLOEXEC);
    int watch=inotify_add_watch(fd,argv[1],IN_CLOSE_WRITE|IN_CLOSE_NOWRITE|IN_OPEN|IN_ACCESS|IN_MOVED_TO|IN_DELETE);assert(watch>=0);
    assert(klj_file_event_interest(IN_CLOSE_WRITE));
    source=open(path,O_WRONLY);assert(source>=0);klj_file_opened(source);assert(await(fd,watch,IN_OPEN,"payload"));
    assert(write(source,"value",5)==5);struct pollfd p={fd,POLLIN,0};assert(poll(&p,1,80)==0);
    assert(klj_file_close(source)==0);assert(await(fd,watch,IN_CLOSE_WRITE,"payload"));
    source=open(path,O_RDONLY);char b[8];assert(klj_file_read(source,b,sizeof(b))==5);assert(await(fd,watch,IN_ACCESS,"payload"));
    assert(klj_file_close(source)==0);assert(await(fd,watch,IN_CLOSE_NOWRITE,"payload"));
    int direct=inotify_add_watch(fd,path,IN_CLOSE_WRITE|IN_ONESHOT);assert(direct>=0);source=open(path,O_RDWR);assert(klj_file_close(source)==0);assert(await(fd,direct,IN_CLOSE_WRITE,NULL));
    assert(inotify_rm_watch(fd,direct)==-1);assert(errno==EINVAL);
    assert(inotify_rm_watch(fd,watch)==0);assert(await(fd,watch,IN_IGNORED,NULL));close(fd);
    for(int n=0;n<100&&klj_file_event_interest(IN_CLOSE_WRITE);n++)usleep(10000);assert(!klj_file_event_interest(IN_CLOSE_WRITE));
    unlink(path);puts("PASS native descriptor events, true close timing, one-shot and retirement");return 0;
}
