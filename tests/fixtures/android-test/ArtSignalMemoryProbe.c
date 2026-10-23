#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

static long mask(int how,const void *set,void *old,size_t size){
    return syscall(__NR_rt_sigprocmask,how,set,old,size);
}
#define CHECK(expression) do{if(!(expression)){fprintf(stderr,"signal user-copy fixture line %d errno %d\n",__LINE__,errno);return __LINE__;}}while(0)
int main(void){
    uint64_t original=0,selected=1ULL<<9,observed=0;
    CHECK(mask(2,&selected,&original,8)==0);
    errno=0;CHECK(mask(2,(void *)0x6359c40,0,8)==-1&&errno==EFAULT);
    CHECK(mask(0,0,&observed,8)==0&&observed==selected);
    errno=0;CHECK(mask(2,(void *)1,(void *)1,7)==-1&&errno==EINVAL);
    unsigned char unaligned[9];memcpy(unaligned+1,&selected,8);
    CHECK(mask(2,unaligned+1,0,8)==0);
    size_t page=(size_t)sysconf(_SC_PAGESIZE);
    unsigned char *memory=mmap(0,page*2,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    CHECK(memory!=MAP_FAILED);
    CHECK(mprotect(memory+page,page,PROT_NONE)==0);
    errno=0;CHECK(mask(2,memory+page-4,0,8)==-1&&errno==EFAULT);
    CHECK(mprotect(memory,page,PROT_READ)==0);
    errno=0;CHECK(mask(0,0,memory,8)==-1&&errno==EFAULT);
    selected=1ULL<<11;
    errno=0;CHECK(mask(2,&selected,(void *)1,8)==-1&&errno==EFAULT);
    CHECK(mask(0,0,&observed,8)==0&&observed==selected);
    CHECK(mask(2,&original,0,8)==0);
    CHECK(munmap(memory,page*2)==0);
    puts("PASS original Linux signal masks retain valid semantics and contain invalid user pointers");
    return 0;
}
