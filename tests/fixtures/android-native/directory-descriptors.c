#include "pollable-fds/bridge.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

/* Error and signal conversion are outside this physical directory check. */
sigset_t klj_signal_mask_to_host(uint64_t mask){return (sigset_t)mask;}
int klj_signal_to_guest(int signal){return signal;}
int kl_errno_to_linux(int value){return value;}
uid_t klj_process_uid_from_host(uid_t uid){return uid;}
static off_t next(int fd,char name[256]){
    unsigned char bytes[280];ssize_t count=klj_descriptor_getdents64(fd,bytes,24);
    if(count<0&&errno==EINVAL)count=klj_descriptor_getdents64(fd,bytes,32);
    assert(count>0);uint16_t length;memcpy(&length,bytes+16,2);assert(length==count);
    strcpy(name,(char*)bytes+19);off_t cookie;memcpy(&cookie,bytes+8,8);return cookie;
}
/* Explicit transfer carries the original FD and its cursor capability in one
 * native SCM_RIGHTS message. Ordinary sockets have no private wire protocol. */
static void send_fd(int socket,int fd){
    KljDescriptorTransfer transfer;assert(!klj_descriptor_export(fd,&transfer));
    assert(transfer.kind==1&&transfer.count==1&&transfer.metadata>=0);
    uint32_t kind=transfer.kind;int files[2]={fd,transfer.metadata};
    char control[CMSG_SPACE(sizeof files)]={0};struct iovec vector={&kind,sizeof kind};
    struct msghdr message={.msg_iov=&vector,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof control};
    struct cmsghdr *header=CMSG_FIRSTHDR(&message);header->cmsg_level=SOL_SOCKET;header->cmsg_type=SCM_RIGHTS;header->cmsg_len=CMSG_LEN(sizeof files);
    memcpy(CMSG_DATA(header),files,sizeof files);assert(sendmsg(socket,&message,0)==sizeof kind);
    klj_descriptor_export_release(&transfer);
}
static int receive_fd(int socket,int flags){
    uint32_t kind=0;int files[2];char control[CMSG_SPACE(sizeof files)]={0};struct iovec vector={&kind,sizeof kind};
    struct msghdr message={.msg_iov=&vector,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof control};
    assert(recvmsg(socket,&message,flags)==sizeof kind&&!(message.msg_flags&MSG_CTRUNC));
    struct cmsghdr *header=CMSG_FIRSTHDR(&message);assert(header&&header->cmsg_type==SCM_RIGHTS&&header->cmsg_len==CMSG_LEN(sizeof files));
    memcpy(files,CMSG_DATA(header),sizeof files);assert(!klj_descriptor_importv(files[0],kind,files+1,1));return files[0];
}
int main(int argc,char **argv){
    assert(argc==2&&!mkdir(argv[1],0700));
    for(int i=0;i<50;i++){char path[4096];snprintf(path,sizeof path,"%s/f%03d",argv[1],i);int fd=open(path,O_CREAT|O_WRONLY,0600);assert(fd>=0);close(fd);}
    int directory=open(argv[1],O_RDONLY|O_DIRECTORY);assert(directory>=0);
    int alias=klj_pollable_dup(directory);assert(alias>=0);
    char first[256],second[256],again[256];off_t first_cookie=next(directory,first);next(alias,second);assert(strcmp(first,second));
    assert(klj_descriptor_lseek(alias,first_cookie,SEEK_SET)==first_cookie);next(directory,again);assert(!strcmp(again,second));
    assert(klj_descriptor_lseek(directory,0,SEEK_CUR)>first_cookie);
    assert(klj_descriptor_lseek(alias,17,SEEK_SET)<0&&errno==EINVAL);
    struct stat status;assert(!fstatat(alias,"f000",&status,0)&&S_ISREG(status.st_mode));assert(!klj_pollable_close(alias));
    int pair[2];assert(!socketpair(AF_UNIX,SOCK_DGRAM,0,pair));send_fd(pair[0],directory);
    int peek=receive_fd(pair[1],0);send_fd(pair[0],directory);int received=receive_fd(pair[1],0);assert(peek!=received);
    off_t before=klj_descriptor_lseek(directory,0,SEEK_CUR);next(peek,first);assert(klj_descriptor_lseek(received,0,SEEK_CUR)>before);
    next(received,second);assert(strcmp(first,second));klj_pollable_close(peek);assert(!klj_descriptor_lseek(directory,0,SEEK_SET));
    int sync[2];assert(!pipe(sync));pid_t child=fork();assert(child>=0);
    if(!child){close(sync[0]);char name[256];next(received,name);assert(write(sync[1],name,sizeof name)==sizeof name);klj_pollable_close(directory);klj_pollable_close(received);_exit(0);}
    close(sync[1]);assert(read(sync[0],first,sizeof first)==sizeof first);close(sync[0]);next(directory,second);assert(strcmp(first,second));
    int exit_status;assert(waitpid(child,&exit_status,0)==child&&WIFEXITED(exit_status)&&!WEXITSTATUS(exit_status));
    int fresh=open(argv[1],O_RDONLY|O_DIRECTORY);assert(fresh>=0);child=fork();assert(child>=0);
    if(!child){int transferred=receive_fd(pair[1],0);char name[256];next(transferred,name);assert(!strcmp(name,"."));klj_pollable_close(transferred);_exit(0);}
    send_fd(pair[0],fresh);assert(!klj_pollable_close(fresh));assert(waitpid(child,&exit_status,0)==child&&WIFEXITED(exit_status)&&!WEXITSTATUS(exit_status));
    int previous=directory;klj_pollable_close(directory);klj_pollable_close(received);
    int regular=open("/dev/null",O_RDONLY);assert(regular>=0);if(regular!=previous){assert(klj_pollable_dup2(regular,previous)==previous);close(regular);regular=previous;}
    assert(!klj_pollable_owned(regular));assert(klj_descriptor_getdents64(regular,again,sizeof again)<0&&errno==ENOTDIR);close(regular);
    klj_pollable_close(pair[0]);klj_pollable_close(pair[1]);
    puts("PASS original descriptor owner: raw directory cookies, dup, fork, explicit metadata transfer and reuse");return 0;
}
