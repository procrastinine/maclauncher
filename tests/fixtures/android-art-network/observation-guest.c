#include <sys/socket.h>
#include <sys/select.h>
#include <sys/ioctl.h>
#include <sys/inotify.h>
#include <netinet/in.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

#define CHECK(value) do { if (!(value)) { dprintf(2,"FAIL line%d errno%d\n",__LINE__,errno); exit(3); } } while (0)
static void pending(int fd, int expected) { int count=-1; CHECK(ioctl(fd,FIONREAD,&count)==0); CHECK(count==expected); }
static void ready(int fd, int expected) {
    fd_set read; FD_ZERO(&read); FD_SET(fd,&read);
    struct timespec timeout={0,20000000};
    CHECK(pselect(fd+1,&read,0,0,&timeout,0)==expected);
}
int main(void) {
    close(0); int receiver=socket(AF_INET,SOCK_DGRAM|SOCK_NONBLOCK,0); CHECK(receiver==0);
    struct sockaddr_in address={.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    socklen_t size=sizeof address;
    CHECK(bind(receiver,(void*)&address,size)==0); CHECK(getsockname(receiver,(void*)&address,&size)==0);
    int sender=socket(AF_INET,SOCK_DGRAM,0); CHECK(sender>=0);
    pending(receiver,0); ready(receiver,0);
    CHECK(sendto(sender,"",0,0,(void*)&address,size)==0); ready(receiver,1); pending(receiver,0);
    char bytes[16]; CHECK(recv(receiver,bytes,sizeof bytes,0)==0);
    CHECK(sendto(sender,"payload",7,0,(void*)&address,size)==7); ready(receiver,1); pending(receiver,7);
    CHECK(recv(receiver,bytes,sizeof bytes,0)==7); close(sender); close(receiver);
    int pair[2]; CHECK(socketpair(AF_UNIX,SOCK_STREAM,0,pair)==0); close(pair[1]); ready(pair[0],1); pending(pair[0],0); CHECK(read(pair[0],bytes,sizeof bytes)==0); close(pair[0]);
    // This typed descriptor previously appeared only as "other". Retain a
    // real 32-byte Linux record, then prove consumption and the empty result.
    int notify=inotify_init1(IN_NONBLOCK); CHECK(notify==0);
    CHECK(inotify_add_watch(notify,"/socket-observer-data",IN_CREATE)>=0);
    int created=open("/socket-observer-data/tick",O_CREAT|O_WRONLY,0600); CHECK(created>=0); close(created);
    ready(notify,1); pending(notify,32);
    char event[64]; CHECK(read(notify,event,sizeof event)==32);
    CHECK(read(notify,event,sizeof event)==-1&&errno==EAGAIN); close(notify);
    // A sustained zero-timeout caller reaches the observer's sampled aggregate
    // without retaining or logging every intervening syscall.
    for(int i=5;i<4096;i++) { struct timespec timeout={0,0}; CHECK(pselect(0,0,0,0,&timeout,0)==0); }
    dprintf(1,"PASS original UDP zero/payload counts, readiness, peer close, inotify32 consumption and bounded polling aggregate\n");
    return 0;
}
