#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>
#include "original-message-types.h"
#include "socket-message-control.h"

int main(void){
    int sockets[2];assert(!socketpair(AF_UNIX,SOCK_DGRAM,0,sockets));
    int original=open("/dev/null",O_RDONLY);assert(original>=0);
    union {uint64_t alignment;uint8_t bytes[1040];} sent={0},received={0};
    kl_lx_cmsghdr *header=(void*)sent.bytes;header->cmsg_len=sizeof(*header)+253*sizeof(int);header->cmsg_level=1;header->cmsg_type=1;
    for(unsigned i=0;i<253;i++)memcpy(sent.bytes+sizeof(*header)+i*sizeof(int),&original,sizeof(int));
    char payload='x',output=0;struct iovec data={&payload,1},result={&output,1};
    kl_lx_msghdr guest={.msg_iov=&data,.msg_iovlen=1,.msg_control=sent.bytes,.msg_controllen=KL_LX_CMSG_ALIGN(header->cmsg_len)};
    struct msghdr native={.msg_iov=&data,.msg_iovlen=1};assert(!klj_message_control_send(&guest,&native));
    assert(native.msg_controllen==CMSG_SPACE(253*sizeof(int)));assert(sendmsg(sockets[0],&native,0)==1);free(native.msg_control);
    guest=(kl_lx_msghdr){.msg_iov=&result,.msg_iovlen=1,.msg_control=received.bytes,.msg_controllen=sizeof(received.bytes)};
    native=(struct msghdr){.msg_iov=&result,.msg_iovlen=1};assert(!klj_message_control_receive(&guest,&native));assert(recvmsg(sockets[1],&native,0)==1&&output=='x');
    klj_message_control_back(&guest,&native,0x40000000);free(native.msg_control);header=(void*)received.bytes;
    assert(header->cmsg_level==1&&header->cmsg_type==1&&header->cmsg_len==sizeof(*header)+253*sizeof(int));
    for(unsigned i=0;i<253;i++){int fd;memcpy(&fd,received.bytes+sizeof(*header)+i*sizeof(int),sizeof(fd));assert(fcntl(fd,F_GETFD)&FD_CLOEXEC);assert(!klj_pollable_close(fd));}
    // The physical receive may fit more native headers than the guest ABI.
    // Conversion owns cleanup for every right it cannot return to the caller.
    int discarded[3];for(unsigned i=0;i<3;i++)discarded[i]=dup(original);
    union {struct cmsghdr alignment;uint8_t bytes[CMSG_SPACE(sizeof discarded)];} control={0};
    struct cmsghdr *host=(void*)control.bytes;host->cmsg_len=CMSG_LEN(sizeof discarded);host->cmsg_level=SOL_SOCKET;host->cmsg_type=SCM_RIGHTS;memcpy(CMSG_DATA(host),discarded,sizeof discarded);
    native=(struct msghdr){.msg_control=control.bytes,.msg_controllen=sizeof control.bytes};guest.msg_controllen=sizeof(kl_lx_cmsghdr)+sizeof(int);
    klj_message_control_back(&guest,&native,0);assert(native.msg_flags&MSG_CTRUNC);assert(guest.msg_controllen==20);
    assert(fcntl(discarded[0],F_GETFD)>=0);for(unsigned i=1;i<3;i++)assert(fcntl(discarded[i],F_GETFD)<0&&errno==EBADF);klj_pollable_close(discarded[0]);
    close(original);close(sockets[0]);close(sockets[1]);
    puts("PASS original ancillary layouts, 253 rights, host passthrough, CLOEXEC and CTRUNC cleanup");
}
