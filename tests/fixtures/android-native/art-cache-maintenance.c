#define _GNU_SOURCE
#include <assert.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <ucontext.h>
#include <unistd.h>
static volatile sig_atomic_t undefined;
static void handler(int signal,siginfo_t *info,void *opaque){
    ucontext_t *context=opaque;uint32_t instruction=*(uint32_t*)context->uc_mcontext.pc;
    assert(signal==SIGILL&&info->si_code==ILL_ILLOPC);
    assert(instruction==0xd50b7b23||instruction==0xd50b7523||instruction==0xd50b7a23||instruction==0xd50b7e23);
    ++undefined;context->uc_mcontext.pc+=4;
}
int main(int argc,char **argv){
    assert(argc==2);const int baseline=!strcmp(argv[1],"--baseline");
    struct sigaction action={.sa_sigaction=handler,.sa_flags=SA_SIGINFO};sigemptyset(&action.sa_mask);assert(!sigaction(SIGILL,&action,0));
    const size_t page=16384,span=512UL<<20;
    // The x18 read exercises the original file translator, then granting write
    // enrolls exactly that original file mapping in the mutable-code owner.
    const uint32_t original[]={0xaa0003e3,0xaa1203e9,0xd50b7b23,0xd5033b9f,0xd50b7523,0xd50b7a23,0xd50b7e23,0xd5033b9f,0xd5033fdf,0xd28000e0,0xd65f03c0};
    const int fd=open("/data/local/tmp/cache-maintenance/original.code",O_CREAT|O_EXCL|O_RDWR|O_CLOEXEC,0600);assert(fd>=0);
    assert(!ftruncate(fd,page)&&pwrite(fd,original,sizeof original,0)==sizeof original);
    void *reservation=mmap(0,span,PROT_NONE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(reservation!=MAP_FAILED);
    uint32_t *code=(void*)((char*)reservation+(span/2));
    assert(mmap(code,page,PROT_READ|PROT_EXEC,MAP_PRIVATE|MAP_FIXED,fd,0)==code);assert(!close(fd));
    uint64_t (*call)(void*)=(void*)code;assert(call(code)==7&&undefined==0);
    assert(!mprotect(code,page,PROT_READ|PROT_WRITE|PROT_EXEC));
    assert(!memcmp(code,original,sizeof original));
    code[9]=0xd2800160;assert(call(code)==11);
    assert(undefined==(baseline?4:0));
    printf("PASS original mutable cache sequence result=11 EL0_exceptions=%d\n",undefined);
    assert(!munmap(reservation,span));return 0;
}
