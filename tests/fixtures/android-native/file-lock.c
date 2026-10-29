#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
#include "file-lock.h"
static int apply(int fd,int cmd,struct klj_linux_flock *lock){return klj_file_lock(fd,cmd,(uintptr_t)lock);}
int main(void){
    char file[1024];snprintf(file,sizeof file,"%s/android-file-lock-XXXXXX",getenv("TMPDIR")?getenv("TMPDIR"):"/tmp");int fd=mkstemp(file);assert(fd>=0);
    struct klj_linux_flock lock={.type=1,.whence=SEEK_SET,.start=37,.length=19};
    assert(apply(fd,6,&lock)==0);
    int ready[2],release[2];assert(pipe(ready)==0&&pipe(release)==0);
    pid_t child=fork();assert(child>=0);
    if(!child){
        close(ready[0]);close(release[1]);int other=open(file,O_RDWR);assert(other>=0);
        struct klj_linux_flock query={.type=1,.whence=SEEK_SET,.start=40,.length=1};
        assert(apply(other,5,&query)==0);assert(query.type==1&&query.pid==getppid()&&query.start==37&&query.length==19);
        query=(struct klj_linux_flock){.type=1,.whence=SEEK_SET,.start=40,.length=1};
        assert(apply(other,6,&query)==-1&&(errno==EAGAIN||errno==EACCES));
        assert(write(ready[1],"r",1)==1);char byte;assert(read(release[0],&byte,1)==1);
        assert(apply(other,7,&query)==0);query.type=2;assert(apply(other,6,&query)==0);
        close(other);_exit(0);
    }
    close(ready[1]);close(release[0]);char byte;assert(read(ready[0],&byte,1)==1);
    lock.type=2;assert(apply(fd,6,&lock)==0);assert(write(release[1],"u",1)==1);
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    close(ready[0]);close(release[1]);
    lock=(struct klj_linux_flock){.type=1,.whence=SEEK_SET,.start=4,.length=8};
    assert(apply(fd,37,&lock)==0);int second=open(file,O_RDWR);assert(second>=0);
    struct flock actual={.l_type=F_WRLCK,.l_whence=SEEK_SET,.l_start=4,.l_len=8};
    assert(fcntl(second,F_OFD_GETLK,&actual)==0&&actual.l_type==F_WRLCK&&actual.l_start==4&&actual.l_len==8);
    close(fd);lock.type=1;assert(apply(second,36,&lock)==0&&lock.type==2);
    close(second);unlink(file);puts("PASS Linux range, ownership, contention, unlock and OFD lifetime");
}
