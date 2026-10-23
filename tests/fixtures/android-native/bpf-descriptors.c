#include "network-services/bpf/descriptor.h"
#include "pollable-fds/bridge.h"
#include "pollable-fds/transport.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

/* Process identities and mount projection are outside this descriptor check. */
sigset_t klj_signal_mask_to_host(uint64_t mask){return (sigset_t)mask;}
int klj_signal_to_guest(int value){return value;}
int kl_errno_to_linux(int value){return value;}
uid_t klj_process_uid_from_host(uid_t value){return value;}
void klj_guest_directory_entry(int fd,const char *name,ino_t *inode,unsigned char *type){(void)fd;(void)name;(void)inode;(void)type;}

static void send_map(int socket,int fd){
    char byte=1,control[CMSG_SPACE(sizeof(int))]={0};struct iovec vector={&byte,1};
    struct msghdr message={.msg_iov=&vector,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof control};
    struct cmsghdr *header=CMSG_FIRSTHDR(&message);header->cmsg_level=SOL_SOCKET;header->cmsg_type=SCM_RIGHTS;header->cmsg_len=CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header),&fd,sizeof fd);assert(klj_descriptor_sendmsg(socket,&message,0,1)==1);
}
static int receive_map(int socket,int flags){
    char byte,control[CMSG_SPACE(sizeof(int))]={0};struct iovec vector={&byte,1};
    struct msghdr message={.msg_iov=&vector,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof control};
    assert(klj_descriptor_recvmsg(socket,&message,flags,1)==1&&!(message.msg_flags&MSG_CTRUNC));
    struct cmsghdr *header=CMSG_FIRSTHDR(&message);assert(header&&header->cmsg_type==SCM_RIGHTS);
    int fd;memcpy(&fd,CMSG_DATA(header),sizeof fd);return fd;
}
static void update(int fd,uint32_t key,uint64_t value){
    KljBpfMapLease lease;assert(!klj_bpf_descriptor_begin(fd,&lease));assert(lease.access==O_RDWR);
    assert(!klj_bpf_map_update(lease.map,&key,&value,0));klj_bpf_descriptor_end(&lease);
}
static void check(int fd,uint32_t key,uint64_t expected,int access){
    KljBpfMapLease lease;assert(!klj_bpf_descriptor_begin(fd,&lease)&&lease.access==access);
    uint64_t *value=klj_bpf_map_lookup(lease.map,&key);assert(value&&*value==expected);klj_bpf_descriptor_end(&lease);
}
int main(void){
    char name[]="/tmp/maclauncher-bpf-map-XXXXXX";int metadata=mkstemp(name);assert(metadata>=0);
    KljBpfMapInfo info={.type=1,.key_size=4,.value_size=8,.max_entries=16,.id=17,.name="identity"};
    assert(!klj_bpf_map_initialize(metadata,&info));
    int writable=open(name,O_RDWR|O_CLOEXEC),readonly=open(name,O_RDONLY|O_CLOEXEC);assert(writable>=0&&readonly>=0);
    assert(!klj_bpf_descriptor_adopt(writable,dup(metadata)));
    assert(!klj_bpf_descriptor_adopt(readonly,metadata));assert(!unlink(name));
    update(writable,3,11);check(readonly,3,11,O_RDONLY);
    int alias=klj_pollable_dup(writable);assert(alias>=0);klj_pollable_close(writable);update(alias,3,12);
    int channel[2];assert(!socketpair(AF_UNIX,SOCK_DGRAM,0,channel));
    assert(!klj_descriptor_socket(channel[0],1)&&!klj_descriptor_socket(channel[1],1));
    send_map(channel[0],readonly);
    int peek=receive_map(channel[1],MSG_PEEK);check(peek,3,12,O_RDONLY);klj_pollable_close(peek);
    int transferred=receive_map(channel[1],0);klj_pollable_close(readonly);check(transferred,3,12,O_RDONLY);
    pid_t child=fork();assert(child>=0);
    if(!child){int incoming=receive_map(channel[1],0);update(incoming,3,42);klj_pollable_close(incoming);_exit(0);}
    send_map(channel[0],alias);klj_pollable_close(alias);
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
    check(transferred,3,42,O_RDONLY);
    char byte;assert(klj_pollable_read(transferred,&byte,1)==-1&&errno==EINVAL);
    int previous=transferred;assert(!klj_pollable_close(transferred));
    int ordinary=open("/dev/null",O_RDWR);assert(ordinary>=0);
    if(ordinary!=previous){assert(klj_pollable_dup2(ordinary,previous)==previous);close(ordinary);ordinary=previous;}
    KljBpfMapLease invalid;assert(klj_bpf_descriptor_begin(ordinary,&invalid)==-1&&errno==EBADF);close(ordinary);
    klj_pollable_close(channel[0]);klj_pollable_close(channel[1]);
    puts("PASS BPF map descriptor lifetime, access, dup, fork, SCM_RIGHTS and peek");return 0;
}
