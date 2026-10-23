#include <sys/socket.h>
#include <sys/select.h>
#include <sys/ioctl.h>
#include <sys/eventfd.h>
#include <sys/timerfd.h>
#include <sys/epoll.h>
#include <netinet/in.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define CHECK(value) do{if(!(value)){dprintf(2,"FAIL line%d errno%d\n",__LINE__,errno);exit(3);}}while(0)
static int mismatches;
static int ready(int fd,int wait){fd_set r;FD_ZERO(&r);FD_SET(fd,&r);struct timeval t={.tv_sec=wait};return select(fd+1,&r,0,0,&t);}
static void pending(int fd,int expected,const char *label){int actual=-1;CHECK(ioctl(fd,FIONREAD,&actual)==0);if(actual!=expected){dprintf(1,"COUNT %s actual%d expected%d\n",label,actual,expected);mismatches++;}}
static socklen_t loopback(int family,struct sockaddr_storage *storage){
 memset(storage,0,sizeof *storage);
 if(family==AF_INET){struct sockaddr_in *a=(void*)storage;a->sin_family=AF_INET;a->sin_addr.s_addr=htonl(INADDR_LOOPBACK);return sizeof *a;}
 struct sockaddr_in6 *a=(void*)storage;a->sin6_family=AF_INET6;a->sin6_addr=in6addr_loopback;return sizeof *a;
}
static void udp(int family){
 close(0);int fd=socket(family,SOCK_DGRAM|SOCK_NONBLOCK,0);CHECK(fd==0);
 struct sockaddr_storage address;socklen_t length=loopback(family,&address);CHECK(bind(fd,(void*)&address,length)==0);CHECK(getsockname(fd,(void*)&address,&length)==0);
 int sender=socket(family,SOCK_DGRAM,0);CHECK(sender>=0);int type=0;socklen_t type_length=sizeof type;CHECK(getsockopt(fd,SOL_SOCKET,SO_TYPE,&type,&type_length)==0&&type==SOCK_DGRAM);
 pending(fd,0,"empty");CHECK(ready(fd,0)==0);
 const char packet[]="fd0-local",second[]="second";char bytes[64];
 CHECK(sendto(sender,packet,sizeof packet,0,(void*)&address,length)==sizeof packet);CHECK(sendto(sender,second,sizeof second,0,(void*)&address,length)==sizeof second);CHECK(ready(fd,1)==1);
 pending(fd,sizeof packet,"first datagram excludes following packet and address");pending(fd,sizeof packet,"query does not consume");
 CHECK(recvfrom(fd,bytes,sizeof bytes,0,0,0)==sizeof packet&&!memcmp(bytes,packet,sizeof packet));pending(fd,sizeof second,"next datagram");
 CHECK(recvfrom(fd,bytes,sizeof bytes,0,0,0)==sizeof second&&!memcmp(bytes,second,sizeof second));pending(fd,0,"consumed");CHECK(ready(fd,0)==0);
 CHECK(sendto(sender,packet,0,0,(void*)&address,length)==0);CHECK(sendto(sender,second,sizeof second,0,(void*)&address,length)==sizeof second);CHECK(ready(fd,1)==1);
 pending(fd,0,"zero-length first datagram with nonempty successor");CHECK(recvfrom(fd,bytes,sizeof bytes,0,0,0)==0);pending(fd,sizeof second,"after zero-length datagram");CHECK(recvfrom(fd,bytes,sizeof bytes,0,0,0)==sizeof second);
 CHECK(sendto(sender,packet,sizeof packet,0,(void*)&address,length)==sizeof packet);CHECK(ready(fd,1)==1);int alias=dup(fd);CHECK(alias>=0);CHECK(close(fd)==0);pending(alias,sizeof packet,"dup survives close");CHECK(dup2(alias,0)==0);CHECK(close(alias)==0);
 errno=0;CHECK(ioctl(0,FIONREAD,(void*)1)==-1&&errno==EFAULT);pending(0,sizeof packet,"bad destination preserves queue");CHECK(recvfrom(0,bytes,sizeof bytes,0,0,0)==sizeof packet);
 for(int i=0;i<16;i++){pending(0,0,"empty repeated");CHECK(ready(0,0)==0);}CHECK(recvfrom(0,bytes,sizeof bytes,0,0,0)==-1&&errno==EAGAIN);
 CHECK(close(0)==0);CHECK(close(sender)==0);dprintf(1,"UDP IPv%d FD0 ownership/readiness/receive/zero-length/dup2 completed\n",family==AF_INET?4:6);
}
static void stream(void){
 int server=socket(AF_INET,SOCK_STREAM,0);CHECK(server>=0);struct sockaddr_storage address;socklen_t length=loopback(AF_INET,&address);CHECK(bind(server,(void*)&address,length)==0);CHECK(listen(server,1)==0);CHECK(getsockname(server,(void*)&address,&length)==0);
 int sender=socket(AF_INET,SOCK_STREAM,0);CHECK(sender>=0);CHECK(connect(sender,(void*)&address,length)==0);int receiver=accept(server,0,0);CHECK(receiver>=0);
 const char data[]="stream-byte-count";char bytes[64];CHECK(send(sender,data,sizeof data,0)==sizeof data);CHECK(ready(receiver,1)==1);pending(receiver,sizeof data,"TCP readable byte count");CHECK(recv(receiver,bytes,5,0)==5);pending(receiver,sizeof data-5,"TCP partial consumption");CHECK(recv(receiver,bytes,sizeof bytes,0)==sizeof data-5);pending(receiver,0,"TCP empty");close(receiver);close(sender);close(server);
}
static void unsupported(int fd,int expected,const char *label){
 int count=0x12345678;errno=0;int result=ioctl(fd,FIONREAD,&count),error=errno;
 if(result!=-1||error!=expected||count!=0x12345678){dprintf(1,"OWNER %s result%d errno%d expected%d count%d\n",label,result,error,expected,count);mismatches++;}
 errno=0;result=ioctl(fd,FIONREAD,(void*)1);error=errno;
 if(result!=-1||error!=expected){dprintf(1,"OWNER %s invalid-pointer result%d errno%d expected%d\n",label,result,error,expected);mismatches++;}
}
static void anonymous(void){
 close(0);int event=eventfd(7,EFD_NONBLOCK|EFD_CLOEXEC);CHECK(event==0);unsupported(event,ENOTTY,"eventfd ready");CHECK(ready(event,0)==1);
 int alias=dup(event);CHECK(alias>=0);CHECK(close(event)==0);CHECK(dup2(alias,0)==0);CHECK(close(alias)==0);unsupported(0,ENOTTY,"eventfd dup2 FD0");
 uint64_t value=0;CHECK(read(0,&value,sizeof value)==sizeof value&&value==7);unsupported(0,ENOTTY,"eventfd empty");CHECK(ready(0,0)==0);CHECK(close(0)==0);
 int timer=timerfd_create(CLOCK_MONOTONIC,TFD_NONBLOCK|TFD_CLOEXEC);CHECK(timer==0);unsupported(timer,ENOTTY,"timerfd empty");
 struct itimerspec when={.it_value={.tv_nsec=1000000}};CHECK(timerfd_settime(timer,0,&when,0)==0);CHECK(ready(timer,1)==1);unsupported(timer,ENOTTY,"timerfd ready");
 CHECK(read(timer,&value,sizeof value)==sizeof value&&value>=1);CHECK(ready(timer,0)==0);CHECK(close(timer)==0);
 int ep=epoll_create1(EPOLL_CLOEXEC);CHECK(ep==0);unsupported(ep,EINVAL,"epoll Linux6.12 empty");
 int trigger=eventfd(1,EFD_NONBLOCK);CHECK(trigger>=0);struct epoll_event watch={.events=EPOLLIN,.data.u64=42};CHECK(epoll_ctl(ep,EPOLL_CTL_ADD,trigger,&watch)==0);CHECK(ready(ep,0)==1);unsupported(ep,EINVAL,"epoll ready");
 struct epoll_event observed={0};CHECK(epoll_wait(ep,&observed,1,0)==1&&observed.data.u64==42);CHECK(close(trigger)==0);CHECK(close(ep)==0);
 int pipes[2];CHECK(pipe(pipes)==0);CHECK(pipes[0]==0);CHECK(write(pipes[1],"abc",3)==3);pending(0,3,"FD0 pipe after anonymous owner retirement");char bytes[4];CHECK(read(0,bytes,sizeof bytes)==3);close(0);close(pipes[1]);
 int count=99;errno=0;CHECK(ioctl(0,FIONREAD,&count)==-1&&errno==EBADF&&count==99);
 dprintf(1,"Anonymous eventfd/timerfd/epoll FIONREAD ownership, invalid-pointer ordering, FD0 dup/reuse and original reads completed\n");
}
int main(void){udp(AF_INET);udp(AF_INET6);stream();anonymous();if(mismatches){dprintf(1,"FAIL original Bionic FIONREAD owner/payload mismatches%d\n",mismatches);return 2;}dprintf(1,"PASS original Bionic UDP first-datagram FIONREAD counts, zero-length packets, IPv4/IPv6 FD0 reuse/dup2 and TCP byte counts; anonymous Linux owner errors and pipe counts\n");return 0;}
