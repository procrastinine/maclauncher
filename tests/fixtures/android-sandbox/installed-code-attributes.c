#include <fcntl.h>
#include <string.h>
#include <sys/xattr.h>
#include <unistd.h>
int main(int argc,char **argv){
 if(argc==4&&!strcmp(argv[1],"attribute")){
  char value[64];return getxattr(argv[3],argv[2],value,sizeof(value),0,0)>=0?0:1;
 }
 if(argc==3&&!strcmp(argv[1],"read")){
  int fd=open(argv[2],O_RDONLY);if(fd<0)return 1;
  char value;int status=read(fd,&value,1)==1?0:1;close(fd);return status;
 }
 return 2;
}
