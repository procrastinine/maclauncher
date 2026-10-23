#include <dlfcn.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

extern void probe_log_assert(void *entry);
typedef void *(*lookup_fn)(const char *);
typedef ssize_t (*read_fn)(int, void *, size_t, off_t, size_t);
typedef ssize_t (*write_fn)(int, const void *, size_t, off_t, size_t);
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"FAIL line %d: %s\n",__LINE__,#x);exit(1); } } while(0)
static void delivered_abort(int signal) {
    // Observe the real SIGABRT without creating a desktop crash notification.
    static const char marker[]="DELIVERED_SIGABRT\n";
    (void)!write(STDERR_FILENO,marker,sizeof(marker)-1);
    _exit(128+signal);
}
static void fatal_child(lookup_fn lookup) {
    struct sigaction action={0};action.sa_handler=delivered_abort;sigemptyset(&action.sa_mask);
    CHECK(sigaction(SIGABRT,&action,NULL)==0);
    probe_log_assert(lookup("__android_log_assert"));
    _exit(90);
}
int main(int argc,char **argv) {
    alarm(10);CHECK(argc==3);
    void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){fprintf(stderr,"%s\n",dlerror());return 1;}
    lookup_fn lookup=(lookup_fn)dlsym(library,"kl_shim_lookup");CHECK(lookup);
    uint32_t (*mask)(uint32_t)=lookup("umask"),(*checked_mask)(uint32_t)=lookup("__umask_chk");
    CHECK(mask&&checked_mask);
    uint32_t original_mask=checked_mask(027);
    CHECK(mask(007)==027);CHECK(checked_mask(original_mask)==007);
    void *assertion=lookup("__android_log_assert");CHECK(assertion);
    read_fn read_at=(read_fn)lookup("__pread_chk");write_fn write_at=(write_fn)lookup("__pwrite_chk");
    CHECK(read_at&&write_at);
    CHECK((void*)read_at==lookup("__pread64_chk"));CHECK((void*)write_at==lookup("__pwrite64_chk"));
    int fd=open(argv[2],O_RDWR|O_CREAT|O_EXCL,0600);CHECK(fd>=0);unlink(argv[2]);
    const off_t offset=((off_t)3<<30)+7;
    CHECK(write_at(fd,"native",6,offset,6)==6);CHECK(lseek(fd,0,SEEK_CUR)==0);
    unsigned char *buffer=mmap(NULL,4096,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANON,-1,0);CHECK(buffer!=MAP_FAILED);
    memset(buffer,0xa5,4096);CHECK(read_at(fd,buffer+8,6,offset,6)==6);
    CHECK(!memcmp(buffer+8,"native",6));CHECK(buffer[7]==0xa5&&buffer[14]==0xa5);
    CHECK(lseek(fd,0,SEEK_CUR)==0);CHECK(read_at(fd,buffer,0,offset,0)==0);
    CHECK(read_at(-1,buffer,1,0,1)==-1);CHECK(write_at(-1,buffer,1,0,1)==-1);
    pid_t child=fork();CHECK(child>=0);if(child==0)fatal_child(lookup);
    int status;CHECK(waitpid(child,&status,0)==child);
    CHECK(WIFEXITED(status)&&WEXITSTATUS(status)==128+SIGABRT);
    struct stat value;CHECK(fstat(fd,&value)==0&&value.st_size==offset+6);
    close(fd);munmap(buffer,4096);dlclose(library);
    puts("PASS actual shim AAPCS64 assertion and fortified positioned I/O aliases");return 0;
}
