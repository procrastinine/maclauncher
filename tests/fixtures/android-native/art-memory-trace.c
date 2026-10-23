#include <inttypes.h>
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

__attribute__((noinline)) static long observed_munmap(void *address,size_t length,uintptr_t *pc,uintptr_t *lr,uintptr_t *fp) {
    register uint64_t x0 __asm__("x0")=(uintptr_t)address,x1 __asm__("x1")=length,x8 __asm__("x8")=__NR_munmap;
    uintptr_t site,caller,frame;
    __asm__ volatile("adr %3,1f\nmov %4,x30\nmov %5,x29\n1: svc #0"
        : "+r"(x0),"+r"(x1),"+r"(x8),"=&r"(site),"=&r"(caller),"=&r"(frame) : : "memory","cc");
    *pc=site;*lr=caller;*fp=frame;return (long)x0;
}

__attribute__((naked,noinline)) static long framed_munmap(void* address __attribute__((unused)),size_t length __attribute__((unused)),uintptr_t frame __attribute__((unused)),uintptr_t* metadata __attribute__((unused))) {
    __asm__ volatile("stp x29,x30,[sp,#-16]!\nadr x9,1f\nstp x9,x30,[x3]\nstr x2,[x3,#16]\nmov x29,x2\nmov x8,#215\n1: svc #0\nldp x29,x30,[sp],#16\nret");
}

static void frame_chains(size_t page) {
    _Alignas(16) uintptr_t frames[10][2];
    for(unsigned i=0;i<10;i++){frames[i][0]=i==9?0:(uintptr_t)&frames[i+1];frames[i][1]=0x1110+i*0x10;}
    uintptr_t cycle[2] __attribute__((aligned(16)))={(uintptr_t)cycle,0xabc0};
    void* protected=mmap(NULL,page,PROT_NONE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(protected!=MAP_FAILED);
    void* gap=mmap(NULL,page*3,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(gap!=MAP_FAILED);
    void* unmapped=(char*)gap+page;assert(!munmap(unmapped,page));
    const char* names[]={"valid","cycle","misaligned","protected","unmapped"};
    uintptr_t pointers[]={(uintptr_t)frames,(uintptr_t)cycle,(uintptr_t)frames+8,(uintptr_t)protected,(uintptr_t)unmapped};
    for(unsigned i=0;i<5;i++){
        size_t size=page*(i+2);void* memory=mmap(NULL,size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(memory!=MAP_FAILED);
        uintptr_t metadata[3];errno=EDOM;assert(!framed_munmap(memory,size,pointers[i],metadata));assert(errno==EDOM);
        printf("TRACE_CHAIN kind=%s address=%#"PRIxPTR" length=%#zx pc=%#"PRIxPTR" lr=%#"PRIxPTR" fp=%#"PRIxPTR"\n",names[i],(uintptr_t)memory,size,metadata[0],metadata[1],metadata[2]);
    }
    assert(!munmap(protected,page)&&!munmap(gap,page*3));
}

int main(void) {
    size_t length = (size_t)sysconf(_SC_PAGESIZE) * 9;
    volatile uint32_t *memory = mmap(NULL, length, PROT_READ | PROT_WRITE,
                                   MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (memory == MAP_FAILED) { perror("mmap"); return 1; }
    memory[0] = 0x12345678;
    if (mprotect((void *)memory, length, PROT_READ)) { perror("mprotect read"); return 2; }
    if (memory[0] != 0x12345678) return 3;
    if (mprotect((void *)memory, length, PROT_READ | PROT_WRITE)) { perror("mprotect write"); return 4; }
    memory[0] = 0x87654321;
    if (memory[0] != 0x87654321) return 5;
    uintptr_t address = (uintptr_t)memory;
    uintptr_t pc,lr,fp;
    if (observed_munmap((void *)memory,length,&pc,&lr,&fp)) { perror("munmap"); return 6; }
    printf("PASS original Bionic memory protection address=%#" PRIxPTR " length=%#zx\n", address, length);
    printf("TRACE_CALLER pc=%#" PRIxPTR " lr=%#" PRIxPTR " fp=%#" PRIxPTR "\n",pc,lr,fp);
    frame_chains((size_t)sysconf(_SC_PAGESIZE));
    return 0;
}
