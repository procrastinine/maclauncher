#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#ifdef LIBRARY
__asm__(".text\n.global published_tls\n.type published_tls,%function\n"
        ".p2align 4\npublished_tls:\nmov x0,#7\nret\n"
        ".size published_tls,.-published_tls\n");
#else
static uintptr_t tls(void) { uintptr_t value; __asm__("mrs %0,tpidr_el0":"=r"(value)); return value; }
int main(int argc,char **argv) {
    if(argc!=3)return 1;
    void *library=dlopen(argv[1],RTLD_NOW);if(!library){fprintf(stderr,"%s\n",dlerror());return 2;}
    uintptr_t (*entry)(void)=dlsym(library,"published_tls");if(!entry)return 3;
    size_t page=(size_t)sysconf(_SC_PAGESIZE);
    void *base=(void *)((uintptr_t)entry&~(page-1));
    int writable=PROT_READ|PROT_WRITE|(strcmp(argv[2],"rwx")==0?PROT_EXEC:0);
    if(mprotect(base,page,writable)){perror("writable");return 4;}
    uint32_t code[]={0xd53bd040,0xd65f03c0};
    memcpy((void *)entry,code,sizeof code);__builtin___clear_cache((char *)entry,(char *)entry+sizeof code);
    if(mprotect(base,page,PROT_READ|PROT_EXEC)){perror("executable");return 5;}
    uintptr_t actual=entry(),expected=tls();
    printf("code publication %s actual=%#lx expected=%#lx\n",argv[2],(unsigned long)actual,(unsigned long)expected);
    if(actual!=expected)return 21;
    puts("PASS original Bionic modified ELF code reads guest TLS");return 0;
}
#endif
