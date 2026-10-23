#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
static int kl_socket(int a,int b,int c){return socket(a,b,c);}
static int kl_accept(int a,struct sockaddr *b,socklen_t*c){return accept(a,b,c);}
static int kl_net_trace(void){return 0;}
static int kl_errno_to_linux(int e){return e;}
static int option(int n){return n==20||n==66?SO_RCVTIMEO:SO_SNDTIMEO;}
static int kl_setsockopt(int fd,int level,int name,const void*v,socklen_t n){(void)level;return setsockopt(fd,SOL_SOCKET,option(name),v,n);}
static int kl_getsockopt(int fd,int level,int name,void*v,socklen_t*n){(void)level;return getsockopt(fd,SOL_SOCKET,option(name),v,n);}
#include "native-socket-imports.h"
int main(void){
 int fd=socket(AF_INET,SOCK_DGRAM,0);assert(fd>=0);
 for(int i=0;i<4;i++){
  int name=(int[]){20,21,66,67}[i];int64_t value[2]={2,875000};
  assert(!klj_setsockopt(fd,1,name,value,sizeof(value)));
  struct timeval native={0};socklen_t size=sizeof(native);
  assert(!getsockopt(fd,SOL_SOCKET,option(name),&native,&size));
  assert(native.tv_sec==2&&native.tv_usec==875000);
  int64_t back[3]={-1,-1,INT64_C(0x1122334455667788)};size=sizeof(value);
  assert(!klj_getsockopt(fd,1,name,back,&size)&&size==16);
  assert(back[0]==2&&back[1]==875000&&back[2]==INT64_C(0x1122334455667788));
  back[0]=-1;back[1]=-1;size=8;
  assert(!klj_getsockopt(fd,1,name,back,&size)&&size==8&&back[0]==2&&back[1]==-1);
 }
 close(fd);puts("PASS Linux LP64 socket timeouts and bounded output");
}
