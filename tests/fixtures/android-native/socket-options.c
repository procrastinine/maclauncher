#include <assert.h>
#include <arpa/inet.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <poll.h>
#include <errno.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>
static int (*klj_socket)(int,int,int);
static int (*klj_setsockopt)(int,int,int,const void *,socklen_t);
static int (*klj_getsockopt)(int,int,int,void *,socklen_t *);
static int option(int fd,int level,int name){int value=-1;socklen_t size=sizeof(value);assert(!getsockopt(fd,level,name,&value,&size));return value;}
int main(int argc,char **argv){
    assert(argc==2);void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){puts(dlerror());return 1;}
    void *(*lookup)(const char*)=dlsym(library,"kl_shim_lookup");assert(lookup);
    klj_socket=lookup("socket");klj_setsockopt=lookup("setsockopt");klj_getsockopt=lookup("getsockopt");
    long (*syscall)(long,long,long,long,long,long,long)=dlsym(library,"klb_syscall");
    assert(klj_socket&&klj_setsockopt&&klj_getsockopt&&syscall);
    int fd=klj_socket(2,SOCK_STREAM|0x800,IPPROTO_TCP);assert(fd>=0);
    for(int n=4;n<=6;++n){int value=n==4?23:n==5?7:3,host=n==4?TCP_KEEPALIVE:n==5?TCP_KEEPINTVL:TCP_KEEPCNT;
        assert(!klj_setsockopt(fd,6,n,&value,sizeof(value)));assert(option(fd,6,host)==value);
        int back=0;socklen_t size=sizeof(back);assert(!klj_getsockopt(fd,6,n,&back,&size)&&back==value);
        assert(!option(fd,6,TCP_NOPUSH));
    }
    int enabled=1;assert(!klj_setsockopt(fd,6,3,&enabled,sizeof(enabled)));assert(option(fd,6,TCP_NOPUSH));
    enabled=0;assert(!klj_setsockopt(fd,6,3,&enabled,sizeof(enabled)));assert(!option(fd,6,TCP_NOPUSH));
    for(int mode=0;mode<=2;mode+=2){assert(!klj_setsockopt(fd,0,10,&mode,sizeof(mode)));assert(!!option(fd,0,IP_DONTFRAG)==!!mode);int result=-1;socklen_t size=sizeof(result);assert(!klj_getsockopt(fd,0,10,&result,&size)&&result==mode);}
    int raw=31,back=0;socklen_t raw_size=sizeof(back);
    assert(!syscall(208,fd,6,4,(long)&raw,sizeof(raw),0));assert(option(fd,6,TCP_KEEPALIVE)==raw);
    assert(!syscall(209,fd,6,4,(long)&back,(long)&raw_size,0)&&back==raw);
    close(fd);
    struct sockaddr_in address={.sin_len=sizeof(address),.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    int server=socket(AF_INET,SOCK_STREAM,0);assert(server>=0&&!bind(server,(void*)&address,sizeof(address))&&!listen(server,4));
    socklen_t length=sizeof(address);assert(!getsockname(server,(void*)&address,&length));
    fd=klj_socket(2,SOCK_STREAM|0x800,IPPROTO_TCP);assert(fd>=0);assert(connect(fd,(void*)&address,sizeof(address))==-1&&errno==EINPROGRESS);
    struct pollfd ready={.fd=fd,.events=POLLOUT};assert(poll(&ready,1,1000)==1);
    int error=-1;length=sizeof(error);assert(!klj_getsockopt(fd,1,4,&error,&length)&&error==0);
    int accepted=accept(server,NULL,NULL);assert(accepted>=0);assert(write(fd,"a",1)==1);char byte=0;assert(read(accepted,&byte,1)==1&&byte=='a');close(accepted);close(fd);close(server);
    for(unsigned size=1;size<=sizeof(int);size+=sizeof(int)-1){
        fd=klj_socket(2,SOCK_STREAM|0x800,IPPROTO_TCP);assert(fd>=0);assert(connect(fd,(void*)&address,sizeof(address))==-1&&errno==EINPROGRESS);
        ready.fd=fd;ready.revents=0;assert(poll(&ready,1,1000)==1);error=0;length=size;
        assert(!klj_getsockopt(fd,1,4,&error,&length)&&error==111&&length==size);close(fd);
    }
    puts("PASS Android TCP keepalive without unintended corking, PMTU fragmentation and Linux asynchronous socket errors");
}
