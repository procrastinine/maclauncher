#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>
extern void *kl_shim_lookup(const char *);

int main(int argc,char **argv) {
    assert(argc==2 && !chdir(argv[1]));
    int (*create)(const char *,int)=kl_shim_lookup("creat");
    int (*create64)(const char *,int)=kl_shim_lookup("creat64");
    assert(create && create64==create);
    mode_t previous=umask(0022);
    int fd=create("created",0676);assert(fd>=0);
    struct stat state;assert(!fstat(fd,&state));
    assert((state.st_mode&0777)==0654);
    assert((fcntl(fd,F_GETFL)&O_ACCMODE)==O_WRONLY);
    assert(!(fcntl(fd,F_GETFD)&FD_CLOEXEC));
    assert(write(fd,"original",8)==8 && !close(fd));
    fd=create64("created",0600);assert(fd>=0);
    assert(!fstat(fd,&state) && !state.st_size && (state.st_mode&0777)==0654);
    assert(!close(fd));
    char absolute[PATH_MAX];assert(realpath("created",absolute));
    fd=create64(absolute,0600);assert(fd>=0 && !close(fd));
    errno=0;assert(create("missing/child",0600)==-1 && errno==ENOENT);
    errno=0;assert(create(".",0600)==-1 && errno==EISDIR);
    umask(previous);assert(!unlink("created"));
    puts("PASS creat/creat64 share openat pathname, create/truncate, umask, write-only flags and error semantics");
}
