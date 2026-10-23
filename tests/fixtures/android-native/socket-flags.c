#include <assert.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <arpa/inet.h>
static int (*kl_socket)(int,int,int);
static int (*kl_accept)(int,struct sockaddr *,socklen_t *);
static int (*kl_setsockopt)(int,int,int,const void *,socklen_t);
static int (*kl_getsockopt)(int,int,int,void *,socklen_t *);
static int (*kl_errno_to_linux)(int);
static int kl_net_trace(void){return 0;}
#include "native-socket-imports.h"
static void flags(int fd){assert(fd>=0);assert(fcntl(fd,F_GETFL)&O_NONBLOCK);assert(fcntl(fd,F_GETFD)&FD_CLOEXEC);}
int main(int argc,char **argv){
    assert(argc==2);void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){puts(dlerror());return 1;}
    void *(*lookup)(const char*)=dlsym(library,"kl_upstream_shim_lookup");assert(lookup);
    kl_socket=lookup("socket");kl_accept=lookup("accept");assert(kl_socket&&kl_accept);
    kl_setsockopt=lookup("setsockopt");kl_getsockopt=lookup("getsockopt");kl_errno_to_linux=dlsym(library,"kl_errno_to_linux");
    long (*raw)(long,long,long,long,long,long,long)=lookup("syscall");assert(raw);
    for(int family=2;family<=10;family+=8){int fd=klj_socket(family,SOCK_STREAM|0x80800,0);flags(fd);close(fd);}
    int pair[2];assert(!klj_socketpair(1,SOCK_STREAM|0x80800,0,pair));flags(pair[0]);flags(pair[1]);
    char byte=0;assert(read(pair[0],&byte,1)<0&&errno==EAGAIN);assert(write(pair[1],"z",1)==1);assert(read(pair[0],&byte,1)==1&&byte=='z');close(pair[0]);close(pair[1]);
    int server=socket(AF_INET,SOCK_STREAM,0),client=socket(AF_INET,SOCK_STREAM,0);assert(server>=0&&client>=0);
    struct sockaddr_in address={.sin_len=sizeof(address),.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    assert(!bind(server,(void *)&address,sizeof(address))&&!listen(server,1));socklen_t length=sizeof(address);assert(!getsockname(server,(void *)&address,&length));
    assert(!connect(client,(void *)&address,length));struct sockaddr_storage peer;length=sizeof(peer);
    int accepted=klj_accept4(server,(void *)&peer,&length,0x80800);flags(accepted);assert(*(uint16_t *)&peer==2);close(accepted);close(client);
    for(int syscall=202;syscall<=242;syscall+=40){
        client=socket(AF_INET,SOCK_STREAM,0);assert(client>=0&&!connect(client,(void *)&address,sizeof(address)));length=sizeof(peer);
        accepted=(int)raw(syscall,server,(long)&peer,(long)&length,0x80800,0,0);assert(accepted>=0&&*(uint16_t *)&peer==2);
        if(syscall==242)flags(accepted);close(accepted);close(client);
    }
    close(server);
    int rawfd=(int)raw(198,10,SOCK_STREAM|0x80800,0,0,0,0);flags(rawfd);close(rawfd);
    assert(!raw(199,1,SOCK_STREAM|0x80800,0,(long)pair,0,0));flags(pair[0]);flags(pair[1]);close(pair[0]);close(pair[1]);
    errno=0;assert(klj_accept4(-1,NULL,NULL,0x1000)==-1&&errno==EINVAL);
    puts("PASS Android socket flags, shared raw syscall routing, original Klepton address ownership and actual descriptor I/O");
}
