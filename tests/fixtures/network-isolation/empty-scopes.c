#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(int count,char** values){
    if(count!=2)return 2;
    int modes[]={O_RDONLY,O_WRONLY};
    for(unsigned index=0;index<sizeof(modes)/sizeof(*modes);index++){
        errno=0;int fd=open(values[1],modes[index]);
        if(fd>=0){close(fd);fprintf(stderr,"Unscoped file access was allowed\n");return 3;}
        if(errno!=EPERM&&errno!=EACCES){perror("file access control");return 4;}
    }
    puts("Empty write scopes preserve file isolation");return 0;
}
