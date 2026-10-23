#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Observe only the named worker of the child owned by the component test. */
int main(int argc,char **argv) {
    if(argc!=3)return 2;
    int pid=atoi(argv[1]);uint64_t ids[256];
    int size=proc_pidinfo(pid,PROC_PIDLISTTHREADS,0,ids,sizeof(ids));
    if(size<=0){perror("thread list");return 3;}
    for(size_t i=0;i<(size_t)size/sizeof(ids[0]);i++) {
        struct proc_threadinfo info={0};
        if(proc_pidinfo(pid,PROC_PIDTHREADINFO,ids[i],&info,sizeof(info))==sizeof(info)
            && !strcmp(info.pth_name,argv[2])) {
            printf("%d\n",info.pth_priority);return 0;
        }
    }
    return 4;
}
