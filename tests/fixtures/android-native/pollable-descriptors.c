#include "pollable-fds/bridge.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
struct guest_event{uint32_t events,padding;uint64_t value;};
struct guest_timer{struct timespec interval,value;};
static int descriptor;
static int descriptors(void){int count=0;for(int fd=0;fd<getdtablesize();fd++)count+=fcntl(fd,F_GETFD)!=-1;return count;}
static void *write_counter(void *unused){(void)unused;struct timespec delay={0,10000000};nanosleep(&delay,NULL);uint64_t value=7;assert(klj_pollable_write(descriptor,&value,8)==8);return NULL;}
extern void *kl_shim_lookup(const char *);
static volatile sig_atomic_t interrupted;
static pthread_t waiting_thread;
static void interrupt_wait(int signal){(void)signal;interrupted=1;}
static void *send_wait_signal(void *unused){(void)unused;struct timespec delay={0,10000000};nanosleep(&delay,NULL);assert(!pthread_kill(waiting_thread,SIGUSR1));return NULL;}
static void descriptor_sets(void *(*lookup)(const char *)){
    int(*wait)(int,fd_set *,fd_set *,fd_set *,const struct timespec *,const uint64_t *)=lookup("pselect");
    int(*wait64)(int,fd_set *,fd_set *,fd_set *,const struct timespec *,const uint64_t *)=lookup("pselect64");
    struct timeval64{int64_t seconds,microseconds;};
    int(*select_wait)(int,fd_set *,fd_set *,fd_set *,struct timeval64 *)=lookup("select");
    assert(wait&&wait64&&select_wait);
    int(*create)(unsigned,int)=lookup("eventfd");int fd=create(1,0x80800);assert(fd>=0&&fd<FD_SETSIZE);
    struct timespec immediate={0,0};fd_set readable;FD_ZERO(&readable);FD_SET(fd,&readable);
    assert(wait(fd+1,&readable,NULL,NULL,&immediate,NULL)==1&&FD_ISSET(fd,&readable));
    uint64_t value;assert(klj_pollable_read(fd,&value,sizeof(value))==sizeof(value));
    FD_SET(fd,&readable);assert(wait64(fd+1,&readable,NULL,NULL,&immediate,NULL)==0&&!FD_ISSET(fd,&readable));
    assert(!klj_pollable_close(fd));FD_SET(fd,&readable);assert(wait(fd+1,&readable,NULL,NULL,&immediate,NULL)==-1&&errno==EBADF);
    struct timeval64 invalid={0,INT64_C(1)<<32};assert(select_wait(0,NULL,NULL,NULL,&invalid)==-1&&errno==EINVAL);
    struct timeval64 timeout={0,1000};assert(select_wait(0,NULL,NULL,NULL,&timeout)==0&&timeout.seconds==0&&timeout.microseconds==0);
    sigset_t block,previous,after;sigemptyset(&block);sigaddset(&block,SIGUSR1);assert(!pthread_sigmask(SIG_BLOCK,&block,&previous));
    struct sigaction action={.sa_handler=interrupt_wait},old;sigemptyset(&action.sa_mask);assert(!sigaction(SIGUSR1,&action,&old));
    pthread_t worker;waiting_thread=pthread_self();assert(!pthread_create(&worker,NULL,send_wait_signal,NULL));
    const uint64_t unblocked=0;struct timespec limit={1,0};assert(wait(0,NULL,NULL,NULL,&limit,&unblocked)==-1&&errno==EINTR&&interrupted);
    assert(limit.tv_sec==1&&limit.tv_nsec==0);assert(!pthread_join(worker,NULL));assert(!pthread_sigmask(SIG_SETMASK,NULL,&after));assert(sigismember(&after,SIGUSR1)==1);
    assert(!sigaction(SIGUSR1,&old,NULL));assert(!pthread_sigmask(SIG_SETMASK,&previous,NULL));
}
static void readonly_descriptions(void){
    for(int i=0;i<50;i++){
        char name[PATH_MAX];snprintf(name,sizeof(name),"%s/readonly-XXXXXX",getenv("TMPDIR"));
        int fd=mkstemp(name);assert(fd>=0);int readonly=open(name,O_RDONLY|O_CLOEXEC);assert(readonly>=0);assert(!unlink(name));
        assert(!klj_descriptor_readonly_adopt(fd,readonly));assert(!klj_pollable_ftruncate(fd,16384));
        int *writer=klj_pollable_mmap(NULL,16384,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);assert(writer!=MAP_FAILED);writer[0]=7;
        int alias=klj_pollable_dup(fd);assert(alias>=0);
        if(i%2){
            assert(!klj_descriptor_readonly_seal(alias));
            int value=0;assert(klj_pollable_pread(alias,&value,sizeof(value),0)==sizeof(value)&&value==7);
            assert(klj_pollable_pwrite(alias,&value,sizeof(value),0)==-1&&errno==EBADF);
            assert(klj_pollable_mmap(NULL,16384,PROT_READ|PROT_WRITE,MAP_SHARED,alias,0)==MAP_FAILED);
        }
        assert(!klj_pollable_close(fd));
        if(!(i%2)){int value=11;assert(klj_pollable_pwrite(alias,&value,sizeof(value),0)==sizeof(value)&&writer[0]==11);}
        assert(!klj_pollable_close(alias));assert(!munmap(writer,16384));
    }
}
int main(int argc,char **argv){
    (void)argv;void *(*lookup)(const char *)=argc>1?kl_shim_lookup:klj_pollable_lookup;
    int(*create)(unsigned,int)=lookup("eventfd");
    int(*ep_create)(int)=lookup("epoll_create1");
    int(*ep_ctl)(int,int,int,void*)=lookup("epoll_ctl");
    int(*ep_wait)(int,void*,int,int)=lookup("epoll_wait");
    int(*timer_create)(int,int)=lookup("timerfd_create");
    int(*timer_set)(int,int,const void*,void*)=lookup("timerfd_settime");
    int before=descriptors();
    descriptor_sets(lookup);
    int fd=create(2,0x80800);assert(fd>=0);
    assert(klj_pollable_fcntl(fd,F_GETFD)&FD_CLOEXEC);
    assert(klj_pollable_fcntl(fd,F_GETFL)&O_NONBLOCK);
    uint64_t value=5;assert(klj_pollable_write(fd,&value,8)==8);
    unsigned char wide[16]={0};assert(klj_pollable_read(fd,wide,sizeof(wide))==8);memcpy(&value,wide,8);assert(value==7);
    assert(klj_pollable_read(fd,&value,8)==-1&&errno==EAGAIN);
    value=0;assert(klj_pollable_write(fd,&value,8)==8);struct pollfd empty={fd,POLLIN,0};assert(klj_pollable_poll(&empty,1,0)==0);
    value=17;struct iovec pieces[2]={{&value,3},{(char*)&value+3,5}};assert(klj_pollable_writev(fd,pieces,2)==8);
    value=0;assert(klj_pollable_readv(fd,pieces,2)==8&&value==17);
    struct iovec oversized={NULL,SSIZE_MAX};assert(klj_pollable_writev(fd,&oversized,1)==-1&&errno==EINVAL);
    assert(klj_pollable_dup2(fd,INT_MAX)==-1&&errno==EBADF);
    int alias=klj_pollable_dup(fd);assert(alias>=0);value=11;assert(klj_pollable_write(alias,&value,8)==8);
    assert(!klj_pollable_close(fd));assert(klj_pollable_read(alias,&value,8)==8&&value==11);
    assert(!klj_pollable_fcntl(alias,F_SETFL,0));descriptor=alias;
    pthread_t worker;assert(!pthread_create(&worker,NULL,write_counter,NULL));assert(klj_pollable_read(alias,&value,8)==8&&value==7);assert(!pthread_join(worker,NULL));
    assert(!klj_pollable_close(alias));
    fd=create(3,0x801);assert(fd>=0);for(int i=0;i<3;i++)assert(klj_pollable_read(fd,&value,8)==8&&value==1);
    assert(klj_pollable_read(fd,&value,8)==-1&&errno==EAGAIN);
    int queue=ep_create(0x80000);assert(queue>=0);struct guest_event wanted={.events=1,.value=0x123456789abcdef0},actual;
    assert(!ep_ctl(queue,1,fd,&wanted));assert(ep_wait(queue,&actual,1,0)==0);
    value=1;assert(klj_pollable_write(fd,&value,8)==8);assert(ep_wait(queue,&actual,1,100)==1&&actual.value==wanted.value&&(actual.events&1));
    assert(klj_pollable_read(fd,&value,8)==8&&value==1);assert(!klj_pollable_close(fd));assert(!klj_pollable_close(queue));
    fd=timer_create(1,0x80800);assert(fd>=0);struct guest_timer timer={.value={0,10000000}};assert(!timer_set(fd,0,&timer,NULL));
    struct pollfd poller={fd,POLLIN,0};assert(klj_pollable_poll(&poller,1,500)==1&&(poller.revents&POLLIN));
    assert(klj_pollable_read(fd,&value,8)==8&&value==1);assert(!klj_pollable_close(fd));
    for(int i=0;i<100;i++){fd=create(1,0x800);assert(fd>=0);alias=klj_pollable_dup(fd);assert(alias>=0);assert(!klj_pollable_close(fd));assert(klj_pollable_read(alias,&value,8)==8&&value==1);assert(!klj_pollable_close(alias));}
    readonly_descriptions();assert(descriptors()==before);
    puts("PASS original eventfd/timerfd/epoll native owner, counters, semaphore, duplicated lifetime, readiness");
}
