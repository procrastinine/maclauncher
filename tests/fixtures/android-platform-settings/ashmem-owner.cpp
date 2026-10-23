#include <dlfcn.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/mman.h>
#include <unistd.h>
#include <errno.h>
#include <atomic>
#include <new>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <fcntl.h>
static int descriptors(){int count=0;for(int fd=0;fd<getdtablesize();fd++)if(fcntl(fd,F_GETFD)>=0)count++;return count;}
int main(int argc,char**argv){
 if(argc!=3)return 2;
 void* library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){fprintf(stderr,"%s\n",dlerror());return 3;}
 auto create=(int(*)(const char*,size_t))dlsym(library,"ashmem_create_region");auto protect=(int(*)(int,int))dlsym(library,"ashmem_set_prot_region");auto close_region=(int(*)(int))dlsym(library,"klj_parcel_close");
 auto close_core=(int(*)(int))dlsym(library,"klj_pollable_close");
 auto map_region=(void*(*)(void*,size_t,int,int,int,off_t))dlsym(library,"klj_ashmem_mmap");
 auto export_access=(int64_t(*)(int,uint8_t*,size_t))dlsym(library,"klj_ashmem_capability_export");
 int warm=create("unsealed",16384);if(warm<0||close_core(warm))return 11;
 int before=descriptors();for(int i=0;i<100;i++){int unsealed=create("unsealed",16384);if(unsealed<0||close_core(unsealed))return 12;}
 if(descriptors()!=before){fprintf(stderr,"Unsealed descriptor sidecars leaked\n");return 13;}
 puts("PASS unsealed native regions retire through the original descriptor close owner");
 int fd=create("generation fixture",16384);if(fd<0){perror("create");return 4;}
 auto* value=(std::atomic_int*)map_region(nullptr,16384,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);if(value==MAP_FAILED)return 5;
 new(value)std::atomic_int(7);if(protect(fd,PROT_READ)){perror("protect");return 6;}
 int server=socket(AF_UNIX,SOCK_STREAM,0);sockaddr_un address{};address.sun_family=AF_UNIX;strlcpy(address.sun_path,argv[2],sizeof(address.sun_path));
 if(bind(server,(sockaddr*)&address,sizeof(address))||listen(server,1)){perror("listen");return 7;}
 puts("READY");fflush(stdout);int client=accept(server,nullptr,nullptr);if(client<0)return 8;
 char marker=1,control[CMSG_SPACE(sizeof(int))]{};iovec vector{&marker,1};msghdr message{};message.msg_iov=&vector;message.msg_iovlen=1;message.msg_control=control;message.msg_controllen=sizeof(control);
 auto* header=CMSG_FIRSTHDR(&message);header->cmsg_level=SOL_SOCKET;header->cmsg_type=SCM_RIGHTS;header->cmsg_len=CMSG_LEN(sizeof(int));memcpy(CMSG_DATA(header),&fd,sizeof(fd));
 int64_t length=export_access(fd,nullptr,0);if(length<=0)return 14;auto* token=new uint8_t[length];if(export_access(fd,token,length)!=length)return 15;
 uint32_t tokenSize=(uint32_t)length;
 if(sendmsg(client,&message,0)!=1||write(client,&tokenSize,sizeof(tokenSize))!=sizeof(tokenSize)||write(client,token,length)!=length)return 16;
 delete[] token;
 if(read(client,&marker,1)!=1||marker!=2)return 9;
 value->store(11,std::memory_order_relaxed);close_region(fd);marker=3;if(write(client,&marker,1)!=1||read(client,&marker,1)!=1||marker!=4)return 10;
 munmap(value,16384);close(client);close(server);unlink(argv[2]);puts("PASS owner lifetime and original transferred generation storage");
}
