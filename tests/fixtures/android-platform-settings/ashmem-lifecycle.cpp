#include <sys/socket.h>
#include <sys/un.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <linux/ashmem.h>
#include <unistd.h>
#include <fcntl.h>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include "descriptor-capability.h"

static void inspect(int fd,int expected){
 assert(ioctl(fd,ASHMEM_GET_SIZE,0)==16384);
 auto* value=(int*)mmap(nullptr,16384,PROT_READ,MAP_SHARED,fd,0);
 assert(value!=MAP_FAILED&&__atomic_load_n(value,__ATOMIC_RELAXED)==expected);
 assert(!munmap(value,16384));
 assert(mmap(nullptr,16384,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0)==MAP_FAILED);
 assert(klj_ashmem_capability_export(fd,nullptr,0)>0);
}
static void receive(int fd,void* bytes,size_t length){
 auto* cursor=(char*)bytes;while(length){ssize_t count=read(fd,cursor,length);assert(count>0);cursor+=count;length-=count;}
}
int main(int argc,char**argv){
 if(argc==3&&!strcmp(argv[1],"--exec")){
  int fd=atoi(argv[2]);inspect(fd,7);int alias=dup(fd);assert(alias>=0&&!close(fd));inspect(alias,7);assert(!close(alias));
  puts("PASS imported exact-file authority survives original fork and exec");return 0;
 }
 assert(argc==2);int channel=socket(AF_UNIX,SOCK_STREAM,0);assert(channel>=0);
 sockaddr_un address{};address.sun_family=AF_UNIX;strlcpy(address.sun_path,argv[1],sizeof(address.sun_path));assert(!connect(channel,(sockaddr*)&address,sizeof(address)));
 char marker=0,control[CMSG_SPACE(sizeof(int))]{};iovec vector{&marker,1};msghdr message{};message.msg_iov=&vector;message.msg_iovlen=1;message.msg_control=control;message.msg_controllen=sizeof(control);
 assert(recvmsg(channel,&message,0)==1&&marker==1);auto* header=CMSG_FIRSTHDR(&message);assert(header&&header->cmsg_level==SOL_SOCKET&&header->cmsg_type==SCM_RIGHTS);
 int fd=-1;memcpy(&fd,CMSG_DATA(header),sizeof(fd));assert(fd>=0);uint32_t size=0;receive(channel,&size,sizeof(size));assert(size>0);std::vector<uint8_t> token(size);receive(channel,token.data(),token.size());
 assert(!klj_ashmem_capability_import(fd,token.data(),token.size()));token.clear();int alias=dup(fd);assert(alias>=0&&!close(fd));inspect(alias,7);
 pid_t child=fork();assert(child>=0);if(!child){inspect(alias,7);char number[32];snprintf(number,sizeof(number),"%d",alias);execl("/data/local/tmp/ashmem-lifecycle","ashmem-lifecycle","--exec",number,(char*)nullptr);_exit(111);}
 int status=-1;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);inspect(alias,7);
 marker=2;assert(write(channel,&marker,1)==1);receive(channel,&marker,1);assert(marker==3);inspect(alias,11);assert(!close(alias));
 int neighbor=open("/data/local/tmp/neighbor",O_RDONLY);assert(neighbor<0);
 marker=4;assert(write(channel,&marker,1)==1&&!close(channel));puts("PASS imported authority dup, owner close, child retirement and neighboring file isolation");return 0;
}
