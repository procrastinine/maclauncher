#include "process-memory.h"
#include "process-ids.h"
#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
int main(int argc,char **argv){
    assert(argc==2&&klj_process_ids_configure(argv[1])>0);assert(!klj_process_publish_principal(10023));pid_t self=klj_process_id();
    char source[]="abcdefgh",output[12]={0};
    struct iovec local[]={{output,3},{output+3,5}},remote[]={{source,2},{source+2,6}};
    assert(klj_process_vm_readv(self,local,2,remote,2,0)==8&&!memcmp(output,"abcdefgh",8));
    char replacement[]="12345";struct iovec input[]={{replacement,2},{replacement+2,3}},target[]={{output,1},{output+1,4}};
    assert(klj_process_vm_writev(self,input,2,target,2,0)==5&&!memcmp(output,"12345fgh",8));
    struct iovec empty[]={{NULL,0},{output,3}};assert(klj_process_vm_readv(self,empty,2,remote,2,0)==3&&!memcmp(output,"abc",3));
    errno=0;assert(klj_process_vm_readv(self,NULL,0,NULL,0,0)==0);assert(klj_process_vm_readv(-1,NULL,0,NULL,0,0)==0);
    errno=0;assert(klj_process_vm_readv(self,local,1025,remote,2,0)==-1&&errno==EINVAL);
    errno=0;assert(klj_process_vm_readv(self,local,2,remote,2,1)==-1&&errno==EINVAL);
    struct iovec overflow[]={{source,(size_t)SSIZE_MAX},{source,1}};errno=0;assert(klj_process_vm_readv(self,overflow,2,remote,2,0)==-1&&errno==EINVAL);
    errno=0;assert(klj_process_vm_readv(self,(void *)1,1,remote,2,0)==-1&&errno==EFAULT);
    errno=0;assert(klj_process_vm_readv(999999,local,2,remote,2,0)==-1&&errno==ESRCH);
    size_t page=(size_t)sysconf(_SC_PAGESIZE);char *memory=mmap(NULL,page,PROT_READ|PROT_WRITE,MAP_ANON|MAP_PRIVATE,-1,0);assert(memory!=MAP_FAILED);memcpy(memory,"kernel",6);
    struct iovec readable={memory,6},destination={output,6};assert(klj_process_vm_readv(self,&destination,1,&readable,1,0)==6&&!memcmp(output,"kernel",6));
    assert(!mprotect(memory,page,PROT_NONE));errno=0;assert(klj_process_vm_readv(self,&destination,1,&readable,1,0)==-1&&errno==EFAULT);
    struct iovec split[]={{source,2},{memory,6}};memset(output,0,sizeof output);assert(klj_process_vm_readv(self,&destination,1,split,2,0)==2&&!memcmp(output,"ab",2));
    assert(!mprotect(memory,page,PROT_READ));errno=0;assert(klj_process_vm_writev(self,input,2,&readable,1,0)==-1&&errno==EFAULT);
    assert(!munmap(memory,page));
    puts("PASS original process_vm vector order, empty/overflow/flags, fault-safe read/write, partial completion and logical identity");
}
